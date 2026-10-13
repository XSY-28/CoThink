import { describe, expect, it, vi } from "vitest";
import {
  buildMemberRequest,
  PeerSessionDriver,
  PeerRuntimeFailure,
  type MemberId,
  type MemberRequest,
  type MemberRuntime,
  type PeerSession,
  type PeerStore,
  type RuntimeReply
} from "../../src/index.js";
import { makeOpeningTurn, makeSession } from "./fixtures.js";

const NOW = "2026-10-13T00:00:01.000Z";
const later = "2026-10-13T00:20:00.000Z";
class MemoryStore implements PeerStore {
  constructor(
    public state: PeerSession,
    public failAt = -1
  ) {}
  writes = 0;
  async load(id: string) {
    if (id !== this.state.config.sessionId) throw new Error("unknown session");
    return structuredClone(this.state);
  }
  async commit(revision: number, next: PeerSession) {
    if (++this.writes === this.failAt) throw new Error("disk write failed");
    if (revision !== this.state.revision || next.revision !== revision + 1) throw new Error("revision conflict");
    this.state = structuredClone(next);
  }
}
const reply = (request: MemberRequest, payload: unknown): RuntimeReply => ({
  payload,
  rawContent: JSON.stringify(payload),
  modelId: request.modelId,
  protocol: request.protocol,
  generationOptions: request.generationOptions,
  usage: { inputTokens: 12, outputTokens: 7 },
  finishReason: "stop"
});
const opening = (id: MemberId) =>
  makeOpeningTurn([{ statement: id, rationale: "Reason", assumptions: [], sourceRefs: [] }]);
const runtimes = (respond: (request: MemberRequest, signal: AbortSignal) => Promise<RuntimeReply>) =>
  ({
    "member-a": { respond },
    "member-b": { respond }
  }) satisfies Record<MemberId, MemberRuntime>;
const makeDriver = (
  store: PeerStore,
  respond: (request: MemberRequest, signal: AbortSignal) => Promise<RuntimeReply>
) => new PeerSessionDriver(store, runtimes(respond), { now: () => new Date(NOW) });

