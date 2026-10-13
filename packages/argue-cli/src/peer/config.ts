import { readFile } from "node:fs/promises";
import { PeerMemberConfigSchema, type MemberId, type PeerMemberConfig } from "@onevcat/argue";
import { z } from "zod";

const ProfileNameSchema = z.enum(["deepseek", "glm"]);
type ProfileName = z.infer<typeof ProfileNameSchema>;
const InputMemberSchema = z
  .object({
    profile: ProfileNameSchema.optional(),
    baseUrl: z.string().url().optional(),
    modelId: z.string().min(1).optional(),
    modelEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
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

const profiles = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-flash",
    modelEnv: "DEEPSEEK_MODEL_ID",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    generationOptions: { thinking: { type: "disabled" } }
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelId: "glm-5.3-flash",
    modelEnv: "GLM_MODEL_ID",
    apiKeyEnv: "GLM_API_KEY",
    generationOptions: { thinking: { type: "enabled" } }
  }
} as const;

/** Resolve every profile default before the core freezes config and calculates inputHash. */
export function normalizePeerMembers(
  input: unknown,
  env: Record<string, string | undefined> = process.env
): Record<MemberId, PeerMemberConfig> {
  const raw = InputSchema.parse(input);
  const normalize = (memberId: MemberId): PeerMemberConfig => {
    const member = raw.members[memberId];
    const profileName: ProfileName = member.profile ?? (memberId === "member-a" ? "deepseek" : "glm");
    const profile = profiles[profileName];
    const modelEnv = member.modelEnv ?? profile.modelEnv;
    const fromEnv = env[modelEnv]?.trim();
    if (member.modelEnv && !fromEnv && !member.modelId)
      throw new Error(`Model environment variable ${modelEnv} is not set`);
    const generationOptions = { ...profile.generationOptions, ...member.generationOptions };
    if (profileName === "glm" && JSON.stringify(generationOptions.thinking) !== JSON.stringify({ type: "enabled" }))
      throw new Error("GLM profile requires thinking enabled");
    return PeerMemberConfigSchema.parse({
      id: memberId,
      protocol: "openai-compatible",
      baseUrl: member.baseUrl ?? profile.baseUrl,
      modelId: member.modelEnv
        ? (fromEnv ?? member.modelId ?? profile.modelId)
        : (member.modelId ?? fromEnv ?? profile.modelId),
      apiKeyEnv: member.apiKeyEnv ?? profile.apiKeyEnv,
      outputMode: member.outputMode ?? "json_object",
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
