import { describe, expect, test } from "vitest";
import {
  discussionEffortDefaults,
  normalizeDiscussionPolicy,
  resolveRoundLimit,
  validateDiscussionMemberIds
} from "../../src/discussion/policy.js";
import type { Complexity, Effort } from "../../src/discussion/contracts.js";

const ids = ["member-a", "member-b"];

describe("discussion policy normalization", () => {
  test.each([
    ["low", 10, 65_536, 180_000, 45_000, 6_144],
    ["standard", 18, 163_840, 480_000, 60_000, 8_192],
    ["high", 26, 262_144, 900_000, 90_000, 12_288]
  ] as const)("%s freezes the documented harness caps", (effort, calls, output, duration, timeout, pool) => {
    const policy = normalizeDiscussionPolicy({ effort }, ids);
    expect(policy).toEqual({
      policyVersion: "discussion-policy-v1",
      effort,
      weights: {
        "member-a": { participationWeight: 1, decisionWeight: 1 },
        "member-b": { participationWeight: 1, decisionWeight: 1 }
      },
      roundingOrder: ids,
      maxCalls: calls,
      maxAllocatedOutputTokens: output,
      maxDurationMs: duration,
      callTimeoutMs: timeout
    });
    expect(discussionEffortDefaults(effort, 2).discussionTokenPool).toBe(pool);
  });

  test("omitted effort defaults to standard", () => {
    expect(normalizeDiscussionPolicy({}, ids)).toEqual(normalizeDiscussionPolicy({ effort: "standard" }, ids));
  });

  test.each(["low", "standard", "high"] as const)(
    "%s scales resources for three members and preserves the whole roster",
    (effort) => {
      const pair = normalizeDiscussionPolicy({ effort }, ids);
      const triple = normalizeDiscussionPolicy({ effort }, [...ids, "member-c"]);
      expect(triple.maxCalls).toBe(pair.maxCalls * 1.5);
      expect(triple.maxAllocatedOutputTokens).toBe(pair.maxAllocatedOutputTokens * 1.5);
      expect(triple.maxDurationMs).toBe(pair.maxDurationMs);
      expect(triple.callTimeoutMs).toBe(pair.callTimeoutMs);
      expect(Object.keys(triple.weights)).toEqual([...ids, "member-c"]);
      expect(discussionEffortDefaults(effort, 3).discussionTokenPool).toBe(
        discussionEffortDefaults(effort, 2).discussionTokenPool * 1.5
      );
    }
  );

  test("roster order cannot change total caps", () => {
    const forward = normalizeDiscussionPolicy({}, ids);
    const reverse = normalizeDiscussionPolicy({}, [...ids].reverse());
    expect(reverse.maxCalls).toBe(forward.maxCalls);
    expect(reverse.maxAllocatedOutputTokens).toBe(forward.maxAllocatedOutputTokens);
    expect(reverse.weights).toEqual(forward.weights);
    expect(reverse.roundingOrder).toEqual([...ids].reverse());
  });

  test("participation and decision preferences stay independent; missing individual values default to one", () => {
    const policy = normalizeDiscussionPolicy(
      {
        weights: { "member-a": { participationWeight: 2 }, "member-b": { decisionWeight: 3 } }
      },
      ids
    );
    expect(policy.weights).toEqual({
      "member-a": { participationWeight: 2, decisionWeight: 1 },
      "member-b": { participationWeight: 1, decisionWeight: 3 }
    });
  });

  test("copies and deeply freezes user policy without modifying input", () => {
    const raw = {
      weights: {
        "member-a": { participationWeight: 2, decisionWeight: 1 },
        "member-b": { participationWeight: 1, decisionWeight: 2 }
      },
      roundingOrder: [...ids].reverse()
    };
    const snapshot = structuredClone(raw);
    const policy = normalizeDiscussionPolicy(raw, ids);
    expect(raw).toEqual(snapshot);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.weights)).toBe(true);
    expect(Object.isFrozen(policy.weights["member-a"])).toBe(true);
    expect(Object.isFrozen(policy.roundingOrder)).toBe(true);
    raw.weights["member-a"].participationWeight = 8;
    raw.roundingOrder.reverse();
    expect(policy.weights["member-a"]?.participationWeight).toBe(2);
    expect(policy.roundingOrder).toEqual([...ids].reverse());
    expect(normalizeDiscussionPolicy(policy, ids)).toEqual(policy);
  });

  test("allows arbitrary member names safely, including prototype property names", () => {
    const names = ["__proto__", "constructor", "toString"];
    const weights = Object.fromEntries(names.map((id) => [id, { participationWeight: 2 }]));
    const policy = normalizeDiscussionPolicy({ weights }, names);
    expect(Object.keys(policy.weights)).toEqual(names);
    expect(Object.hasOwn(policy.weights, "__proto__")).toBe(true);
    expect(policy.weights.__proto__?.participationWeight).toBe(2);
    expect(resolveRoundLimit(policy, Object.fromEntries(names.map((id) => [id, "moderate"])))).toBe(3);
  });

  test("explicit caps can only tighten defaults without changing default maximum round costs", () => {
    const policy = normalizeDiscussionPolicy(
      {
        maxRounds: 100,
        maxCalls: 12,
        maxAllocatedOutputTokens: 10_000,
        maxDurationMs: 50_000,
        callTimeoutMs: 20_000,
        roundingOrder: [...ids].reverse()
      },
      ids
    );
    expect(policy.maxCalls).toBe(12);
    expect(policy.maxAllocatedOutputTokens).toBe(10_000);
    expect(policy.maxDurationMs).toBe(50_000);
    expect(policy.callTimeoutMs).toBe(20_000);
    expect(resolveRoundLimit(policy, { "member-a": "complex", "member-b": "complex" })).toBe(4);
  });

  test.each([0, -1, 0.09, 100.01, Infinity, NaN, "1", null])("rejects invalid weight %s", (weight) => {
    for (const field of ["participationWeight", "decisionWeight"]) {
      expect(() =>
        normalizeDiscussionPolicy(
          {
            weights: { "member-a": { [field]: weight }, "member-b": {} }
          },
          ids
        )
      ).toThrow();
    }
  });

  test.each([0.1, 100])("accepts inclusive weight boundary %s", (weight) => {
    const policy = normalizeDiscussionPolicy(
      {
        weights: { "member-a": { participationWeight: weight, decisionWeight: weight }, "member-b": {} }
      },
      ids
    );
    expect(policy.weights["member-a"]?.participationWeight).toBe(weight);
  });

  test.each([
    { weights: {} },
    { weights: { "member-a": {} } },
    { weights: { "member-a": {}, "member-b": {}, stranger: {} } },
    { weights: { "member-a": { weight: 1 }, "member-b": {} } },
    { weights: { "member-a": null, "member-b": {} } },
    { weights: undefined },
    { reasoning: "high" },
    { effort: "highest" },
    { policyVersion: "discussion-policy-v2" },
    { maxCalls: 19 },
    { maxAllocatedOutputTokens: 163_841 },
    { maxDurationMs: 480_001 },
    { callTimeoutMs: 60_001 },
    { maxDurationMs: 30_000 },
    { roundingOrder: ["member-a"] },
    { roundingOrder: ["member-a", "member-a"] },
    { roundingOrder: ["member-a", "stranger"] },
    null,
    [],
    "standard"
  ])("rejects malformed or expanding policy %#", (raw) => {
    expect(() => normalizeDiscussionPolicy(raw, ids)).toThrow();
  });

  test.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2"])(
    "requires positive safe integer cap %s",
    (cap) => {
      for (const key of ["maxRounds", "maxCalls", "maxAllocatedOutputTokens", "maxDurationMs", "callTimeoutMs"]) {
        expect(() => normalizeDiscussionPolicy({ [key]: cap }, ids)).toThrow();
      }
    }
  );

  test.each([[], ["a"], ["a", "a"], ["a", ""], ["a", "  "]].map((roster) => ({ roster })))(
    "rejects invalid member roster %#",
    ({ roster }) => {
      expect(() => normalizeDiscussionPolicy({}, roster)).toThrow();
      expect(() => validateDiscussionMemberIds(roster)).toThrow();
    }
  );

  test("rejects sparse rosters and sparse rounding orders", () => {
    const sparse = new Array<string>(2);
    sparse[1] = "member-b";
    expect(() => validateDiscussionMemberIds(sparse)).toThrow();
    expect(() => normalizeDiscussionPolicy({}, sparse)).toThrow();
    expect(() => normalizeDiscussionPolicy({ roundingOrder: sparse }, ids)).toThrow();
  });

  test.each([1, 0, -2, 2.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects invalid default member count %s",
    (count) => {
      expect(() => discussionEffortDefaults("standard", count)).toThrow();
    }
  );
});

