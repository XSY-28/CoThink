import { readFile } from "node:fs/promises";
import { PeerMemberConfigSchema, type MemberId, type PeerMemberConfig } from "@onevcat/argue";
import { z } from "zod";

const ProtocolSchema = z.enum(["openai-compatible", "anthropic-compatible"]);
const ProfileNameSchema = z.enum(["openai-compatible", "anthropic-compatible", "deepseek", "glm"]);
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Invalid environment variable name");
const BaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!/^https?:\/\//iu.test(value) || /[\s\\]/u.test(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password && !/^https?:\/\/[^/?#]*@/iu.test(value);
  }, "baseUrl must be an HTTP(S) URL without embedded credentials");
const InputMemberSchema = z
  .object({
    profile: ProfileNameSchema.optional(),
    protocol: ProtocolSchema.optional(),
    baseUrl: BaseUrlSchema.optional(),
    modelId: z.string().trim().min(1).optional(),
    modelEnv: EnvironmentNameSchema.optional(),
    apiKeyEnv: EnvironmentNameSchema.optional(),
    outputMode: z.enum(["json_object", "prompt_json"]).optional(),
    generationOptions: z.record(z.unknown()).optional(),
    maxInputCharacters: z.number().int().positive().optional()
  })
  .strict();
const InputSchema = z
  .object({
    members: z.object({ "member-a": InputMemberSchema, "member-b": InputMemberSchema }).strict()
  })
  .strict();

interface PeerProfileDefaults {
  readonly protocol: z.infer<typeof ProtocolSchema>;
  readonly outputMode: PeerMemberConfig["outputMode"];
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly modelEnv?: string;
  readonly apiKeyEnv?: string;
  readonly generationOptions: Readonly<Record<string, unknown>>;
}

/** Presets are opt-in; generic adapters have no provider endpoint, model, or tuning defaults. */
export const peerProfiles = {
  "openai-compatible": {
    protocol: "openai-compatible",
    outputMode: "json_object",
    generationOptions: {}
  },
  "anthropic-compatible": {
    protocol: "anthropic-compatible",
    outputMode: "prompt_json",
    generationOptions: {}
  },
  deepseek: {
    protocol: "openai-compatible",
    outputMode: "json_object",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-flash",
    modelEnv: "DEEPSEEK_MODEL_ID",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    generationOptions: { thinking: { type: "disabled" } }
  },
  glm: {
    protocol: "openai-compatible",
    outputMode: "json_object",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelId: "glm-5.3-flash",
    modelEnv: "GLM_MODEL_ID",
    apiKeyEnv: "GLM_API_KEY",
    generationOptions: { thinking: { type: "enabled" }, reasoning_effort: "low" }
  }
} as const satisfies Record<z.infer<typeof ProfileNameSchema>, PeerProfileDefaults>;

/** Resolve every profile default before the core freezes config and calculates inputHash. */
export function normalizePeerMembers(
  input: unknown,
  env: Record<string, string | undefined> = process.env
): Record<MemberId, PeerMemberConfig> {
  const raw = InputSchema.parse(input);
  const normalize = (memberId: MemberId): PeerMemberConfig => {
    const member = raw.members[memberId];
    const profileName = member.profile ?? member.protocol ?? "openai-compatible";
    const profile: PeerProfileDefaults = peerProfiles[profileName];
    if (member.protocol && member.protocol !== profile.protocol)
      throw new Error(`${memberId} profile ${profileName} conflicts with protocol ${member.protocol}`);
    const modelEnv = member.modelEnv ?? profile.modelEnv;
    const fromEnv = (modelEnv ? env[modelEnv]?.trim() : undefined) || undefined;
    if (member.modelEnv && !fromEnv && !member.modelId)
      throw new Error(`Model environment variable ${modelEnv} is not set`);
    const modelId = member.modelEnv
      ? (fromEnv ?? member.modelId ?? profile.modelId)
      : (member.modelId ?? fromEnv ?? profile.modelId);
    const baseUrl = member.baseUrl ?? profile.baseUrl;
    if (!baseUrl) throw new Error(`${memberId} requires an explicit baseUrl for profile ${profileName}`);
    if (!modelId) throw new Error(`${memberId} requires an explicit modelId or configured modelEnv`);
    const outputMode = member.outputMode ?? profile.outputMode;
    if (profile.protocol === "anthropic-compatible" && outputMode !== "prompt_json")
      throw new Error("Anthropic-compatible protocol requires prompt_json outputMode");
    const generationOptions = { ...profile.generationOptions, ...member.generationOptions };
    if (profileName === "glm" && JSON.stringify(generationOptions.thinking) !== JSON.stringify({ type: "enabled" }))
      throw new Error("GLM profile requires thinking enabled");
    return PeerMemberConfigSchema.parse({
      id: memberId,
      protocol: profile.protocol,
      baseUrl,
      modelId,
      apiKeyEnv:
        member.apiKeyEnv ?? profile.apiKeyEnv ?? (memberId === "member-a" ? "PEER_A_API_KEY" : "PEER_B_API_KEY"),
      outputMode,
      generationOptions,
      ...(member.maxInputCharacters ? { maxInputCharacters: member.maxInputCharacters } : {})
    });
  };
  return { "member-a": normalize("member-a"), "member-b": normalize("member-b") };
}

export async function loadPeerMembers(
  filePath: string,
  env: Record<string, string | undefined> = process.env
): Promise<Record<MemberId, PeerMemberConfig>> {
  return normalizePeerMembers(JSON.parse(await readFile(filePath, "utf8")), env);
}
