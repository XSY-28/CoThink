import { readFile } from "node:fs/promises";
import { normalizeDiscussionPolicy, type DiscussionPolicy, type MemberId, type PeerMemberConfig } from "@onevcat/argue";
import { normalizePeerMembers } from "../peer/config.js";

const limits = ["maxRounds", "maxCalls", "maxAllocatedOutputTokens", "maxDurationMs", "callTimeoutMs"] as const;

/** Keep omitted resource caps omitted so a CLI effort override derives fresh defaults. */
export type DiscussionConfigPolicy = Pick<DiscussionPolicy, "effort" | "weights"> &
  Partial<Pick<DiscussionPolicy, (typeof limits)[number]>>;

export interface DiscussionConfig {
  configVersion: 2;
  members: Record<MemberId, PeerMemberConfig>;
  discussion: DiscussionConfigPolicy;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid configuration");
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)))
    throw new Error("Invalid configuration");
}

export function parseDiscussionConfig(raw: unknown, env: Record<string, string | undefined> = {}): DiscussionConfig {
  try {
    const input = record(raw);
    const version = Object.hasOwn(input, "configVersion") ? input.configVersion : 1;
    if (version !== 1 && version !== 2) throw new Error("Invalid configuration");
    knownFields(input, version === 2 ? ["configVersion", "members", "discussion"] : ["configVersion", "members"]);
    const members = normalizePeerMembers({ members: input.members }, env);
    const discussion = Object.hasOwn(input, "discussion") ? record(input.discussion) : {};
    knownFields(discussion, ["effort", "weights", ...limits]);
    const normalized = normalizeDiscussionPolicy(discussion, Object.keys(members));
    return {
      configVersion: 2,
      members,
      discussion: {
        effort: normalized.effort,
        weights: normalized.weights,
        ...Object.fromEntries(
          limits.filter((key) => Object.hasOwn(discussion, key)).map((key) => [key, normalized[key]])
        )
      }
    };
  } catch {
    throw new Error("Invalid CoThink configuration");
  }
}

export async function loadDiscussionConfig(
  path: string,
  env: Record<string, string | undefined> = {}
): Promise<DiscussionConfig> {
  try {
    return parseDiscussionConfig(JSON.parse(await readFile(path, "utf8")), env);
  } catch {
    throw new Error("Cannot load CoThink configuration");
  }
}