describe("PeerSessionDriver", () => {
  it("recovers an active snapshot between commits into a durable pause without calls", async () => {
    const store = new MemoryStore(makeSession());
    let calls = 0;
    const driver = makeDriver(store, async (request) => {
      calls++;
      return reply(request, opening(request.memberId));
    });
    const recovered = await driver.recover(store.state.config.sessionId);
    expect(recovered.status).toBe("paused");
    expect(recovered.pauseReason?.code).toBe("recovered_interrupted");
    expect(recovered.revision).toBe(1);
    expect(recovered.attempts).toHaveLength(0);
    expect(calls).toBe(0);
  });
  it("durably records both attempts before dispatch and seals the first answer without advancing", async () => {
    const store = new MemoryStore(makeSession());
    let releaseB!: (value: RuntimeReply) => void;
    const pendingB = new Promise<RuntimeReply>((resolve) => {
      releaseB = resolve;
    });
    let enteredB!: () => void;
    const bEntered = new Promise<void>((resolve) => {
      enteredB = resolve;
    });
    const seen: MemberRequest[] = [];
    const driver = makeDriver(store, async (request) => {
      seen.push(request);
      expect(store.state.attempts).toHaveLength(2);
      expect(store.state.attempts.every((attempt) => attempt.status === "running")).toBe(true);
      if (request.memberId === "member-b") {
        enteredB();
        return pendingB;
      }
      return reply(request, opening(request.memberId));
    });
    const running = driver.run(store.state.config.sessionId);
    await bEntered;
    for (let i = 0; i < 20 && store.state.jobs.find((job) => job.memberId === "member-a")?.status !== "sealed"; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state.jobs.find((job) => job.memberId === "member-a")?.status).toBe("sealed");
    expect(store.state.rounds).toHaveLength(0);
    expect(seen[0]?.sharedContext).toEqual(seen[1]?.sharedContext);
    releaseB(reply(seen.find((request) => request.memberId === "member-b")!, opening("member-b")));
    const state = await running;
    expect(state.rounds.length).toBeGreaterThan(0);
    expect(state.claimVersions.map((claim) => claim.authorId)).toEqual(["member-a", "member-b"]);
  });

  it("pauses on a structured failure, preserves the other seal, and retries only the missing member with its original hash", async () => {
    const initial = makeSession({ phase: "review" });
    const store = new MemoryStore(initial);
    const calls: MemberRequest[] = [];
    const driver = makeDriver(store, async (request) => {
      calls.push(request);
      if (request.memberId === "member-b" && calls.filter((call) => call.memberId === "member-b").length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new PeerRuntimeFailure(
          { code: "malformed", message: "bad JSON", retryable: true },
          {
            rawContent: "{bad",
            runtime: {
              modelId: request.modelId,
              protocol: request.protocol,
              generationOptions: request.generationOptions,
              usage: { outputTokens: 9 },
              finishReason: "stop"
            }
          }
        );
      }
      return reply(request, {
        phase: "review",
        reviewSetHash: initial.segments[0]!.reviewSetHash,
        positions: initial.segments[0]!.reviewVersions.map((versionId) => ({
          versionId,
          stance: "uncertain",
          rationale: "Unclear",
          sourceRefs: []
        })),
        conclusion: "Unclear",
        evidenceRequests: []
      });
    });
    const paused = await driver.run(initial.config.sessionId);
    expect(paused.status).toBe("paused");
    expect(paused.rounds.filter((round) => round.phase === "review")).toHaveLength(0);
    expect(paused.jobs.find((job) => job.memberId === "member-a")?.status).toBe("sealed");
    expect(paused.attempts.find((attempt) => attempt.memberId === "member-b")?.rawContent).toBe("{bad");
    expect(paused.attempts.find((attempt) => attempt.memberId === "member-b")?.runtime?.usage).toEqual({
      outputTokens: 9
    });
    const originalHash = calls.find((request) => request.memberId === "member-b")!.inputHash;
    const completed = await driver.retry(initial.config.sessionId);
    expect(completed.status).toBe("completed");
    expect(calls.filter((request) => request.memberId === "member-a")).toHaveLength(1);
    expect(calls.filter((request) => request.memberId === "member-b").map((request) => request.inputHash)).toEqual([
      originalHash,
      originalHash
    ]);
  });

  it("marks a recovered running attempt unknown without dispatching and requires explicit retry", async () => {
    const initial = makeSession();
    const request = (await import("../../src/index.js")).buildMemberRequest(initial, "member-a");
    initial.jobs.push({
      jobId: request.jobId,
      memberId: "member-a",
      segmentId: 1,
      roundIndex: 0,
      phase: "opening",
      snapshotId: request.snapshotId,
      inputHash: request.inputHash,
      status: "running",
      activeAttemptId: "old",
      frozenInput: {
        messages: request.messages,
        outputSchema: request.outputSchema,
        outputMode: request.outputMode,
        maxOutputTokens: request.maxOutputTokens,
        modelId: request.modelId,
        protocol: request.protocol,
        baseUrl: request.baseUrl,
        apiKeyEnv: request.apiKeyEnv,
        generationOptions: request.generationOptions
      }
    });
    initial.attempts.push({
      jobId: request.jobId,
      attemptId: "old",
      inputHash: request.inputHash,
      memberId: "member-a",
      status: "running",
      startedAt: NOW,
      deadline: later,
      acceptance: "active",
      cancellation: "none"
    });
    const store = new MemoryStore(initial);
    const calls: MemberRequest[] = [];
    const driver = makeDriver(store, async (req) => {
      calls.push(req);
      return reply(req, opening(req.memberId));
    });
    const recovered = await driver.run(initial.config.sessionId);
    expect(recovered.status).toBe("paused");
    expect(recovered.attempts[0]?.status).toBe("unknown");
    expect(calls).toHaveLength(0);
  });

  it("refuses to dispatch if the durable intent write fails", async () => {
    const store = new MemoryStore(makeSession(), 1);
    let calls = 0;
    const driver = makeDriver(store, async (request) => {
      calls++;
      return reply(request, opening(request.memberId));
    });
    await expect(driver.run(store.state.config.sessionId)).rejects.toThrow(/disk write failed/);
    expect(calls).toBe(0);
    expect(store.state.attempts).toHaveLength(0);
  });

  it("aborts outstanding work when a result commit fails and exposes no unsaved seal", async () => {
    const store = new MemoryStore(makeSession(), 2);
    let cancelled = false;
    const driver = makeDriver(store, async (request, signal) => {
      if (request.memberId === "member-a") return reply(request, opening("member-a"));
      return new Promise<RuntimeReply>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new Error("aborted"));
          },
          { once: true }
        )
      );
    });
    await expect(driver.run(store.state.config.sessionId)).rejects.toThrow(/disk write failed/);
    expect(cancelled).toBe(true);
    expect(store.state.attempts).toHaveLength(2);
    expect(store.state.jobs.every((job) => job.status === "running")).toBe(true);
    expect(store.state.rounds).toHaveLength(0);
  });

  it("records cancellation of the paired call after startup failure", async () => {
    const store = new MemoryStore(makeSession());
    const driver = makeDriver(store, async (request) => {
      if (request.memberId === "member-a") throw new Error("startup failed");
      return new Promise<RuntimeReply>(() => {});
    });
    const paused = await driver.run(store.state.config.sessionId);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason?.message).toContain("startup failed");
    expect(paused.attempts.find((attempt) => attempt.memberId === "member-b")?.status).toBe("cancelled");
    expect(paused.attempts.find((attempt) => attempt.memberId === "member-b")?.cancellation).toBe("requested");
  });

  it("preserves observed usage and raw content when an HTTP-success reply fails protocol validation", async () => {
    const store = new MemoryStore(makeSession());
    const driver = makeDriver(store, async (request) => {
      if (request.memberId === "member-b") await new Promise((resolve) => setTimeout(resolve, 0));
      return reply(
        request,
        request.memberId === "member-a" ? opening("member-a") : { phase: "opening", claims: "not-an-array" }
      );
    });
    const state = await driver.run(store.state.config.sessionId);
    const invalid = state.attempts.find((attempt) => attempt.memberId === "member-b")!;
    expect(state.status).toBe("paused");
    expect(invalid.status).toBe("invalid");
    expect(invalid.runtime?.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(invalid.rawContent).toContain("not-an-array");
  });

  it("invalidates a timed-out attempt before a signal-ignoring late response can be committed", async () => {
    vi.useFakeTimers();
    try {
      const initial = makeSession();
      initial.config.limits.callTimeoutMs = 20;
      const store = new MemoryStore(initial);
      let release!: (value: RuntimeReply) => void;
      const pending = new Promise<RuntimeReply>((resolve) => {
        release = resolve;
      });
      let bRequest!: MemberRequest;
      const driver = makeDriver(store, async (request) => {
        if (request.memberId === "member-a") return reply(request, opening("member-a"));
        bRequest = request;
        return pending;
      });
      const running = driver.run(initial.config.sessionId);
      await vi.advanceTimersByTimeAsync(20);
      const paused = await running;
      expect(paused.status).toBe("paused");
      expect(paused.attempts.find((attempt) => attempt.memberId === "member-b")?.acceptance).toBe("invalidated");
      const savedRevision = store.state.revision;
      release(reply(bRequest, opening("member-b")));
      await Promise.resolve();
      expect(store.state.revision).toBe(savedRevision);
      expect(store.state.rounds).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend the last available call on only one peer", async () => {
    const initial = makeSession();
    initial.segments[0]!.maxCalls = 1;
    const store = new MemoryStore(initial);
    let calls = 0;
    const driver = makeDriver(store, async (request) => {
      calls++;
      return reply(request, opening(request.memberId));
    });
    const paused = await driver.run(initial.config.sessionId);
    expect(paused.pauseReason?.code).toBe("call_budget");
    expect(calls).toBe(0);
    expect(paused.attempts).toHaveLength(0);
  });

  it("durably pauses when accumulated round history exceeds the shared input cap", async () => {
    const initial = makeSession();
    const openingSize = buildMemberRequest(initial, "member-a").messages.reduce(
      (size, message) => size + message.content.length,
      0
    );
    initial.config.limits.maxInputCharacters = openingSize + 10;
    const store = new MemoryStore(initial);
    const calls: MemberRequest[] = [];
    const driver = makeDriver(store, async (request) => {
      calls.push(request);
      return reply(request, opening(request.memberId));
    });
    const paused = await driver.run(initial.config.sessionId);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason?.code).toBe("input_limit");
    expect(paused.rounds).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect((await store.load(initial.config.sessionId)).status).toBe("paused");
  });

  it("drains delayed writes after malformed usage while preserving valid observed fields", async () => {
    const initial = makeSession();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commitEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    class DelayedStore extends MemoryStore {
      override async commit(revision: number, next: PeerSession) {
        if (revision === 1) {
          entered();
          await gate;
        }
        return super.commit(revision, next);
      }
    }
    const store = new DelayedStore(initial);
    let returned = false;
    const driver = makeDriver(store, async (request) => {
      if (request.memberId === "member-a") return new Promise<RuntimeReply>(() => {});
      return { ...reply(request, opening("member-b")), usage: { inputTokens: 12, outputTokens: -1 } };
    });
    const running = driver.run(initial.config.sessionId).finally(() => {
      returned = true;
    });
    await commitEntered;
    expect(returned).toBe(false);
    release();
    const paused = await running;
    expect(paused.status).toBe("paused");
    const invalid = paused.attempts.find((attempt) => attempt.memberId === "member-b")!;
    expect(invalid.status).toBe("invalid");
    expect(invalid.runtime?.usage).toEqual({ inputTokens: 12 });
    expect(invalid.rawContent).toContain("opening");
    expect(paused.attempts.every((attempt) => attempt.status !== "running" && attempt.acceptance !== "active")).toBe(
      true
    );
    const writesAtReturn = store.writes;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.writes).toBe(writesAtReturn);
  });

  it("rejects a response that arrives at the deadline even if the timer callback has not run", async () => {
    const initial = makeSession();
    initial.config.limits.callTimeoutMs = 20;
    const store = new MemoryStore(initial);
    let now = Date.parse(NOW);
    const driver = new PeerSessionDriver(
      store,
      runtimes(async (request) => {
        now += 20;
        return reply(request, opening(request.memberId));
      }),
      { now: () => new Date(now) }
    );
    const paused = await driver.run(initial.config.sessionId);
    expect(paused.status).toBe("paused");
    expect(paused.rounds).toHaveLength(0);
    expect(paused.attempts.every((attempt) => attempt.acceptance === "invalidated")).toBe(true);
  });

  it("records an explicit budget extension while retrying the same frozen input", async () => {
    const initial = makeSession({ phase: "review" });
    initial.segments[0]!.maxCalls = 2;
    const store = new MemoryStore(initial);
    const calls: MemberRequest[] = [];
    const driver = makeDriver(store, async (request) => {
      calls.push(request);
      if (request.memberId === "member-b" && calls.filter((call) => call.memberId === "member-b").length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error("transient");
      }
      return reply(request, {
        phase: "review",
        reviewSetHash: request.sharedContext.reviewSetHash,
        positions: request.sharedContext.reviewVersions.map((versionId) => ({
          versionId,
          stance: "uncertain",
          rationale: "Open",
          sourceRefs: []
        })),
        conclusion: "Open",
        evidenceRequests: []
      });
    });
    expect((await driver.run(initial.config.sessionId)).status).toBe("paused");
    await expect(driver.retry(initial.config.sessionId)).rejects.toThrow(/budget/i);
    const completed = await driver.retry(initial.config.sessionId, { extraCalls: 1, extendSeconds: 1200 });
    expect(completed.status).toBe("completed");
    expect(
      completed.events.some(
        (event) => event.type === "BudgetExtended" && event.data.extraCalls === 1 && event.data.extendSeconds === 1200
      )
    ).toBe(true);
    expect(completed.events.map((event) => event.seq)).toEqual(completed.events.map((_, index) => index + 1));
    expect(calls.filter((call) => call.memberId === "member-b").map((call) => call.inputHash)).toEqual([
      calls[1]?.inputHash,
      calls[1]?.inputHash
    ]);
  });

  it("continues a completed segment with cumulative immutable notes and new symmetric sources", async () => {
    const state = makeSession({ phase: "review" });
    state.status = "completed";
    state.segments[0]!.status = "completed";
    state.segments[0]!.completionReason = "reviewed";
    const store = new MemoryStore(state);
    const shared: MemberRequest[] = [];
    const driver = makeDriver(store, async (request) => {
      shared.push(request);
      return reply(
        request,
        request.phase === "discussion"
          ? {
              phase: "discussion",
              actions: [],
              readyToReview: true,
              conclusion: "Still uncertain",
              evidenceRequests: []
            }
          : {
              phase: "review",
              reviewSetHash: request.sharedContext.reviewSetHash,
              positions: request.sharedContext.reviewVersions.map((versionId) => ({
                versionId,
                stance: "uncertain",
                rationale: "Need evidence",
                sourceRefs: []
              })),
              conclusion: "Still uncertain",
              evidenceRequests: []
            }
      );
    });
    await driver.continue(state.config.sessionId, {
      note: "First note",
      sources: [{ sourceId: "fresh", content: "New evidence", segmentId: 2 }],
      rounds: 1
    });
    const next = store.state;
    expect(next.currentSegmentId).toBe(2);
    expect(next.sources.map((source) => source.sourceId)).toEqual(["source-1", "segment-2:note", "fresh"]);
    expect(next.segments[0]?.reviews).toEqual(state.segments[0]?.reviews);
    expect(next.segments[1]?.reviews).toHaveLength(2);
    expect(shared[0]?.sharedContext.sources.map((source) => source.sourceId)).toEqual([
      "source-1",
      "segment-2:note",
      "fresh"
    ]);
    expect(shared[0]?.sharedContext).toEqual(shared[1]?.sharedContext);
    await driver.continue(state.config.sessionId, { note: "Second note" });
    expect(
      shared
        .find((request) => request.sharedContext.segmentId === 3)
        ?.sharedContext.sources.map((source) => source.sourceId)
    ).toEqual(["source-1", "segment-2:note", "fresh", "segment-3:note"]);
  });
});