describe("round limit resolution", () => {
  test.each([
    ["low", "simple", 1],
    ["low", "moderate", 1],
    ["low", "complex", 2],
    ["standard", "simple", 2],
    ["standard", "moderate", 3],
    ["standard", "complex", 4],
    ["high", "simple", 3],
    ["high", "moderate", 5],
    ["high", "complex", 6]
  ] satisfies [Effort, Complexity, number][])("%s uses the highest member estimate %s", (effort, complexity, limit) => {
    const policy = normalizeDiscussionPolicy({ effort }, [...ids, "member-c"]);
    expect(resolveRoundLimit(policy, { "member-a": "simple", "member-b": complexity, "member-c": "simple" })).toBe(
      limit
    );
  });

  test("explicit round limit only tightens the complexity recommendation", () => {
    const policy = normalizeDiscussionPolicy({ effort: "standard", maxRounds: 2 }, ids);
    expect(resolveRoundLimit(policy, { "member-a": "simple", "member-b": "complex" })).toBe(2);
    expect(policy.maxCalls).toBe(18);
  });

  test.each([
    {},
    { "member-a": "simple" },
    { "member-a": "simple", "member-b": "complex", stranger: "simple" },
    { "member-a": "simple", "member-b": "unknown" }
  ])("rejects incomplete, unknown, or invalid complexity estimates %#", (complexities) => {
    const policy = normalizeDiscussionPolicy({}, ids);
    expect(() => resolveRoundLimit(policy, complexities as Record<string, Complexity>)).toThrow();
  });
});
