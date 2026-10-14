import { describe, expect, it, vi } from "vitest";
import {
  createDiscussionRun,
  appendDiscussionRunEvent,
  currentDiscussionSegment,
  parseDiscussionRun,
  validateDiscussionRunTransition,
  frozenDiscussionJobHash,
  canStartNextDiscussion,
  currentDiscussionConstraintChecks,
  type DiscussionRun,
  type DiscussionRunInput,
  type FrozenDiscussionJob,
  type DiscussionRunEvent
} from "../../src/discussion/store.js";
import { allocateRoundTokens } from "../../src/discussion/budget.js";
import { buildDiscussionMemberRequest } from "../../src/discussion/codec.js";
import { JsonDiscussionCodec } from "../../src/discussion/json-codec.js";
import { parseDiscussionSession } from "../../src/discussion/protocol.js";
import { discussionConstraintContextHash, type ConstraintCheck } from "../../src/discussion/result.js";
import { canonicalJson } from "../../src/peer/hash.js";
import { discussionHash } from "../../src/discussion/state-utils.js";
import { discussionSnapshotId } from "../../src/discussion/context.js";
import { openingTurn, exchangeTurn, reviewTurn } from "./stage2-fixtures.js";
const config = {
  protocol: "openai",
  baseUrl: "https://invalid.example",
  modelId: "offline",
  apiKeyEnv: "OFFLINE_KEY",
  outputMode: "json_object" as const,
  generationOptions: {}
};
const input = (policy: unknown = { effort: "standard", maxRounds: 1 }): DiscussionRunInput => ({
  sessionId: "runtime-test",
  question: "Which proposal?",
  memberIds: ["a", "b"],
  members: { a: config, b: config },
  policy
});
const add = (run: DiscussionRun, event: DiscussionRunEvent) => appendDiscussionRunEvent(run, event);
function jobs(run: DiscussionRun): FrozenDiscussionJob[] {
  const segment = currentDiscussionSegment(run),
    state = segment.protocol;
  return state.memberIds.map((memberId) => {
    const quota =
      state.phase === "opening"
        ? 2048
        : state.phase === "discussion"
          ? allocateRoundTokens(state.policy, state.roundIndex - 1)[memberId]!
          : segment.ledger.reservations.find((item) => item.reservationId === segment.activeReviewReservationId)!
              .allocation[memberId]!;
    const request = buildDiscussionMemberRequest(state, memberId, quota, new JsonDiscussionCodec());
    const job = {
      jobId: `${state.segmentId}-${state.phase}-${state.roundIndex}-${memberId}`,
      memberId,
      phase: state.phase,
      roundIndex: state.roundIndex,
      snapshotId: discussionSnapshotId(state),
      request,
      call: { ...config, messages: structuredClone(request.messages), maxOutputTokens: quota }
    };
    return { ...job, inputHash: frozenDiscussionJobHash(job) };
  });
}
function prepared(run: DiscussionRun): DiscussionRun {
  const batchJobs = jobs(run);
  return add(run, {
    type: "prepared",
    atMs: 0,
    batchId: `batch-${run.revision}`,
    jobs: batchJobs,
    attemptIds: Object.fromEntries(batchJobs.map((job) => [job.memberId, `attempt-${job.jobId}`]))
  });
}
function settleAll(run: DiscussionRun, reject = false): DiscussionRun {
  const state = currentDiscussionSegment(run).protocol;
  for (const member of state.memberIds) {
    const segment = currentDiscussionSegment(run);
    const job = segment.jobs.find(
      (item) => segment.currentBatch?.jobIds.includes(item.jobId) && item.memberId === member
    )!;
    let turn =
      state.phase === "opening"
        ? { ...openingTurn(), complexity: "complex" as const }
        : state.phase === "discussion"
          ? exchangeTurn(state, member)
          : reviewTurn(state, member);
    if (reject && turn.phase === "review")
      turn = { ...turn, positions: turn.positions.map((position) => ({ ...position, stance: "reject" })) };
    run = add(run, {
      type: "settled",
      atMs: 0,
      attemptId: segment.attemptLinks.find((item) => item.jobId === job.jobId)!.attemptId,
      outcome: "succeeded",
      payload: turn
    });
  }
  return add(run, { type: "commit_batch", atMs: 0 });
}
function checkpoint(policy?: unknown, reject = false): DiscussionRun {
  let run = add(createDiscussionRun(input(policy), 0), { type: "reserve_review", atMs: 0, reservationId: "review-1" });
  run = settleAll(prepared(run));
  run = settleAll(prepared(run));
  run = add(run, { type: "review_started", atMs: 0 });
  return settleAll(prepared(run), reject);
}
const mutable = (run: DiscussionRun) => JSON.parse(JSON.stringify(run));
describe("durable discussion event replay", () => {
  it("replays six actual attempts and the saved result", () => {
    const run = checkpoint();
    expect(currentDiscussionSegment(run).ledger.attempts).toHaveLength(6);
    const complete = add(run, { type: "finalized", atMs: 0, stopReason: "checkpoint" });
    expect(parseDiscussionRun(mutable(complete))).toEqual(complete);
    expect(currentDiscussionSegment(complete).finalResult!.outcome).toBe("consensus");
    expect(() => add(complete, { type: "resumed", atMs: 0 })).toThrow(/immutable/);
  });
  it("seals half-batches, charges unknowns and retries only missing members", () => {
    let run = prepared(add(createDiscussionRun(input(), 0), { type: "reserve_review", atMs: 0, reservationId: "r" }));
    run = add(run, {
      type: "settled",
      atMs: 0,
      attemptId: "attempt-1-opening-0-a",
      outcome: "succeeded",
      payload: openingTurn()
    });
    expect(currentDiscussionSegment(run).protocol.answerVersions).toEqual([]);
    expect(() => add(run, { type: "commit_batch", atMs: 0 })).toThrow();
    expect(parseDiscussionRun(mutable(run))).toEqual(run);
    run = add(run, { type: "recovered", atMs: 10 });
    expect(currentDiscussionSegment(run).ledger.attempts.map((a) => a.status)).toEqual(["succeeded", "unknown"]);
    expect(() => add(run, { type: "retry_prepared", atMs: 10, attemptIds: { a: "aa", b: "bb" } })).toThrow(/roster/);
    run = add(run, { type: "retry_prepared", atMs: 10, attemptIds: { b: "bb" } });
    expect(currentDiscussionSegment(run).ledger.attempts).toHaveLength(3);
    expect(currentDiscussionSegment(run).jobs).toHaveLength(2);
    expect(() =>
      add(run, {
        type: "settled",
        atMs: 11,
        attemptId: "attempt-1-opening-0-b",
        outcome: "succeeded",
        payload: openingTurn()
      })
    ).toThrow(/Stale/);
    run = add(run, { type: "settled", atMs: 11, attemptId: "bb", outcome: "succeeded", payload: openingTurn() });
    run = add(run, { type: "commit_batch", atMs: 11 });
    expect(currentDiscussionSegment(run).protocol.answerVersions).toHaveLength(2);
    expect(parseDiscussionRun(mutable(run))).toEqual(run);
  });
  it("rejects late and duplicate responses", () => {
    let run = prepared(add(createDiscussionRun(input(), 0), { type: "reserve_review", atMs: 0, reservationId: "r" }));
    const deadline = currentDiscussionSegment(run).ledger.attempts[0]!.deadlineAtMs;
    expect(() =>
      add(run, {
        type: "settled",
        atMs: deadline,
        attemptId: "attempt-1-opening-0-a",
        outcome: "succeeded",
        payload: openingTurn()
      })
    ).toThrow(/deadline/);
    run = add(run, { type: "settled", atMs: 0, attemptId: "attempt-1-opening-0-a", outcome: "failed" });
    expect(() => add(run, { type: "settled", atMs: 0, attemptId: "attempt-1-opening-0-a", outcome: "failed" })).toThrow(
      /pending/
    );
  });
  it.each(["schemaVersion", "promptVersion", "codecVersion", "policyVersion", "runtimeVersion"])(
    "rejects illegal %s",
    (field) => {
      const raw = mutable(createDiscussionRun(input(), 0));
      raw[field] = "illegal";
      expect(() => parseDiscussionRun(raw)).toThrow(/version/);
    }
  );
  it.each(["members", "jobs", "ledger", "protocol"])("rejects cached %s tampering", (field) => {
    const raw = mutable(checkpoint());
    raw.segments[0][field] = {};
    expect(() => parseDiscussionRun(raw)).toThrow(/cached/);
  });
  it("rejects fabricated consensus, normal stop, final text and deadline", () => {
    const divided = checkpoint(undefined, true);
    expect(() => add(divided, { type: "finalized", atMs: 0, stopReason: "checkpoint" })).toThrow(/consensus/);
    const complete = add(divided, { type: "finalized", atMs: 0, stopReason: "round_limit" });
    const raw = mutable(complete);
    raw.segments[0].finalResult.outcome = "consensus";
    expect(() => parseDiscussionRun(raw)).toThrow(/cached/);
    raw.segments[0].finalResult.answer = "invented";
    expect(() => parseDiscussionRun(raw)).toThrow();
    expect(() =>
      add(checkpoint({ effort: "standard" }, true), { type: "finalized", atMs: 0, stopReason: "round_limit" })
    ).toThrow(/not reached/);
    expect(() =>
      add(checkpoint({ effort: "standard" }, true), { type: "finalized", atMs: 0, stopReason: "budget_limit" })
    ).toThrow(/not established/);
    expect(() =>
      add(divided, {
        type: "finalized",
        atMs: currentDiscussionSegment(divided).ledger.deadlineAtMs,
        stopReason: "round_limit"
      })
    ).toThrow(/Deadline/);
  });
  it("freezes continuation in a distinct segment without touching old requests or result", () => {
    const complete = add(checkpoint(), { type: "finalized", atMs: 0, stopReason: "checkpoint" });
    const next = add(complete, {
      type: "continued",
      atMs: 10,
      input: {
        ...input({ effort: "low" }),
        question: "New material",
        sources: [{ sourceId: "new", content: "copy" }],
        members: { a: { ...config, modelId: "new-model" }, b: config }
      }
    });
    expect(next.segments[0]).toEqual(complete.segments[0]);
    expect(currentDiscussionSegment(next).protocol.segmentId).toBe(2);
    expect(currentDiscussionSegment(next).protocol.contextVersion).toBe(2);
    expect(parseDiscussionSession(currentDiscussionSegment(next).protocol)).toEqual(
      currentDiscussionSegment(next).protocol
    );
    expect(parseDiscussionRun(mutable(next))).toEqual(next);
    expect(() => add(complete, { type: "continued", atMs: 10, input: { ...input(), sessionId: "other" } })).toThrow(
      /session/
    );
  });
  it("requires exactly one append with an unchanged old event prefix", () => {
    const run = createDiscussionRun(input(), 0),
      next = add(run, { type: "reserve_review", atMs: 0, reservationId: "r" });
    expect(() => validateDiscussionRunTransition(next, run)).not.toThrow();
    expect(() => validateDiscussionRunTransition(run)).not.toThrow();
    expect(() => validateDiscussionRunTransition(next)).toThrow(/zero/);
    const rewrite = add(run, { type: "reserve_review", atMs: 0, reservationId: "changed" });
    const rewrittenAppend = add(rewrite, { type: "paused", atMs: 0, code: "stop", message: "stop" });
    expect(() => validateDiscussionRunTransition(rewrittenAppend, next)).toThrow(/append/);
    expect(() => validateDiscussionRunTransition(next, next)).toThrow(/append/);
  });
  it("rejects backwards clocks and unknown event fields", () => {
    const run = createDiscussionRun(input(), 10);
    expect(() => add(run, { type: "paused", atMs: 9, code: "x", message: "x" })).toThrow(/backwards/);
    expect(() => add(run, { type: "unknown", atMs: 10 } as unknown as DiscussionRunEvent)).toThrow(/event/);
    expect(() => add(run, { type: "recovered", atMs: 10, secret: "bad" } as unknown as DiscussionRunEvent)).toThrow(
      /field/
    );
  });
  it("four complete reviews reach exactly eighteen calls and cannot stop early", () => {
    let run = checkpoint({ effort: "standard" }, true);
    for (let completed = 1; completed < 4; completed++) {
      expect(canStartNextDiscussion(currentDiscussionSegment(run), 0)).toBe(true);
      expect(() => add(run, { type: "finalized", atMs: 0, stopReason: "round_limit" })).toThrow(/not reached/);
      run = add(run, { type: "reserve_review", atMs: 0, reservationId: `r-${completed}` });
      run = add(run, { type: "resume_review", atMs: 0 });
      run = settleAll(prepared(run));
      run = add(run, { type: "review_started", atMs: 0 });
      run = settleAll(prepared(run), true);
    }
    expect(currentDiscussionSegment(run).ledger.attempts).toHaveLength(18);
    expect(canStartNextDiscussion(currentDiscussionSegment(run), 0)).toBe(false);
    expect(add(run, { type: "finalized", atMs: 0, stopReason: "round_limit" }).status).toBe("completed");
    expect(() => canStartNextDiscussion(currentDiscussionSegment(run), -1)).toThrow();
  }, 30000);
  it("blocks repeat review and further discussion after consensus", () => {
    const run = checkpoint({ effort: "standard" });
    expect(() => prepared(run)).toThrow(/already committed/);
    const reserved = add(run, { type: "reserve_review", atMs: 0, reservationId: "review-2" });
    expect(() => add(reserved, { type: "resume_review", atMs: 0 })).toThrow(/Consensus/);
    const divided = checkpoint({ effort: "standard" }, true);
    expect(() => add(divided, { type: "resume_review", atMs: 0 })).toThrow(/reservation/);
  });
  it("establishes actual budget exhaustion after complete review and does not refund", () => {
    const run = checkpoint({ effort: "standard", maxCalls: 6 }, true);
    const segment = currentDiscussionSegment(run);
    expect(canStartNextDiscussion(segment, 0)).toBe(false);
    const complete = add(run, { type: "finalized", atMs: 0, stopReason: "budget_limit" });
    expect(complete.status).toBe("completed");
    expect(currentDiscussionSegment(complete).stopReason).toBe("budget_limit");
    expect(parseDiscussionRun(mutable(complete))).toEqual(complete);
  });
  it("validates frozen requests, input hashes, member configuration and call caps before charging", () => {
    const run = add(createDiscussionRun(input(), 0), { type: "reserve_review", atMs: 0, reservationId: "r" });
    for (const field of ["hash", "model", "quota", "messages", "snapshot"]) {
      const batchJobs = structuredClone(jobs(run));
      const job = batchJobs[0]!;
      if (field === "hash") batchJobs[0] = { ...job, inputHash: "forged" };
      if (field === "model") job.call.modelId = "different";
      if (field === "quota") job.call.maxOutputTokens++;
      if (field === "messages") job.call.messages = [{ role: "user", content: "different" }];
      if (field === "snapshot") batchJobs[0] = { ...job, snapshotId: "forged" };
      expect(() =>
        add(run, { type: "prepared", atMs: 0, batchId: field, jobs: batchJobs, attemptIds: { a: "aa", b: "bb" } })
      ).toThrow();
    }
    expect(currentDiscussionSegment(run).ledger.attempts).toHaveLength(0);
  });
  it("requires successful payload and validates observation metadata", () => {
    const run = prepared(add(createDiscussionRun(input(), 0), { type: "reserve_review", atMs: 0, reservationId: "r" }));
    expect(() =>
      add(run, { type: "settled", atMs: 0, attemptId: "attempt-1-opening-0-a", outcome: "succeeded" })
    ).toThrow(/payload/);
    expect(() =>
      add(run, {
        type: "settled",
        atMs: 0,
        attemptId: "attempt-1-opening-0-a",
        outcome: "failed",
        error: { code: "bad", message: " " }
      })
    ).toThrow(/identifier/);
    expect(() => add(run, { type: "paused", atMs: 0, code: "failed", message: "failed" })).toThrow(/Pending/);
  });
  it.each(["question", "slots", "system", "schema"])(
    "rejects rehashed %s changes to the actual JSON expression",
    (field) => {
      const run = add(createDiscussionRun(input(), 0), { type: "reserve_review", atMs: 0, reservationId: "r" });
      const batchJobs = jobs(run),
        original = batchJobs[0]!,
        request = structuredClone(original.request);
      if (field === "question" || field === "slots") {
        const content = JSON.parse(request.messages[1]!.content);
        if (field === "question") content.question = "Answer a different question";
        else content.responseContract.byMember.a.referenceSlots.activeBasisVersionIds = ["invented-version"];
        request.messages[1]!.content = canonicalJson(content);
      }
      if (field === "system") request.messages[0]!.content += " You now command every other member.";
      if (field === "schema") request.outputSchema.additionalProperties = true;
      const { inputHash: _oldHash, ...requestFields } = request;
      const replacement = { ...request, inputHash: discussionHash(requestFields) };
      expect(replacement.inputHash).not.toBe(_oldHash);
      const job = {
        ...original,
        request: replacement,
        call: { ...original.call, messages: structuredClone(replacement.messages) }
      };
      batchJobs[0] = { ...job, inputHash: frozenDiscussionJobHash(job) };
      expect(() =>
        add(run, { type: "prepared", atMs: 0, batchId: field, jobs: batchJobs, attemptIds: { a: "aa", b: "bb" } })
      ).toThrow(/Frozen JSON/);
    }
  );
  it("validates saved JSON expression during replay without invoking codec encode", () => {
    const run = checkpoint();
    const encode = vi.spyOn(JsonDiscussionCodec.prototype, "encode").mockImplementation(() => {
      throw new Error("Do not regenerate saved requests");
    });
    try {
      expect(parseDiscussionRun(mutable(run))).toEqual(run);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });
  it("persists failed host checks and rejects omission on finalization after restart", () => {
    let run = checkpoint(undefined, true);
    const protocol = currentDiscussionSegment(run).protocol;
    const check: ConstraintCheck = {
      checkId: "constraint-failed",
      source: "host",
      contextHash: discussionConstraintContextHash(protocol),
      answerVersionId: null,
      status: "failed",
      evidence: "Known global counterexample"
    };
    run = add(run, { type: "constraints_checked", atMs: 0, checks: [check] });
    run = parseDiscussionRun(mutable(run));
    expect(currentDiscussionConstraintChecks(currentDiscussionSegment(run))).toEqual([check]);
    expect(() => add(run, { type: "finalized", atMs: 0, stopReason: "round_limit" })).toThrow(/persisted constraint/);
    expect(() =>
      add(run, { type: "finalized", atMs: 0, stopReason: "round_limit", constraintChecks: [check] })
    ).toThrow(/incomplete/);
    run = add(run, { type: "paused", atMs: 0, code: "constraint_failed", message: "Known failure" });
    run = add(parseDiscussionRun(mutable(run)), { type: "resumed", atMs: 0 });
    expect(() => add(run, { type: "finalized", atMs: 0, stopReason: "round_limit" })).toThrow(/persisted constraint/);
  });
  it("never overwrites an existing check ID and accepts identical redundant evidence", () => {
    let run = checkpoint();
    const check: ConstraintCheck = {
      checkId: "stable",
      source: "host",
      contextHash: discussionConstraintContextHash(currentDiscussionSegment(run).protocol),
      answerVersionId: null,
      status: "failed",
      evidence: "Counterexample"
    };
    run = add(run, { type: "constraints_checked", atMs: 0, checks: [check] });
    expect(() => add(run, { type: "constraints_checked", atMs: 0, checks: [{ ...check, status: "passed" }] })).toThrow(
      /immutable/
    );
    run = add(run, { type: "constraints_checked", atMs: 0, checks: [check] });
    expect(currentDiscussionSegment(run).constraintChecks).toEqual([check]);
    const reserved = add(run, { type: "reserve_review", atMs: 0, reservationId: "r-next" });
    expect(() => add(reserved, { type: "resume_review", atMs: 0 })).toThrow(/global constraint/);
  });
  it("keeps old answer-specific failed evidence historical without transferring it to new answers", () => {
    let run = checkpoint({ effort: "standard" }, true);
    const protocol = currentDiscussionSegment(run).protocol,
      oldId = protocol.reviewEpochs.at(-1)!.answerVersions[0]!.answerVersionId;
    const check: ConstraintCheck = {
      checkId: "old-answer",
      source: "host",
      contextHash: discussionConstraintContextHash(protocol),
      answerVersionId: oldId,
      status: "failed",
      evidence: "This exact saved answer fails"
    };
    run = add(run, { type: "constraints_checked", atMs: 0, checks: [check] });
    run = add(run, { type: "reserve_review", atMs: 0, reservationId: "r-next" });
    run = add(run, { type: "resume_review", atMs: 0 });
    run = settleAll(prepared(run));
    expect(currentDiscussionSegment(run).constraintChecks).toEqual([check]);
    expect(currentDiscussionConstraintChecks(currentDiscussionSegment(run))).toEqual([]);
    run = add(run, { type: "review_started", atMs: 0 });
    run = settleAll(prepared(run));
    expect(add(run, { type: "finalized", atMs: 0, stopReason: "checkpoint" }).status).toBe("completed");
    expect(parseDiscussionRun(mutable(run))).toEqual(run);
  });
  it("rejects host evidence with stale scope and evidence submitted before a complete review", () => {
    const run = checkpoint();
    const check: ConstraintCheck = {
      checkId: "stale",
      source: "host",
      contextHash: "old-context",
      answerVersionId: null,
      status: "failed",
      evidence: "Old scope"
    };
    expect(() => add(run, { type: "constraints_checked", atMs: 0, checks: [check] })).toThrow();
    expect(() => add(createDiscussionRun(input(), 0), { type: "constraints_checked", atMs: 0, checks: [] })).toThrow(
      /complete review/
    );
  });
});
