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
  remainingBudget,
  reserveRetryAttempts,
  extendDiscussionBudget,
  BudgetCapacityError
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

it.each(["failed", "cancelled", "unknown"] as const)("retries only the missing %s member without refund", (outcome) => {
  let state = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  state = settleBudgetAttempt(state, "a", "succeeded", 1);
  state = settleBudgetAttempt(state, "b", outcome, 1);
  const before = remainingBudget(state, 1);
  const retried = reserveRetryAttempts(state, { b: "b2" }, { b: "b" }, 2);
  expect(retried.attempts).toHaveLength(3);
  expect(retried.attempts.slice(0, 2)).toEqual(state.attempts);
  expect(retried.attempts[2]).toMatchObject({ memberId: "b", maxOutputTokens: 2048, phase: "opening" });
  expect(remainingBudget(retried, 2)).toMatchObject({
    remainingCalls: before.remainingCalls - 1,
    remainingAllocatedOutputTokens: before.remainingAllocatedOutputTokens - 2048,
    reservedCalls: 2,
    reservedOutputTokens: 8192
  });
});
it("retries discussion at its original weighted cap and round without redistribution", () => {
  const configured = normalizeDiscussionPolicy(
    { weights: { a: { participationWeight: 2 }, b: { participationWeight: 1 } } },
    ids
  );
  let state = freezeBudgetRoundLimit(reserveReviewBudget(createBudgetLedger(configured, 0), "r", counts, 0), {
    a: "complex",
    b: "complex"
  });
  state = reserveAttemptBatch(state, { phase: "discussion", roundIndex: 0, attemptIds: { a: "a", b: "b" } }, 0);
  state = settleBudgetAttempt(state, "a", "failed", 1);
  state = settleBudgetAttempt(state, "b", "succeeded", 1);
  const retried = reserveRetryAttempts(state, { a: "a2" }, { a: "a" }, 2);
  expect(retried.attempts[2]).toMatchObject({ phase: "discussion", roundIndex: 0, maxOutputTokens: 4779 });
  expect(retried.policy).toBe(state.policy);
  expect(state.attempts).toHaveLength(2);
});
it("charges review retries against the same checkpoint and preserves successful reviewers", () => {
  let state = reserveAttemptBatch(
    ready(),
    { phase: "review", reservationId: "review-1", attemptIds: { a: "a", b: "b" } },
    0
  );
  state = settleBudgetAttempt(state, "a", "succeeded", 1);
  state = settleBudgetAttempt(state, "b", "unknown", 1);
  state = reserveRetryAttempts(state, { b: "b2" }, { b: "b" }, 2);
  expect(state.attempts[2]).toMatchObject({ maxOutputTokens: 4096, reservationId: "b2:reservation" });
  expect(state.reservations[1]).toMatchObject({ checkpointId: "review-1", allocation: { b: 4096 } });
  state = settleBudgetAttempt(state, "b2", "failed", 3);
  const next = reserveRetryAttempts(state, { b: "b3" }, { b: "b2" }, 4);
  expect(next.attempts).toHaveLength(4);
  expect(remainingBudget(next, 4).remainingCalls).toBe(14);
  expect(remainingBudget(next, 4).remainingAllocatedOutputTokens).toBe(policy().maxAllocatedOutputTokens - 16384);
  expect(() => reserveRetryAttempts(next, { b: "b4" }, { b: "b" }, 4)).toThrow(/latest/i);
});
it("rejects retry of pending, successful, wrong-member, unknown, duplicate or empty attempts", () => {
  let state = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  expect(() => reserveRetryAttempts(state, { a: "a2" }, { a: "a" }, 0)).toThrow(/latest/i);
  state = settleBudgetAttempt(state, "a", "succeeded", 1);
  state = settleBudgetAttempt(state, "b", "failed", 1);
  const invalidReferences: Array<readonly [Record<string, string>, Record<string, string>]> = [
    [{ a: "a2" }, { a: "a" }],
    [{ b: "b2" }, { b: "a" }],
    [{ b: "b2" }, { b: "missing" }],
    [{ b: "a" }, { b: "b" }],
    [{}, {}],
    [{ x: "x2" }, { x: "x" }],
    [{ b: "b2" }, { a: "a", b: "b" }]
  ];
  for (const [next, prior] of invalidReferences) expect(() => reserveRetryAttempts(state, next, prior, 1)).toThrow();
  expect(() => reserveRetryAttempts(state, { b: "b2", [Symbol("x")]: "x" }, { b: "b" }, 1)).toThrow();
  expect(state.attempts).toHaveLength(2);
});
it("rejects retry subsets from different phase-round batches atomically", () => {
  let state = reserveAttemptBatch(ready(), { phase: "discussion", roundIndex: 0, attemptIds: { a: "a0", b: "b0" } }, 0);
  state = settleBudgetAttempt(state, "a0", "failed", 1);
  state = reserveAttemptBatch(state, { phase: "discussion", roundIndex: 1, attemptIds: { a: "a1", b: "b1" } }, 1);
  state = settleBudgetAttempt(state, "b1", "failed", 2);
  expect(() => reserveRetryAttempts(state, { a: "a2", b: "b2" }, { a: "a0", b: "b1" }, 2)).toThrow(/same phase/i);
  expect(state.attempts).toHaveLength(4);
});
it("distinguishes exhausted hard caps from illegal operations and permits only explicit extension", () => {
  let state = reserveReviewBudget(
    createBudgetLedger(normalizeDiscussionPolicy({ maxCalls: 4, maxAllocatedOutputTokens: 12288 }, ids), 0),
    "r",
    counts,
    0
  );
  state = reserveAttemptBatch(state, { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  state = settleBudgetAttempt(state, "b", "unknown", 1);
  expect(() => reserveRetryAttempts(state, { b: "b2" }, { b: "b" }, 1)).toThrow(BudgetCapacityError);
  expect(() => reserveRetryAttempts(state, { x: "x2" }, { x: "x" }, 1)).not.toThrow(BudgetCapacityError);
  const expanded = extendDiscussionBudget(
    state,
    { extensionId: "extra", extraCalls: 1, extraAllocatedOutputTokens: 2048 },
    1
  );
  const retried = reserveRetryAttempts(expanded, { b: "b2" }, { b: "b" }, 1);
  expect(remainingBudget(retried, 1)).toMatchObject({ remainingCalls: 2, remainingAllocatedOutputTokens: 8192 });
  const reviewed = reserveAttemptBatch(
    retried,
    { phase: "review", reservationId: "r", attemptIds: { a: "ra", b: "rb" } },
    1
  );
  expect(remainingBudget(reviewed, 1)).toMatchObject({ remainingCalls: 0, remainingAllocatedOutputTokens: 0 });
  expect(state.extensions).toBeUndefined();
});
it("appends frozen extension history while preserving original caps and enforcing a monotonic clock", () => {
  const original = ledger();
  const first = extendDiscussionBudget(original, { extensionId: "one", extraCalls: 1, extendMs: 10 }, 4);
  const next = extendDiscussionBudget(first, { extensionId: "two", extraAllocatedOutputTokens: 500, extendMs: 20 }, 5);
  expect(next.policy).toBe(original.policy);
  expect(next.deadlineAtMs).toBe(original.deadlineAtMs + 30);
  expect(next.extensions).toEqual([
    { extensionId: "one", atMs: 4, extraCalls: 1, extraAllocatedOutputTokens: 0, extendMs: 10 },
    { extensionId: "two", atMs: 5, extraCalls: 0, extraAllocatedOutputTokens: 500, extendMs: 20 }
  ]);
  expect(Object.isFrozen(next.extensions)).toBe(true);
  expect(Object.isFrozen(next.extensions![0])).toBe(true);
  expect(() => extendDiscussionBudget(next, { extensionId: "one", extraCalls: 1 }, 5)).toThrow(/unique/i);
  expect(() => extendDiscussionBudget(next, { extensionId: "three", extraCalls: 1 }, 4)).toThrow(/backwards/i);
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => extendDiscussionBudget(next, { extensionId: "bad", extraCalls: value }, 5)).toThrow();
  expect(() => extendDiscussionBudget(next, { extensionId: "empty" }, 5)).toThrow(/positive/i);
});
it("cannot spend the full review time window on a retry without explicit deadline extension", () => {
  let state = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  state = settleBudgetAttempt(state, "b", "cancelled", 1);
  const now = state.deadlineAtMs - state.policy.callTimeoutMs;
  expect(() => reserveRetryAttempts(state, { b: "b2" }, { b: "b" }, now)).toThrow(BudgetCapacityError);
  state = extendDiscussionBudget(state, { extensionId: "time", extendMs: 100 }, now);
  const retried = reserveRetryAttempts(state, { b: "b2" }, { b: "b" }, now);
  expect(retried.attempts[2]!.timeoutMs).toBe(100);
  expect(retried.attempts[2]!.deadlineAtMs).toBe(now + 100);
});
it("captures retry IDs once even for non-enumerable getters", () => {
  let state = reserveAttemptBatch(ready(), { phase: "opening", attemptIds: { a: "a", b: "b" } }, 0);
  state = settleBudgetAttempt(state, "b", "failed", 1);
  let reads = 0;
  const next = {} as Record<string, string>;
  Object.defineProperty(next, "b", { get: () => `b${++reads}` });
  const retried = reserveRetryAttempts(state, next, { b: "b" }, 1);
  expect(reads).toBe(1);
  expect(retried.attempts[2]!.attemptId).toBe("b1");
});
it("retries a review subset across different prior retry reservations in the same checkpoint", () => {
  let state = reserveAttemptBatch(
    ready(),
    { phase: "review", reservationId: "review-1", attemptIds: { a: "a", b: "b" } },
    0
  );
  state = settleBudgetAttempt(state, "a", "failed", 1);
  state = settleBudgetAttempt(state, "b", "unknown", 1);
  state = reserveRetryAttempts(state, { a: "a2" }, { a: "a" }, 2);
  state = settleBudgetAttempt(state, "a2", "cancelled", 3);
  const retried = reserveRetryAttempts(state, { a: "a3", b: "b2" }, { a: "a2", b: "b" }, 4);
  expect(retried.attempts.slice(-2).map((attempt) => attempt.memberId)).toEqual(ids);
  expect(retried.reservations.slice(-2).every((reservation) => reservation.checkpointId === "review-1")).toBe(true);
});
it("does not persist any partial retry reservation when a multi-member retry exhausts capacity", () => {
  let state = reserveReviewBudget(
    createBudgetLedger(normalizeDiscussionPolicy({ maxCalls: 3 }, ids), 0),
    "r",
    counts,
    0
  );
  state = reserveAttemptBatch(state, { phase: "review", reservationId: "r", attemptIds: { a: "a", b: "b" } }, 0);
  state = settleBudgetAttempt(state, "a", "failed", 1);
  state = settleBudgetAttempt(state, "b", "unknown", 1);
  const snapshot = JSON.stringify(state);
  expect(() => reserveRetryAttempts(state, { a: "a2", b: "b2" }, { a: "a", b: "b" }, 2)).toThrow(BudgetCapacityError);
  expect(JSON.stringify(state)).toBe(snapshot);
});
