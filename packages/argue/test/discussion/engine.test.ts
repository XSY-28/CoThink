import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DiscussionEngine,
  type DiscussionRunStore,
  type DiscussionEngineOptions
} from "../../src/discussion/engine.js";
import {
  createDiscussionRun,
  appendDiscussionRunEvent,
  parseDiscussionRun,
  validateDiscussionRunTransition,
  currentDiscussionSegment,
  type DiscussionRun,
  type DiscussionRunInput
} from "../../src/discussion/store.js";
import { JsonDiscussionCodec } from "../../src/discussion/json-codec.js";
import { type ModelCall, type ModelReply, type ModelTransport } from "../../src/transport/contracts.js";
import { openingTurn, exchangeTurn, reviewTurn } from "./stage2-fixtures.js";
import { discussionConstraintContextHash, type ConstraintCheck } from "../../src/discussion/result.js";

const config = (member: string) => ({
  protocol: "openai",
  baseUrl: "https://offline.invalid",
  modelId: member,
  apiKeyEnv: "UNSET_OFFLINE_KEY",
  outputMode: "json_object" as const,
  generationOptions: {}
});
const input = (policy: unknown = { effort: "standard" }): DiscussionRunInput => ({
  sessionId: "engine-test",
  question: "Which proposal?",
  members: { a: config("a"), b: config("b") },
  policy
});
class MemoryStore implements DiscussionRunStore {
  state?: DiscussionRun;
  fail?: (next: DiscussionRun) => boolean;
  async load() {
    if (!this.state) throw new Error("missing");
    return parseDiscussionRun(this.state);
  }
  async commit(revision: number, next: DiscussionRun) {
    if (revision !== (this.state?.revision ?? -1) || this.fail?.(next)) throw new Error("CAS conflict");
    validateDiscussionRunTransition(next, this.state);
    this.state = parseDiscussionRun(JSON.parse(JSON.stringify(next)));
    // Disk commits yield to I/O; this simulator must also service worker RPC.
    await yieldToEventLoop();
  }
}
function harness(options: DiscussionEngineOptions = {}, policy?: unknown) {
  const store = new MemoryStore(),
    calls: ModelCall[] = [];
  let split = false;
  const valid = (call: ModelCall): ModelReply => {
    const state = currentDiscussionSegment(store.state!).protocol;
    let payload =
      state.phase === "opening"
        ? { ...openingTurn(), complexity: "complex" as const }
        : state.phase === "discussion"
          ? exchangeTurn(state, call.modelId)
          : reviewTurn(state, call.modelId);
    if (split && payload.phase === "review")
      payload = {
        ...payload,
        positions: payload.positions.map((position) => ({ ...position, stance: "reject" as const }))
      };
    return {
      rawContent: JSON.stringify(payload),
      payload: { ignored: "transport cannot bypass codec" },
      modelId: call.modelId,
      protocol: call.protocol,
      generationOptions: call.generationOptions,
      usage: { outputTokens: 30 },
      finishReason: "stop"
    };
  };
  let behavior: (call: ModelCall, signal: AbortSignal) => Promise<ModelReply> = async (call) => valid(call);
  const transport: ModelTransport = {
    respond: vi.fn(async (call, signal) => {
      const segment = currentDiscussionSegment(store.state!);
      const job = segment.jobs.find(
        (item) => segment.currentBatch!.jobIds.includes(item.jobId) && item.memberId === call.modelId
      )!;
      expect(call).toEqual(job.call);
      expect(segment.ledger.attempts.at(-1)?.status).toBe("pending");
      expect(segment.attemptLinks.some((link) => link.jobId === job.jobId)).toBe(true);
      calls.push(structuredClone(call));
      return behavior(call, signal);
    })
  };
  const engine = new DiscussionEngine(store, transport, { now: () => 0, ...options });
  return {
    store,
    calls,
    engine,
    transport,
    valid,
    input: input(policy),
    divide: () => {
      split = true;
    },
    behave: (next: typeof behavior) => {
      behavior = next;
    }
  };
}
describe("DiscussionEngine offline scheduling", () => {
  it("allows the supervisor event loop to progress between durable commits", async () => {
    const h = harness();
    let callsAtSupervisorTick = -1;
    const supervisor = yieldToEventLoop().then(() => {
      callsAtSupervisorTick = h.calls.length;
    });
    const result = await h.engine.start(h.input);
    await supervisor;
    expect(result.status).toBe("completed");
    expect(h.calls).toHaveLength(6);
    expect(callsAtSupervisorTick).toBeLessThan(6);
  });
  it("first checkpoint consensus dispatches exactly six frozen calls and restarts return the same result", async () => {
    const h = harness();
    const run = await h.engine.start(h.input),
      segment = currentDiscussionSegment(run);
    expect(h.calls).toHaveLength(6);
    expect(segment.stopReason).toBe("checkpoint");
    expect(segment.finalResult?.outcome).toBe("consensus");
    expect(segment.protocol.committedBatches.map((batch) => batch.phase)).toEqual(["opening", "discussion", "review"]);
    expect(segment.finalResult?.answer).toBe(
      segment.protocol.answerVersions.find(
        (answer) => answer.answerVersionId === segment.finalResult?.selectedAnswerVersionIds[0]
      )?.body
    );
    expect(await h.engine.run(run.sessionId)).toEqual(run);
    expect(await h.engine.retry(run.sessionId)).toEqual(run);
    expect(h.calls).toHaveLength(6);
  });
  it("four disagreeing rounds dispatch eighteen calls and select the highest decision weight latest answer", async () => {
    const h = harness(
      {},
      {
        effort: "standard",
        weights: { a: { participationWeight: 1, decisionWeight: 2 }, b: { participationWeight: 1, decisionWeight: 1 } }
      }
    );
    h.divide();
    const segment = currentDiscussionSegment(await h.engine.start(h.input));
    expect(h.calls).toHaveLength(18);
    expect(segment.protocol.reviewEpochs).toHaveLength(4);
    expect(segment.stopReason).toBe("round_limit");
    expect(segment.finalResult?.outcome).toBe("weighted_fallback");
    expect(segment.finalResult?.answer).toBe("Answer a at round 4");
    expect(segment.ledger.attempts).toHaveLength(18);
  }, 60_000);
  it("a failed half batch stays sealed; explicit retry only asks the missing member with its original request", async () => {
    let first = true;
    const codec = new JsonDiscussionCodec(),
      encode = vi.spyOn(codec, "encode");
    const h = harness({ codec });
    h.behave(async (call) => {
      if (call.modelId === "a" && first) {
        first = false;
        throw new Error("offline failure");
      }
      return h.valid(call);
    });
    const paused = await h.engine.start(h.input),
      old = currentDiscussionSegment(paused);
    expect(paused.status).toBe("paused");
    expect(old.protocol.answerVersions).toHaveLength(0);
    expect(old.seals).toHaveLength(1);
    const openingEncodes = encode.mock.calls.filter(([snapshot]) => snapshot.phase === "opening").length;
    expect(openingEncodes).toBe(2);
    const resumed = await h.engine.retry(paused.sessionId);
    expect(resumed.status).toBe("completed");
    expect(h.calls).toHaveLength(7);
    expect(h.calls[2]).toEqual(h.calls[0]);
    expect(encode.mock.calls.filter(([snapshot]) => snapshot.phase === "opening")).toHaveLength(2);
    const segment = currentDiscussionSegment(resumed);
    expect(segment.ledger.attempts[0]?.status).toBe("failed");
    expect(segment.jobs).toHaveLength(6);
    expect(segment.ledger.attempts).toHaveLength(7);
  });
  it("prepared crash recovery uses zero calls, counts unknowns, and requires a second explicit retry", async () => {
    const h = harness();
    h.store.fail = (run) => run.events.at(-1)?.type === "settled";
    await expect(h.engine.start(h.input)).rejects.toThrow("CAS conflict");
    expect(h.calls).toHaveLength(2);
    h.store.fail = undefined;
    const paused = await h.engine.retry(h.input.sessionId);
    expect(paused.status).toBe("paused");
    expect(h.calls).toHaveLength(2);
    expect(currentDiscussionSegment(paused).ledger.attempts.map((attempt) => attempt.status)).toEqual([
      "unknown",
      "unknown"
    ]);
    const result = await h.engine.retry(h.input.sessionId);
    expect(result.status).toBe("completed");
    expect(h.calls).toHaveLength(8);
    expect(
      currentDiscussionSegment(result)
        .ledger.attempts.slice(0, 2)
        .every((attempt) => attempt.status === "unknown")
    ).toBe(true);
  });
  it("even a crash after atomic batch commit recovers without dispatch", async () => {
    const h = harness();
    h.store.fail = (run) =>
      run.events.at(-1)?.type === "reserve_review" && currentDiscussionSegment(run).protocol.roundIndex === 1;
    await expect(h.engine.start(h.input)).rejects.toThrow("CAS conflict");
    expect(currentDiscussionSegment(h.store.state!).protocol.committedBatches).toHaveLength(1);
    const before = h.calls.length;
    expect((await h.engine.run(h.input.sessionId)).status).toBe("paused");
    expect(h.calls).toHaveLength(before);
  });
  it("interruption immediately after prepared persists charged cancellations before any dispatch", async () => {
    const controller = new AbortController();
    const h = harness({
      onSaved: (_state, event) => {
        if (event.type === "prepared") controller.abort();
      }
    });
    const result = await h.engine.start(h.input, controller.signal),
      segment = currentDiscussionSegment(result);
    expect(h.calls).toHaveLength(0);
    expect(result.status).toBe("paused");
    expect(segment.pauseReason?.code).toBe("cancelled");
    expect(segment.ledger.attempts.map((attempt) => attempt.status)).toEqual(["cancelled", "cancelled"]);
    expect(segment.finalResult).toBeUndefined();
  });
  it("SIGINT-like abort ends in-flight calls, rejects late responses and never rewrites the paused snapshot", async () => {
    const controller = new AbortController(),
      deferred: Array<(reply: ModelReply) => void> = [];
    const h = harness();
    h.behave(
      (call) =>
        new Promise((resolve) => {
          deferred.push(resolve);
          if (call.modelId === "b") controller.abort(new Error("SIGINT"));
        })
    );
    const result = await h.engine.start(h.input, controller.signal),
      bytes = JSON.stringify(h.store.state);
    expect(result.status).toBe("paused");
    expect(h.calls).toHaveLength(2);
    expect(currentDiscussionSegment(result).finalResult).toBeUndefined();
    deferred.forEach((resolve, index) => resolve(h.valid(h.calls[index]!)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.stringify(h.store.state)).toBe(bytes);
    expect(currentDiscussionSegment(result).ledger.attempts.map((attempt) => attempt.status)).toEqual([
      "cancelled",
      "cancelled"
    ]);
  });
  it("fake clock rejects a response at its hard deadline without refunds or normal fallback", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    h.behave(async (call) => {
      const reply = h.valid(call);
      now = currentDiscussionSegment(h.store.state!).ledger.attempts[0]!.deadlineAtMs;
      return reply;
    });
    const run = await h.engine.start(h.input),
      segment = currentDiscussionSegment(run);
    expect(run.status).toBe("paused");
    expect(segment.finalResult).toBeUndefined();
    expect(segment.ledger.attempts).toHaveLength(2);
    expect(segment.ledger.attempts.every((attempt) => attempt.status !== "succeeded")).toBe(true);
  });
  it("invalid and truncated replies preserve billed observations but never commit", async () => {
    const h = harness();
    h.behave(async (call) => ({ ...h.valid(call), finishReason: "length" }));
    const segment = currentDiscussionSegment(await h.engine.start(h.input));
    expect(segment.protocol.committedBatches).toHaveLength(0);
    expect(segment.observations).toHaveLength(2);
    expect(segment.observations.every((item) => item.runtime?.usage.outputTokens === 30)).toBe(true);
    expect(segment.ledger.attempts.every((item) => item.status === "failed")).toBe(true);
  });
  it("observer failures are isolated from scheduling and persisted results", async () => {
    const h = harness({
      onSaved: () => {
        throw new Error("observer failed");
      }
    });
    expect((await h.engine.start(h.input)).status).toBe("completed");
    expect(h.calls).toHaveLength(6);
    const asyncH = harness({
      onSaved: async () => {
        throw new Error("observer rejected");
      }
    });
    expect((await asyncH.engine.start(asyncH.input)).status).toBe("completed");
    expect(asyncH.calls).toHaveLength(6);
  });
  it("a conflict while preparing prevents dispatch and a final-result conflict never becomes constraint_failed", async () => {
    const h = harness();
    h.store.fail = (run) => run.events.at(-1)?.type === "prepared";
    await expect(h.engine.start(h.input)).rejects.toThrow("CAS conflict");
    expect(h.calls).toHaveLength(0);
    const final = harness();
    final.divide();
    final.store.fail = (run) => run.events.at(-1)?.type === "finalized";
    await expect(final.engine.start({ ...final.input, policy: { effort: "standard", maxRounds: 1 } })).rejects.toThrow(
      "CAS conflict"
    );
    expect(final.store.state?.status).toBe("active");
    expect(currentDiscussionSegment(final.store.state!).finalResult).toBeUndefined();
  });
  it("budget exhaustion after full review is an actual normal stop", async () => {
    const h = harness({}, { effort: "standard", maxCalls: 6 });
    h.divide();
    const segment = currentDiscussionSegment(await h.engine.start(h.input));
    expect(h.calls).toHaveLength(6);
    expect(segment.stopReason).toBe("budget_limit");
    expect(segment.finalResult?.outcome).toBe("tied_preferences");
  });
  it("insufficient initial budget cannot discard a member; explicit extension appends capacity only", async () => {
    const h = harness({}, { effort: "standard", maxCalls: 1 });
    const paused = await h.engine.start(h.input);
    expect(h.calls).toHaveLength(0);
    expect(paused.status).toBe("paused");
    const frozenPolicy = currentDiscussionSegment(paused).protocol.policy;
    const complete = await h.engine.retry(h.input.sessionId, { extraCalls: 5 });
    expect(complete.status).toBe("completed");
    expect(h.calls).toHaveLength(6);
    expect(currentDiscussionSegment(complete).protocol.policy).toEqual(frozenPolicy);
    expect(currentDiscussionSegment(complete).ledger.extensions).toHaveLength(1);
  });
  it("invalid explicit budget extensions are rejected even for NaN", async () => {
    const h = harness({}, { effort: "standard", maxCalls: 1 });
    await h.engine.start(h.input);
    await expect(h.engine.retry(h.input.sessionId, { extraCalls: NaN })).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
  it("continue freezes a new segment and preserves the prior result, jobs, policy and weights", async () => {
    const h = harness();
    const first = await h.engine.start(h.input),
      old = currentDiscussionSegment(first);
    const next = await h.engine.continue(h.input.sessionId, {
      note: "New copied evidence",
      policy: {
        effort: "low",
        weights: { a: { participationWeight: 1, decisionWeight: 1 }, b: { participationWeight: 2, decisionWeight: 3 } }
      },
      members: { a: { ...config("a"), generationOptions: { temperature: 0 } }, b: config("b") }
    });
    expect(h.calls).toHaveLength(12);
    expect(next.segments[0]).toEqual(old);
    expect(next.currentSegmentId).toBe(2);
    const segment = currentDiscussionSegment(next);
    expect(segment.protocol.sources.at(-1)?.content).toBe("New copied evidence");
    expect(segment.protocol.contextVersion).toBe(2);
    expect(segment.members.a?.generationOptions).toEqual({ temperature: 0 });
    expect(segment.protocol.policy.weights.b?.decisionWeight).toBe(3);
    expect(old.protocol.policy.weights.b?.decisionWeight).toBe(1);
    expect(h.calls[9]!.maxOutputTokens).toBeGreaterThan(h.calls[8]!.maxOutputTokens);
    expect(await h.engine.run(h.input.sessionId)).toEqual(next);
    expect(h.calls).toHaveLength(12);
  }, 20_000);
  it("known constraint failure cannot be presented as normal completion", async () => {
    const checks: ConstraintCheck[] = [];
    const h = harness({
      onSaved: (state, event) => {
        if (event.type === "commit_batch" && currentDiscussionSegment(state).protocol.phase === "review") {
          checks.push({
            checkId: "local-check",
            source: "host",
            contextHash: discussionConstraintContextHash(currentDiscussionSegment(state).protocol),
            answerVersionId: null,
            status: "failed",
            evidence: "A known constraint fails"
          });
        }
      },
      constraintChecks: checks
    });
    const result = await h.engine.start(h.input);
    expect(result.status).toBe("paused");
    expect(currentDiscussionSegment(result).pauseReason?.code).toBe("constraint_failed");
    expect(currentDiscussionSegment(result).finalResult).toBeUndefined();
    expect(h.calls).toHaveLength(6);
    expect(currentDiscussionSegment(result).constraintChecks).toEqual(checks);
    const restarted = new DiscussionEngine(h.store, h.transport, { now: () => 1 });
    const retried = await restarted.retry(h.input.sessionId);
    expect(retried.status).toBe("paused");
    expect(currentDiscussionSegment(retried).pauseReason?.code).toBe("constraint_failed");
    expect(currentDiscussionSegment(retried).finalResult).toBeUndefined();
    expect(h.calls).toHaveLength(6);
  });
  it("illegal runtime versions and incompatible codecs are refused with zero calls", async () => {
    const h = harness();
    const state = createDiscussionRun(h.input, 0);
    h.store.state = { ...state, runtimeVersion: "bad" } as unknown as DiscussionRun;
    await expect(h.engine.run(h.input.sessionId)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    const codec = new JsonDiscussionCodec();
    Object.defineProperty(codec, "codecVersion", { value: "bad" });
    const incompatible = harness({ codec });
    await expect(incompatible.engine.start(incompatible.input)).rejects.toThrow("Codec");
    expect(incompatible.calls).toHaveLength(0);
  });
  it("pre-aborted start persists a paused segment without model calls", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    const run = await h.engine.start(h.input, controller.signal);
    expect(run.status).toBe("paused");
    expect(h.calls).toHaveLength(0);
  });
  it("a recovery with no pending attempt still pauses before further calls", async () => {
    const h = harness();
    h.store.state = appendDiscussionRunEvent(createDiscussionRun(h.input, 0), {
      type: "reserve_review",
      atMs: 0,
      reservationId: "saved"
    });
    expect((await h.engine.recover(h.input.sessionId)).status).toBe("paused");
    expect(h.calls).toHaveLength(0);
  });
  it("uses reserved full review when another exchange cannot fit, even when members are not ready", async () => {
    const h = harness({}, { effort: "standard", maxCalls: 6 });
    h.divide();
    h.behave(async (call) => {
      const reply = h.valid(call);
      const payload = JSON.parse(reply.rawContent);
      if (payload.phase === "discussion") payload.readyToReview = false;
      return { ...reply, rawContent: JSON.stringify(payload) };
    });
    const segment = currentDiscussionSegment(await h.engine.start(h.input));
    expect(h.calls).toHaveLength(6);
    expect(segment.stopReason).toBe("budget_limit");
    expect(segment.protocol.reviewEpochs).toHaveLength(1);
  });
  it("retry after a committed exchange rechecks readiness and the round limit before preparing any job", async () => {
    const h = harness({}, { effort: "standard", maxRounds: 1 });
    h.store.fail = (run) => run.events.at(-1)?.type === "review_started";
    await expect(h.engine.start(h.input)).rejects.toThrow("CAS conflict");
    expect(h.calls).toHaveLength(4);
    h.store.fail = undefined;
    await h.engine.recover(h.input.sessionId);
    expect(h.calls).toHaveLength(4);
    const result = await h.engine.retry(h.input.sessionId);
    expect(result.status).toBe("completed");
    expect(h.calls).toHaveLength(6);
    expect(currentDiscussionSegment(result).protocol.reviewEpochs).toHaveLength(1);
  });
  it("reuses a saved next-review reservation after a crash before review resume", async () => {
    const h = harness({}, { effort: "standard", maxRounds: 2 });
    h.divide();
    h.store.fail = (run) => run.events.at(-1)?.type === "resume_review";
    await expect(h.engine.start(h.input)).rejects.toThrow("CAS conflict");
    expect(h.calls).toHaveLength(6);
    const reservations = currentDiscussionSegment(h.store.state!).ledger.reservations.length;
    h.store.fail = undefined;
    await h.engine.recover(h.input.sessionId);
    const result = await h.engine.retry(h.input.sessionId);
    expect(result.status).toBe("completed");
    expect(h.calls).toHaveLength(10);
    expect(currentDiscussionSegment(result).ledger.reservations).toHaveLength(reservations);
  }, 20_000);
  it("same-batch shared semantics do not change with member weight or identity", async () => {
    const h = harness(
      {},
      {
        effort: "standard",
        weights: { a: { participationWeight: 2, decisionWeight: 1 }, b: { participationWeight: 1, decisionWeight: 5 } }
      }
    );
    await h.engine.start(h.input);
    for (let i = 0; i < 6; i += 2) expect(h.calls[i]!.messages[1]!.content).toBe(h.calls[i + 1]!.messages[1]!.content);
    expect(h.calls[2]!.maxOutputTokens).toBeGreaterThan(h.calls[3]!.maxOutputTokens);
  });
  it("a hard call timer pauses an unresponsive transport without a normal final result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const h = harness({ now: () => Date.now() }, { effort: "standard", callTimeoutMs: 100, maxDurationMs: 1000 });
      h.behave(() => new Promise(() => {}));
      const running = h.engine.start(h.input);
      for (let i = 0; i < 100 && h.calls.length < 2; i++) await yieldToEventLoop();
      expect(h.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100);
      const result = await running,
        segment = currentDiscussionSegment(result);
      expect(result.status).toBe("paused");
      expect(segment.finalResult).toBeUndefined();
      expect(segment.ledger.attempts.map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
      expect(segment.observations.every((item) => item.error?.message === "Call deadline reached")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
