import { freezeBuildValue, type BuildModelProfile, type BuildPlan } from "@onevcat/argue";
import { parseDiscussionConfig } from "../discussion/config.js";
import { validateModelCall } from "../runtime/model-api.js";

/** Reuse member presets only; discussion weights and caps never grant construction permission. */
export function parseBuildConfig(
  raw: unknown,
  plan: BuildPlan,
  env: Record<string, string | undefined> = {}
): Readonly<Record<string, BuildModelProfile>> {
  try {
    if (typeof raw !== "object" || raw === null || !("configVersion" in raw) || raw.configVersion !== 2)
      throw Error("version");
    const { members } = parseDiscussionConfig(raw, env);
    if (Object.keys(members).sort().join(",") !== [...plan.memberIds].sort().join(",")) throw Error("members");
    const profiles: Record<string, BuildModelProfile> = Object.fromEntries(
      Object.entries(members).map(([id, member]) => {
        const { id: _id, maxInputCharacters: _input, ...profile } = member;
        void _id;
        void _input;
        validateModelCall({ ...profile, messages: [], maxOutputTokens: plan.budget.maxOutputTokensPerCall });
        return [id, profile];
      })
    );
    // Runtime freezing does not change the transport's existing mutable JSON value type.
    freezeBuildValue(profiles);
    return profiles;
  } catch {
    throw Error("BUILD_CONFIG_INVALID");
  }
}
