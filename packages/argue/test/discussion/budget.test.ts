import { expect, it } from "vitest";
import { normalizeDiscussionPolicy } from "../../src/discussion/policy.js";
import {
  allocateDiscussionTokens,
  allocateRoundTokens,
  allocateReviewTokens,
  createBudgetLedger,
  freezeBudgetRoundLimit,
  reserveReviewBudget,
  reserveReviewRetry,
  reserveAttemptBatch,
  settleBudgetAttempt,
  remainingBudget
} from "../../src/discussion/budget.js";

const ids = ["a", "b"];
const policy = () => normalizeDiscussionPolicy({ effort: "standard" }, ids);
const ledger = () => createBudgetLedger(policy(), 0);
const counts = { a: 0, b: 0 };
function ready() {
  return freezeBudgetRoundLimit(reserveReviewBudget(ledger(), "review-1", counts, 0), { a: "moderate", b: "complex" });
}
it("rejects a pool below the full roster floor", () => {
  expect(() => allocateDiscussionTokens(ids, { a: 100, b: 0.1 }, 4095, 2048, 0)).toThrow();
});
it.each([0, -1, NaN, Infinity, 0.09, 101])("rejects illegal weight %s", (weight) => {
  expect(() => allocateDiscussionTokens(ids, { a: weight, b: 1 }, 8192, 2048, 0)).toThrow();
});
it("rejects missing and unknown members and unsafe allocation arguments", () => {
  expect(() => allocateDiscussionTokens(ids, { a: 1 }, 8192, 2048, 0)).toThrow();
  expect(() => allocateDiscussionTokens(ids, { a: 1, b: 1, c: 1 }, 8192, 2048, 0)).toThrow();
  for (const [pool, floor, round] of [
    [8192.5, 2048, 0],
    [NaN, 2048, 0],
    [8192, 0, 0],
    [8192, 2048, -1],
    [8192, 2048, 0.5]
  ])
    expect(() => allocateDiscussionTokens(ids, { a: 1, b: 1 }, pool!, floor!, round!)).toThrow();
});
it.each([
  [
    { a: 1, b: 1 },
    { a: 4096, b: 4096 }
  ],
  [
    { a: 2, b: 1 },
    { a: 4779, b: 3413 }
  ],
  [
    { a: 1, b: 2 },
    { a: 3413, b: 4779 }
  ]
])("allocates the standard pool proportionally after equal floors", (weights, expected) => {
  expect(allocateDiscussionTokens(ids, weights, 8192, 2048, 0)).toEqual(expected);
});
it("rotates equal remainders across the recorded roster order", () => {
  expect(allocateDiscussionTokens(ids, { a: 1, b: 1 }, 4097, 2048, 0)).toEqual({ a: 2049, b: 2048 });
  expect(allocateDiscussionTokens(ids, { a: 1, b: 1 }, 4097, 2048, 1)).toEqual({ a: 2048, b: 2049 });
});
it("supports three members with a scaled pool and preserves every floor", () => {
  const three = normalizeDiscussionPolicy({}, ["a", "b", "c"]);
  expect(allocateRoundTokens(three, 0)).toEqual({ a: 4096, b: 4096, c: 4096 });
  expect(allocateDiscussionTokens(["a", "b", "c"], { a: 2, b: 1, c: 1 }, 12288, 2048, 0)).toEqual({
    a: 5120,
    b: 3584,
    c: 3584
  });
});
it("keeps decision preference independent of resource allocation", () => {
  const base = normalizeDiscussionPolicy(
    { weights: { a: { participationWeight: 2 }, b: { participationWeight: 1 } } },
    ids
  );
  const changed = normalizeDiscussionPolicy(
    {
      weights: {
        a: { participationWeight: 2, decisionWeight: 0.1 },
        b: { participationWeight: 1, decisionWeight: 100 }
      }
    },
    ids
  );
  expect(allocateRoundTokens(changed, 0)).toEqual(allocateRoundTokens(base, 0));
  expect(allocateReviewTokens(ids, { a: 20, b: 40 })).toEqual({ a: 5120, b: 10240 });
});
it("keeps exact integer bounds even with fractional weights or the largest safe pool", () => {
  for (const pool of [4096, 4097, 8192, Number.MAX_SAFE_INTEGER])
    for (const weights of [
      { a: 0.1, b: 100 },
      { a: 1.0000000000000002, b: 1.1 },
      { a: 100, b: 0.1 }
    ]) {
      const result = allocateDiscussionTokens(ids, weights, pool, 2048, 1);
      expect(Object.values(result).every((value) => Number.isSafeInteger(value) && value >= 2048)).toBe(true);
      expect(result.a! + result.b!).toBe(pool);
    }
});
it("rejects incomplete review counts and review reservation that cannot fund all members", () => {
  expect(() => allocateReviewTokens(ids, { a: 0 })).toThrow();
  expect(() => allocateReviewTokens(ids, { a: 0, b: -1 })).toThrow();
  const limited = createBudgetLedger(normalizeDiscussionPolicy({ maxAllocatedOutputTokens: 8191 }, ids), 0);
  expect(() => reserveReviewBudget(limited, "review", counts, 0)).toThrow(/budget|quota/i);
  expect(limited.reservations).toEqual([]);
});
it("requires full review funding before any non-review dispatch and charges a full batch atomically", () => {
  expect(() => reserveAttemptBatch(ledger(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0)).toThrow(
    /review/i
  );
  const state = ready();
  expect(() => reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a" } }, 0)).toThrow(/member/i);
  const next = reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  expect(state.attempts).toEqual([]);
  expect(next.attempts.map((a) => [a.memberId, a.maxOutputTokens, a.status])).toEqual([
    ["a", 2048, "pending"],
    ["b", 2048, "pending"]
  ]);
  expect(remainingBudget(next, 0)).toMatchObject({ remainingCalls: 16, reservedCalls: 2, reservedOutputTokens: 8192 });
  expect(Object.isFrozen(next)).toBe(true);
  expect(Object.isFrozen(next.attempts[0])).toBe(true);
  expect(Object.isFrozen(next.policy.weights.a)).toBe(true);
});
it("keeps a frozen policy and resolved round cap across later input edits", () => {
  const raw = { effort: "standard", weights: { a: { participationWeight: 2 }, b: { participationWeight: 1 } } };
  const normalized = normalizeDiscussionPolicy(raw, ids),
    state = createBudgetLedger(normalized, 0);
  raw.weights.a.participationWeight = 100;
  expect(state.policy.weights.a!.participationWeight).toBe(2);
  const limited = freezeBudgetRoundLimit(state, { a: "simple", b: "complex" });
  expect(limited.roundLimit).toBe(4);
  expect(() => freezeBudgetRoundLimit(limited, { a: "simple", b: "simple" })).toThrow(/frozen/i);
});
it("protects full review call and output quotas instead of dropping a member", () => {
  const limited = normalizeDiscussionPolicy({ maxCalls: 3 }, ids);
  const state = reserveReviewBudget(createBudgetLedger(limited, 0), "review", counts, 0);
  expect(() => reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0)).toThrow(
    /budget|quota/i
  );
  expect(state.attempts).toEqual([]);
  const review = reserveAttemptBatch(
    state,
    { phase: "review", reservationId: "review", attemptIds: { a: "ra", b: "rb" } },
    0
  );
  expect(review.attempts).toHaveLength(2);
  expect(review.attempts.every((a) => a.maxOutputTokens === 4096 && a.reservationId === "review")).toBe(true);
});
it("refuses discussion without a frozen round limit or outside that cap", () => {
  const state = reserveReviewBudget(ledger(), "review", counts, 0);
  expect(() =>
    reserveAttemptBatch(state, { phase: "discussion", roundIndex: 0, attemptIds: { a: "a", b: "b" } }, 0)
  ).toThrow(/round/i);
  expect(() =>
    reserveAttemptBatch(ready(), { phase: "discussion", roundIndex: 4, attemptIds: { a: "a", b: "b" } }, 0)
  ).toThrow(/round/i);
});
it("charges failure, cancellation and unknown attempts without refund; explicit retries charge anew", () => {
  let state = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  const charged = remainingBudget(state, 0);
  state = settleBudgetAttempt(state, "a", "failed", 1, { outputTokens: 1 });
  state = settleBudgetAttempt(state, "b", "unknown", 1);
  expect(remainingBudget(state, 1).remainingCalls).toBe(charged.remainingCalls);
  expect(remainingBudget(state, 1).remainingAllocatedOutputTokens).toBe(charged.remainingAllocatedOutputTokens);
  const retried = reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a2", b: "b2" } }, 1);
  expect(remainingBudget(retried, 1).remainingCalls).toBe(charged.remainingCalls - 2);
  expect(remainingBudget(retried, 1).remainingAllocatedOutputTokens).toBe(
    charged.remainingAllocatedOutputTokens - 4096
  );
  expect(() => reserveAttemptBatch(retried, { phase: "opening", attemptIds: { a: "a2", b: "b2" } }, 1)).toThrow(
    /attempt/i
  );
});
it("keeps completed review observations and reserves only explicit failed-member retry at its full cap", () => {
  let state = reserveAttemptBatch(
    ready(),
    { phase: "review", reservationId: "review-1", attemptIds: { a: "ra", b: "rb" } },
    0
  );
  state = settleBudgetAttempt(state, "ra", "succeeded", 1, { outputTokens: 7 });
  state = settleBudgetAttempt(state, "rb", "failed", 1);
  const before = remainingBudget(state, 1);
  expect(() => reserveReviewRetry(state, "retry-a", "review-1", "a", 1)).toThrow();
  state = reserveReviewRetry(state, "retry-b", "review-1", "b", 1);
  expect(remainingBudget(state, 1)).toMatchObject({ reservedCalls: 1, reservedOutputTokens: 4096 });
  expect(() => reserveReviewRetry(state, "retry-b-again", "review-1", "b", 1)).toThrow();
  state = reserveAttemptBatch(state, { phase: "review", reservationId: "retry-b", attemptIds: { b: "rb2" } }, 1);
  expect(remainingBudget(state, 1).remainingCalls).toBe(before.remainingCalls - 1);
  expect(remainingBudget(state, 1).remainingAllocatedOutputTokens).toBe(before.remainingAllocatedOutputTokens - 4096);
  expect(state.attempts.find((a) => a.attemptId === "ra")!.observedUsage).toEqual({ outputTokens: 7 });
});
it("reserves a complete time window, clips discussion timeouts and rejects the exact deadline", () => {
  const state = ready();
  const next = reserveAttemptBatch(
    state,
    { phase: "opening", attemptIds: { a: "a", b: "b" } },
    policy().maxDurationMs - 90000
  );
  expect(next.attempts.every((a) => a.timeoutMs === 30000)).toBe(true);
  expect(() =>
    reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a", b: "b" } }, policy().maxDurationMs - 60000)
  ).toThrow(/time|deadline/i);
  expect(() => reserveReviewBudget(ledger(), "review", counts, policy().maxDurationMs - 59999)).toThrow(
    /time|deadline/i
  );
  expect(() =>
    reserveAttemptBatch(
      state,
      { phase: "review", reservationId: "review-1", attemptIds: { a: "a", b: "b" } },
      policy().maxDurationMs
    )
  ).toThrow(/time|deadline/i);
});
it("rejects clock rollback and late success, but records late unknown without refund", () => {
  const state = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 10);
  expect(() => settleBudgetAttempt(state, "a", "failed", 9)).toThrow(/time|clock/i);
  expect(() => settleBudgetAttempt(state, "a", "succeeded", 60011)).toThrow(/deadline|time/i);
  const late = settleBudgetAttempt(state, "a", "unknown", 60011);
  expect(remainingBudget(late, 60011).remainingCalls).toBe(16);
  expect(() => settleBudgetAttempt(late, "a", "succeeded", 60012)).toThrow();
});
it("increases an unused review reserve as coverage grows, never shrinks it or edits a dispatched one", () => {
  let state = reserveReviewBudget(ledger(), "review", counts, 0);
  state = reserveReviewBudget(state, "review", { a: 20, b: 40 }, 1);
  state = reserveReviewBudget(state, "review", counts, 2);
  expect(state.reservations[0]!.allocation).toEqual({ a: 5120, b: 10240 });
  expect(state.reservations[0]!.updates).toHaveLength(3);
  state = reserveAttemptBatch(state, { phase: "review", reservationId: "review", attemptIds: { a: "a", b: "b" } }, 2);
  expect(() => reserveReviewBudget(state, "review", counts, 3)).toThrow();
});
it.each(["low", "standard", "high"] as const)(
  "fits the full worst-case %s two/three-member schedule into frozen caps",
  (effort) => {
    for (const roster of [
      ["a", "b"],
      ["a", "b", "c"]
    ]) {
      const configured = normalizeDiscussionPolicy({ effort }, roster);
      let state = freezeBudgetRoundLimit(
        createBudgetLedger(configured, 0),
        Object.fromEntries(roster.map((id) => [id, "complex" as const]))
      );
      const reviewCounts = Object.fromEntries(roster.map((id) => [id, 32]));
      state = reserveReviewBudget(state, "review-0", reviewCounts, 0);
      state = reserveAttemptBatch(
        state,
        { phase: "opening", attemptIds: Object.fromEntries(roster.map((id) => [id, `opening-${id}`])) },
        0
      );
      for (let round = 0; round < state.roundLimit!; round++) {
        if (round) state = reserveReviewBudget(state, `review-${round}`, reviewCounts, 0);
        state = reserveAttemptBatch(
          state,
          {
            phase: "discussion",
            roundIndex: round,
            attemptIds: Object.fromEntries(roster.map((id) => [id, `discussion-${round}-${id}`]))
          },
          0
        );
        state = reserveAttemptBatch(
          state,
          {
            phase: "review",
            reservationId: `review-${round}`,
            attemptIds: Object.fromEntries(roster.map((id) => [id, `review-${round}-${id}`]))
          },
          0
        );
      }
      const remaining = remainingBudget(state, 0);
      expect(state.attempts).toHaveLength(configured.maxCalls);
      expect(remaining.remainingCalls).toBe(0);
      expect(remaining.remainingAllocatedOutputTokens).toBeGreaterThanOrEqual(0);
      expect(remaining.reservedCalls).toBe(0);
      expect(() => reserveReviewBudget(state, "one-too-many", reviewCounts, 0)).toThrow(/budget|quota/i);
    }
  }
);
it("accepts exact output capacity and refuses even one token short atomically", () => {
  for (const limit of [12287, 12288]) {
    const capped = normalizeDiscussionPolicy({ maxAllocatedOutputTokens: limit }, ids);
    const state = reserveReviewBudget(createBudgetLedger(capped, 0), "review", counts, 0);
    if (limit === 12287)
      expect(() => reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0)).toThrow(
        /budget|quota/i
      );
    else
      expect(
        remainingBudget(reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0), 0)
      ).toMatchObject({ remainingAllocatedOutputTokens: 8192, reservedOutputTokens: 8192 });
    expect(state.attempts).toEqual([]);
  }
});
it.each(["succeeded", "failed", "cancelled", "unknown"] as const)(
  "never refunds a %s attempt even with zero observed usage",
  (status) => {
    const charged = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
    const settled = settleBudgetAttempt(charged, "a", status, 1, { inputTokens: 0, outputTokens: 0 });
    expect(remainingBudget(settled, 1).remainingAllocatedOutputTokens).toBe(
      remainingBudget(charged, 1).remainingAllocatedOutputTokens
    );
    expect(remainingBudget(settled, 1).remainingCalls).toBe(remainingBudget(charged, 1).remainingCalls);
  }
);
it("rejects invalid usage and rejects success at the exact call deadline", () => {
  const charged = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  expect(() => settleBudgetAttempt(charged, "a", "succeeded", 60000)).toThrow(/deadline/i);
  for (const usage of [{ outputTokens: -1 }, { outputTokens: NaN }, { outputTokens: 1.5 }])
    expect(() => settleBudgetAttempt(charged, "a", "failed", 1, usage)).toThrow();
});
it("handles member IDs that are object prototype names without losing quotas", () => {
  const roster = ["__proto__", "constructor"];
  const configured = normalizeDiscussionPolicy({}, roster);
  const allocation = allocateRoundTokens(configured, 0);
  expect(Object.keys(allocation)).toEqual(roster);
  expect(allocation["__proto__"]).toBe(4096);
  expect(allocation["constructor"]).toBe(4096);
  const state = reserveReviewBudget(
    createBudgetLedger(configured, 0),
    "review",
    Object.fromEntries(roster.map((id) => [id, 0])),
    0
  );
  const charged = reserveAttemptBatch(
    state,
    {
      phase: "review",
      reservationId: "review",
      attemptIds: Object.fromEntries(roster.map((id) => [id, `attempt-${id}`]))
    },
    0
  );
  expect(charged.attempts.map((item) => item.memberId)).toEqual(roster);
});
it("validates non-enumerable roster weights and refuses symbol members", () => {
  const weights = { b: 1 } as Record<string, number>;
  Object.defineProperty(weights, "a", { value: 0 });
  expect(() => allocateDiscussionTokens(ids, weights, 8192, 2048, 0)).toThrow(/weight/i);
  expect(() => allocateDiscussionTokens(ids, { a: 1, b: 1, [Symbol("hidden-member")]: 1 }, 8192, 2048, 0)).toThrow(
    /member/i
  );
});
it("consumes every validated review attempt ID even when an input property is non-enumerable", () => {
  const attemptIds = { b: "rb" } as Record<string, string>;
  Object.defineProperty(attemptIds, "a", { value: "ra" });
  const charged = reserveAttemptBatch(ready(), { phase: "review", reservationId: "review-1", attemptIds }, 0);
  expect(charged.reservations[0]!.attemptIds).toEqual({ a: "ra", b: "rb" });
  expect(remainingBudget(charged, 0).reservedCalls).toBe(0);
  expect(() =>
    reserveAttemptBatch(charged, { phase: "review", reservationId: "review-1", attemptIds: { a: "ra2" } }, 0)
  ).toThrow(/consumed/i);
  expect(() => reserveReviewRetry(charged, "retry", "review-1", "a", 0)).toThrow(/Only a failed/i);
});
it("records review consumption from the charged snapshot without reading input getters twice", () => {
  let reads = 0;
  const attemptIds = { b: "rb" } as Record<string, string>;
  Object.defineProperty(attemptIds, "a", { enumerable: true, get: () => `ra-${++reads}` });
  const charged = reserveAttemptBatch(ready(), { phase: "review", reservationId: "review-1", attemptIds }, 0);
  expect(reads).toBe(1);
  expect(charged.reservations[0]!.attemptIds.a).toBe(charged.attempts.find((a) => a.memberId === "a")!.attemptId);
  expect(remainingBudget(charged, 0).reservedCalls).toBe(0);
});
