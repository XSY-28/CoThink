import { DISCUSSION_POLICY_VERSION } from "./contracts.js";
import type { AgentId, AgentWeights, Complexity, DiscussionPolicy, Effort } from "./contracts.js";

const effortDefaults = {
  low: {
    roundLimits: { simple: 1, moderate: 1, complex: 2 },
    discussionTokenPool: 6_144,
    maxAllocatedOutputTokens: 65_536,
    maxDurationMs: 180_000,
    callTimeoutMs: 45_000
  },
  standard: {
    roundLimits: { simple: 2, moderate: 3, complex: 4 },
    discussionTokenPool: 8_192,
    maxAllocatedOutputTokens: 163_840,
    maxDurationMs: 480_000,
    callTimeoutMs: 60_000
  },
  high: {
    roundLimits: { simple: 3, moderate: 5, complex: 6 },
    discussionTokenPool: 12_288,
    maxAllocatedOutputTokens: 262_144,
    maxDurationMs: 900_000,
    callTimeoutMs: 90_000
  }
} as const;

const policyFields = [
  "policyVersion",
  "effort",
  "weights",
  "roundingOrder",
  "maxRounds",
  "maxCalls",
  "maxAllocatedOutputTokens",
  "maxDurationMs",
  "callTimeoutMs"
] as const;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error(`${label} contains an unknown field: ${String(key)}`);
    }
  }
}

function requireFullRoster(value: Record<string, unknown>, memberIds: readonly AgentId[], label: string): void {
  requireKnownKeys(value, memberIds, label);
  if (memberIds.some((id) => !Object.hasOwn(value, id))) {
    throw new Error(`${label} must include every discussion member`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function parseEffort(value: unknown): Effort {
  if (value !== "low" && value !== "standard" && value !== "high") {
    throw new Error("effort must be low, standard, or high");
  }
  return value;
}

function parseWeight(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 100) {
    throw new Error(`${label} must be finite and between 0.1 and 100`);
  }
  return value;
}

/** Validate a roster without choosing or removing members. */
export function validateDiscussionMemberIds(memberIds: readonly AgentId[]): void {
  if (!Array.isArray(memberIds) || memberIds.length < 2) {
    throw new Error("Discussion requires at least two members");
  }
  if ([...memberIds].some((id) => typeof id !== "string" || id.trim().length === 0)) {
    throw new Error("Discussion member IDs must be nonempty strings");
  }
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error("Discussion member IDs must be unique");
  }
}

/** Harness defaults; effort is never translated to a provider reasoning parameter. */
export function discussionEffortDefaults(effort: Effort, memberCount: number) {
  const defaults = effortDefaults[parseEffort(effort)];
  if (positiveInteger(memberCount, "memberCount") < 2) {
    throw new Error("Discussion requires at least two members");
  }
  const scale = memberCount / 2;
  return Object.freeze({
    roundLimits: Object.freeze({ ...defaults.roundLimits }),
    discussionTokenPool: positiveInteger(defaults.discussionTokenPool * scale, "discussionTokenPool"),
    maxCalls: positiveInteger(memberCount * (1 + 2 * defaults.roundLimits.complex), "maxCalls"),
    maxAllocatedOutputTokens: positiveInteger(defaults.maxAllocatedOutputTokens * scale, "maxAllocatedOutputTokens"),
    maxDurationMs: defaults.maxDurationMs,
    callTimeoutMs: defaults.callTimeoutMs
  });
}

/** An omitted weights table means all ones. An explicit table must cover the roster;
 * an omitted individual participation/decision value still defaults to one.
 * Explicit resource limits may only tighten the effort's frozen hard caps.
 */
export function normalizeDiscussionPolicy(raw: unknown, memberIds: readonly AgentId[]): DiscussionPolicy {
  validateDiscussionMemberIds(memberIds);
  const input = requireRecord(raw, "Discussion policy");
  requireKnownKeys(input, policyFields, "Discussion policy");
  if (Object.hasOwn(input, "policyVersion") && input.policyVersion !== DISCUSSION_POLICY_VERSION) {
    throw new Error("Unsupported discussion policy version");
  }
  const effort = Object.hasOwn(input, "effort") ? parseEffort(input.effort) : "standard";
  const defaults = discussionEffortDefaults(effort, memberIds.length);
  const explicitWeights = Object.hasOwn(input, "weights") ? requireRecord(input.weights, "weights") : undefined;
  if (explicitWeights) requireFullRoster(explicitWeights, memberIds, "weights");
  const weights: Readonly<Record<AgentId, AgentWeights>> = Object.freeze(
    Object.fromEntries(
      memberIds.map((id) => {
        const entry = explicitWeights ? requireRecord(explicitWeights[id], `weights.${id}`) : {};
        requireKnownKeys(entry, ["participationWeight", "decisionWeight"], `weights.${id}`);
        return [
          id,
          Object.freeze({
            participationWeight: Object.hasOwn(entry, "participationWeight")
              ? parseWeight(entry.participationWeight, `weights.${id}.participationWeight`)
              : 1,
            decisionWeight: Object.hasOwn(entry, "decisionWeight")
              ? parseWeight(entry.decisionWeight, `weights.${id}.decisionWeight`)
              : 1
          })
        ];
      })
    )
  );

  const order: unknown = Object.hasOwn(input, "roundingOrder") ? input.roundingOrder : memberIds;
  if (
    !Array.isArray(order) ||
    order.length !== memberIds.length ||
    new Set(order).size !== memberIds.length ||
    [...order].some((id: unknown) => typeof id !== "string" || !memberIds.includes(id))
  ) {
    throw new Error("roundingOrder must be a complete permutation of the member roster");
  }
  const capped = (key: "maxCalls" | "maxAllocatedOutputTokens" | "maxDurationMs" | "callTimeoutMs"): number => {
    const value = Object.hasOwn(input, key) ? positiveInteger(input[key], key) : defaults[key];
    if (value > defaults[key]) throw new Error(`${key} cannot exceed the effort's hard cap`);
    return value;
  };
  const maxDurationMs = capped("maxDurationMs");
  const callTimeoutMs = capped("callTimeoutMs");
  if (callTimeoutMs > maxDurationMs) {
    throw new Error("callTimeoutMs cannot exceed maxDurationMs");
  }
  return Object.freeze({
    policyVersion: DISCUSSION_POLICY_VERSION,
    effort,
    weights,
    roundingOrder: Object.freeze([...order] as AgentId[]),
    ...(Object.hasOwn(input, "maxRounds") ? { maxRounds: positiveInteger(input.maxRounds, "maxRounds") } : {}),
    maxCalls: capped("maxCalls"),
    maxAllocatedOutputTokens: capped("maxAllocatedOutputTokens"),
    maxDurationMs,
    callTimeoutMs
  });
}

/** Resolve independent opening estimates with no extra model calls. */
export function resolveRoundLimit(policy: DiscussionPolicy, complexities: Record<AgentId, Complexity>): number {
  const memberIds = policy.roundingOrder;
  const estimates = requireRecord(complexities, "complexities");
  requireFullRoster(estimates, memberIds, "complexities");
  const limits = discussionEffortDefaults(policy.effort, memberIds.length).roundLimits;
  let suggested = 0;
  for (const id of memberIds) {
    const complexity = estimates[id];
    if (complexity !== "simple" && complexity !== "moderate" && complexity !== "complex") {
      throw new Error(`Invalid complexity estimate for ${id}`);
    }
    suggested = Math.max(suggested, limits[complexity]);
  }
  return Math.min(suggested, policy.maxRounds ?? suggested);
}
