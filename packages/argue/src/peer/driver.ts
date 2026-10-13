import {
  MEMBER_IDS,
  PeerErrorSchema,
  RuntimeMetadataSchema,
  UsageSchema,
  type ContextSourceInput,
  type FrozenMemberInput,
  type MemberId,
  type MemberRequest,
  type MemberRuntime,
  type PeerError,
  type PeerJob,
  type PeerJsonValue,
  type PeerSession,
  type PeerStore,
  type RuntimeMetadata,
  type RuntimeReply
} from "./contracts.js";
import { buildMemberRequest, currentSegment, peerSnapshotId } from "./context.js";
import { sha256 } from "./hash.js";
import { applyRoundPair, validateMemberReply } from "./protocol.js";

/** Transport failures can retain billed usage and raw output without calling it a valid turn. */
export class PeerRuntimeFailure extends Error {
  readonly peerError: PeerError;
  readonly runtime?: RuntimeMetadata;
  readonly rawContent?: string;
  readonly payload?: unknown;
  constructor(error: PeerError, details: { runtime?: RuntimeMetadata; rawContent?: string; payload?: unknown } = {}) {
    super(error.message);
    this.name = "PeerRuntimeFailure";
    this.peerError = PeerErrorSchema.parse(error);
    this.runtime = details.runtime === undefined ? undefined : observedMetadata(details.runtime).runtime;
    this.rawContent = details.rawContent;
    this.payload = details.payload;
  }
}

export interface PeerDriverOptions {
  now?: () => Date;
  /** Called only after a durable commit. Observer errors are isolated from dispatch. */
  onCommitted?: (state: PeerSession) => void | Promise<void>;
}
export interface PeerRetryOptions {
  extraCalls?: number;
  extendSeconds?: number;
  signal?: AbortSignal;
}
export interface PeerContinueOptions {
  note?: string;
  sources?: ContextSourceInput[];
  rounds?: number;
  signal?: AbortSignal;
}

const freeze = (request: MemberRequest): FrozenMemberInput => ({
  messages: request.messages,
  outputSchema: request.outputSchema,
  outputMode: request.outputMode,
  maxOutputTokens: request.maxOutputTokens,
  modelId: request.modelId,
  protocol: request.protocol,
  baseUrl: request.baseUrl,
  apiKeyEnv: request.apiKeyEnv,
  generationOptions: request.generationOptions
});
const errorOf = (reason: unknown): PeerError =>
  reason instanceof PeerRuntimeFailure
    ? reason.peerError
    : { code: "runtime_error", message: reason instanceof Error ? reason.message : String(reason), retryable: true };
const segmentAttempts = (state: PeerSession) => {
  const jobIds = new Set(state.jobs.filter((job) => job.segmentId === state.currentSegmentId).map((job) => job.jobId));
  return state.attempts.filter((attempt) => jobIds.has(attempt.jobId)).length;
};
const asIso = (date: Date) => date.toISOString();

function observedMetadata(candidate: RuntimeMetadata): { runtime?: RuntimeMetadata; complete: boolean } {
  const valid = RuntimeMetadataSchema.safeParse(candidate);
  if (valid.success) return { runtime: valid.data, complete: true };
  const observedUsage: Record<string, unknown> = {};
  if (candidate.usage && typeof candidate.usage === "object") {
    for (const [key, value] of Object.entries(candidate.usage)) {
      const item = UsageSchema.safeParse({ [key]: value });
      if (item.success) Object.assign(observedUsage, item.data);
    }
  }
  const recovered = RuntimeMetadataSchema.safeParse({
    modelId: candidate.modelId,
    protocol: candidate.protocol,
    generationOptions: candidate.generationOptions,
    usage: observedUsage,
    finishReason: candidate.finishReason
  });
  return { runtime: recovered.success ? recovered.data : undefined, complete: false };
}

function replyMetadata(candidate: RuntimeReply): RuntimeMetadata {
  return {
    modelId: candidate.modelId,
    protocol: candidate.protocol,
    generationOptions: candidate.generationOptions,
    usage: candidate.usage,
    finishReason: candidate.finishReason
  };
}

export class PeerSessionDriver {
  private readonly now: () => Date;
  constructor(
    private readonly store: PeerStore,
    private readonly runtimes: Record<MemberId, MemberRuntime>,
    private readonly options: PeerDriverOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async commit(state: PeerSession, next: PeerSession): Promise<PeerSession> {
    next.revision = state.revision + 1;
    await this.store.commit(state.revision, next);
    try {
      await this.options.onCommitted?.(structuredClone(next));
    } catch {
      /* A progress observer cannot change saved state. */
    }
    return next;
  }

  private event(
    next: PeerSession,
    type: string,
    data: Record<string, PeerJsonValue> = {},
    jobId?: string,
    attemptId?: string
  ) {
    next.eventSeq++;
    next.events.push({
      seq: next.eventSeq,
      type,
      at: asIso(this.now()),
      segmentId: next.currentSegmentId,
      ...(jobId === undefined ? {} : { jobId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      data
    });
  }

  private async pause(state: PeerSession, error: PeerError): Promise<PeerSession> {
    const next = structuredClone(state);
    next.status = "paused";
    next.pauseReason = error;
    this.event(next, "SessionPaused", { code: error.code });
    return this.commit(state, next);
  }

  /** Recover a saved active state after its writer process has ended; never dispatches. */
  async recover(sessionId: string): Promise<PeerSession> {
    const state = await this.store.load(sessionId);
    if (state.status !== "active") throw new Error("Only an active peer session can recover");
    const next = structuredClone(state);
    let unknownCount = 0;
    for (const attempt of next.attempts.filter((candidate) => candidate.status === "running")) {
      unknownCount++;
      attempt.status = "unknown";
      attempt.acceptance = "invalidated";
      attempt.cancellation = "unknown";
      attempt.endedAt = asIso(this.now());
      const job = next.jobs.find((candidate) => candidate.jobId === attempt.jobId);
      if (job) job.status = "unknown";
      this.event(next, "AttemptUnknown", {}, attempt.jobId, attempt.attemptId);
    }
    next.status = "paused";
    next.pauseReason = unknownCount
      ? { code: "recovered_unknown", message: "An interrupted call may have reached the provider", retryable: true }
      : {
          code: "recovered_interrupted",
          message: "Previous process stopped between durable commits; explicit retry required",
          retryable: true
        };
    this.event(next, "SessionPaused", { code: next.pauseReason.code });
    return this.commit(state, next);
  }

  async run(sessionId: string, signal?: AbortSignal): Promise<PeerSession> {
    let state = await this.store.load(sessionId);
    if (state.status !== "active")
      throw new Error("Only an active peer session can run; use retry for paused sessions");
    if (state.attempts.some((attempt) => attempt.status === "running")) return this.recover(sessionId);
    while (state.status === "active") {
      if (signal?.aborted) return this.pause(state, { code: "cancelled", message: "Run cancelled", retryable: true });
      const segment = currentSegment(state);
      if (segment.status === "completed") return state;
      let requests: MemberRequest[];
      try {
        requests = MEMBER_IDS.map((id) => buildMemberRequest(state, id));
      } catch (error) {
        if (error instanceof Error && /^Compiled input exceeds /u.test(error.message))
          return this.pause(state, { code: "input_limit", message: error.message, retryable: false });
        throw error;
      }
      const jobs = requests.map((request) => state.jobs.find((job) => job.jobId === request.jobId));
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const request = requests[i]!;
        if (
          job &&
          (job.inputHash !== request.inputHash ||
            job.snapshotId !== request.snapshotId ||
            JSON.stringify(job.frozenInput) !== JSON.stringify(freeze(request)))
        )
          throw new Error("Frozen job input changed");
      }
      if (jobs.every((job) => job?.status === "sealed")) {
        const committed = applyRoundPair(state, [jobs[0]!.sealedReply!, jobs[1]!.sealedReply!]);
        for (const job of committed.jobs.filter((job) => jobs.some((old) => old?.jobId === job.jobId)))
          job.status = "committed";
        this.event(committed, "RoundCommitted", { phase: segment.phase, roundIndex: segment.roundIndex });
        state = await this.commit(state, committed);
        continue;
      }
      if (jobs.some((job) => job && !["pending", "sealed"].includes(job.status)))
        return this.pause(state, {
          code: "explicit_retry_required",
          message: "A failed or unknown member requires explicit retry",
          retryable: true
        });
      const needed = requests.filter((_, index) => jobs[index]?.status !== "sealed");
      const now = this.now().getTime();
      if (now >= Date.parse(segment.deadline))
        return this.pause(state, { code: "segment_deadline", message: "Segment deadline reached", retryable: true });
      if (segmentAttempts(state) + needed.length > segment.maxCalls)
        return this.pause(state, {
          code: "call_budget",
          message: "Call budget cannot fund the whole pending pair",
          retryable: true
        });

      const prepared = structuredClone(state);
      const dispatch: Array<{ request: MemberRequest; attemptId: string }> = [];
      for (const request of needed) {
        const attemptId = globalThis.crypto.randomUUID();
        const deadline = asIso(
          new Date(Math.min(Date.parse(segment.deadline), now + state.config.limits.callTimeoutMs))
        );
        const existing = prepared.jobs.find((job) => job.jobId === request.jobId);
        const job: PeerJob = existing ?? {
          jobId: request.jobId,
          memberId: request.memberId,
          segmentId: segment.segmentId,
          roundIndex: segment.roundIndex,
          phase: segment.phase,
          snapshotId: request.snapshotId,
          inputHash: request.inputHash,
          status: "pending",
          frozenInput: freeze(request)
        };
        job.status = "running";
        job.activeAttemptId = attemptId;
        if (!existing) prepared.jobs.push(job);
        prepared.attempts.push({
          jobId: request.jobId,
          attemptId,
          inputHash: request.inputHash,
          memberId: request.memberId,
          status: "running",
          startedAt: asIso(this.now()),
          deadline,
          acceptance: "active",
          cancellation: "none"
        });
        this.event(prepared, "AttemptStarted", { memberId: request.memberId }, request.jobId, attemptId);
        dispatch.push({ request: { ...request, deadline }, attemptId });
      }
      state = await this.commit(state, prepared); // Both intents must be durable before either call starts.
      state = await this.dispatch(state, dispatch, signal);
    }
    return state;
  }

  private async dispatch(
    initial: PeerSession,
    calls: Array<{ request: MemberRequest; attemptId: string }>,
    outerSignal?: AbortSignal
  ): Promise<PeerSession> {
    let state = initial;
    let sequence = Promise.resolve();
    let fatal: unknown;
    let stopReason: PeerError | undefined;
    const controller = new AbortController();
    const onAbort = () => {
      stopReason ??= { code: "cancelled", message: "Run cancelled", retryable: true };
      controller.abort();
    };
    outerSignal?.addEventListener("abort", onAbort, { once: true });
    if (outerSignal?.aborted) onAbort();
    const save = (mutate: (next: PeerSession) => void) => {
      const result = sequence.then(async () => {
        if (fatal) return;
        try {
          const next = structuredClone(state);
          mutate(next);
          state = await this.commit(state, next);
        } catch (error) {
          fatal = error instanceof Error ? error : new Error(String(error));
          controller.abort();
          throw fatal;
        }
      });
      sequence = result.catch(() => {});
      return result;
    };
    const one = async ({ request, attemptId }: { request: MemberRequest; attemptId: string }) => {
      let observed: RuntimeReply | undefined;
      let observedRuntime: RuntimeMetadata | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancellation!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        cancellation = () => reject(new Error("Call cancelled"));
        controller.signal.addEventListener("abort", cancellation, { once: true });
        if (controller.signal.aborted) cancellation();
      });
      const milliseconds = Math.max(0, Date.parse(request.deadline) - this.now().getTime());
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopReason ??= { code: "call_timeout", message: "Call deadline reached", retryable: true };
          controller.abort();
          reject(new Error("Call deadline reached"));
        }, milliseconds);
      });
      try {
        const candidate = await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted || this.now().getTime() >= Date.parse(request.deadline))
              throw new Error("Call cancelled before dispatch");
            return this.runtimes[request.memberId].respond(request, controller.signal);
          }),
          aborted,
          expired
        ]);
        observed = candidate;
        const metadata = observedMetadata(replyMetadata(candidate));
        observedRuntime = metadata.runtime;
        if (controller.signal.aborted || this.now().getTime() >= Date.parse(request.deadline))
          throw new Error("Call arrived after cancellation or deadline");
        const validated = validateMemberReply(state, {
          memberId: request.memberId,
          jobId: request.jobId,
          snapshotId: request.snapshotId,
          inputHash: request.inputHash,
          payload: candidate.payload
        });
        if (!metadata.complete || !metadata.runtime)
          throw new PeerRuntimeFailure(
            { code: "invalid_runtime_metadata", message: "Runtime metadata is invalid", retryable: true },
            { runtime: metadata.runtime, rawContent: candidate.rawContent, payload: candidate.payload }
          );
        const runtime = metadata.runtime;
        await save((next) => {
          const attempt = next.attempts.find((item) => item.attemptId === attemptId)!;
          if (
            attempt.acceptance !== "active" ||
            next.jobs.find((job) => job.jobId === request.jobId)?.activeAttemptId !== attemptId
          )
            return;
          if (controller.signal.aborted || this.now().getTime() >= Date.parse(request.deadline)) {
            attempt.status = "late";
            attempt.acceptance = "invalidated";
            attempt.cancellation = controller.signal.aborted ? "requested" : "none";
            attempt.endedAt = asIso(this.now());
            attempt.runtime = runtime;
            attempt.rawContent = candidate.rawContent;
            attempt.payload = candidate.payload;
            next.jobs.find((job) => job.jobId === request.jobId)!.status = "failed";
            next.status = "paused";
            next.pauseReason = {
              code: "late_reply",
              message: "Reply arrived after cancellation or deadline",
              retryable: true
            };
            this.event(next, "AttemptLate", {}, request.jobId, attemptId);
            this.event(next, "SessionPaused", { code: "late_reply" });
            stopReason ??= next.pauseReason;
            controller.abort();
            return;
          }
          Object.assign(attempt, {
            status: "valid",
            acceptance: "accepted",
            endedAt: asIso(this.now()),
            runtime,
            rawContent: candidate.rawContent,
            payload: candidate.payload
          });
          const job = next.jobs.find((item) => item.jobId === request.jobId)!;
          job.status = "sealed";
          job.sealedReply = validated;
          this.event(next, "AttemptSealed", {}, request.jobId, attemptId);
        });
      } catch (reason) {
        if (fatal) return;
        const wasLate =
          observed !== undefined && (controller.signal.aborted || this.now().getTime() >= Date.parse(request.deadline));
        const wasCancelled = controller.signal.aborted && observed === undefined;
        stopReason ??= errorOf(reason);
        controller.abort();
        const failed = reason instanceof PeerRuntimeFailure;
        await save((next) => {
          const attempt = next.attempts.find((item) => item.attemptId === attemptId)!;
          if (attempt.status !== "running") return;
          attempt.status = wasLate
            ? "late"
            : observed
              ? "invalid"
              : failed
                ? "failed"
                : wasCancelled
                  ? "cancelled"
                  : "failed";
          attempt.acceptance = "invalidated";
          attempt.cancellation = controller.signal.aborted ? "requested" : "none";
          attempt.endedAt = asIso(this.now());
          attempt.error = errorOf(reason);
          if (failed) {
            const failure = reason as PeerRuntimeFailure;
            if (failure.runtime) attempt.runtime = failure.runtime;
            if (failure.rawContent !== undefined) attempt.rawContent = failure.rawContent;
            if (failure.payload !== undefined) attempt.payload = failure.payload;
          }
          if (observed) {
            if (observedRuntime) attempt.runtime = observedRuntime;
            attempt.rawContent = observed.rawContent;
            attempt.payload = observed.payload;
          }
          next.jobs.find((job) => job.jobId === request.jobId)!.status = "failed";
          next.status = "paused";
          next.pauseReason = stopReason;
          this.event(
            next,
            attempt.status === "invalid"
              ? "AttemptInvalid"
              : attempt.status === "late"
                ? "AttemptLate"
                : attempt.status === "cancelled"
                  ? "AttemptCancelled"
                  : "AttemptFailed",
            { code: attempt.error.code },
            request.jobId,
            attemptId
          );
          this.event(next, "SessionPaused", { code: stopReason!.code });
        });
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancellation);
      }
    };
    try {
      const outcomes = await Promise.allSettled(
        calls.map((call) =>
          one(call).catch((error: unknown) => {
            fatal ??= error instanceof Error ? error : new Error(String(error));
            controller.abort();
            throw error;
          })
        )
      );
      await sequence;
      if (fatal) throw fatal;
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      return state;
    } finally {
      outerSignal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  async retry(sessionId: string, options: PeerRetryOptions = {}): Promise<PeerSession> {
    const state = await this.store.load(sessionId);
    if (state.status !== "paused") throw new Error("Only a paused peer session can retry");
    const extraCalls = options.extraCalls ?? 0;
    const extendSeconds = options.extendSeconds ?? 0;
    if (!Number.isInteger(extraCalls) || extraCalls < 0 || !Number.isInteger(extendSeconds) || extendSeconds < 0)
      throw new Error("Budget extensions must be nonnegative integers");
    const next = structuredClone(state);
    const segment = currentSegment(next);
    segment.maxCalls += extraCalls;
    if (extendSeconds > 0) segment.deadline = asIso(new Date(this.now().getTime() + extendSeconds * 1000));
    if (extraCalls > 0 || extendSeconds > 0) this.event(next, "BudgetExtended", { extraCalls, extendSeconds });
    const pending = next.jobs.filter(
      (job) =>
        job.segmentId === segment.segmentId &&
        job.snapshotId === segment.snapshotId &&
        ["failed", "unknown"].includes(job.status)
    );
    for (const job of pending) {
      job.status = "pending";
      delete job.activeAttemptId;
    }
    const needed = MEMBER_IDS.filter(
      (id) =>
        !next.jobs.some(
          (job) =>
            job.segmentId === segment.segmentId &&
            job.snapshotId === segment.snapshotId &&
            job.memberId === id &&
            job.status === "sealed"
        )
    ).length;
    if (this.now().getTime() >= Date.parse(segment.deadline))
      throw new Error("Segment deadline expired; extend it explicitly");
    if (segmentAttempts(next) + needed > segment.maxCalls)
      throw new Error("Call budget exhausted; extend it explicitly");
    next.status = "active";
    delete next.pauseReason;
    this.event(next, "RetryRequested");
    await this.commit(state, next);
    return this.run(sessionId, options.signal);
  }

  async continue(sessionId: string, options: PeerContinueOptions = {}): Promise<PeerSession> {
    const state = await this.store.load(sessionId);
    if (state.status !== "completed" || currentSegment(state).status !== "completed")
      throw new Error("Only a completed peer segment can continue");
    const rounds = options.rounds ?? 1;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("Continuation rounds must be 1 to 3");
    const next = structuredClone(state);
    const id = state.currentSegmentId + 1;
    const sourceInputs: ContextSourceInput[] = [...(options.sources ?? [])];
    if (options.note?.trim())
      sourceInputs.unshift({ sourceId: `segment-${id}:note`, content: options.note, segmentId: id });
    if (sourceInputs.some((source) => source.segmentId !== id))
      throw new Error("New sources must belong to the new segment");
    if (
      new Set([...next.sources.map((source) => source.sourceId), ...sourceInputs.map((source) => source.sourceId)])
        .size !==
      next.sources.length + sourceInputs.length
    )
      throw new Error("Duplicate source ID");
    next.sources.push(
      ...sourceInputs.map((source) => ({
        ...source,
        contentHash: sha256(source.content),
        lineCount: source.content.split("\n").length
      }))
    );
    if (next.sources.reduce((sum, source) => sum + source.content.length, 0) > next.config.limits.maxSourceCharacters)
      throw new Error("Source character limit exceeded");
    const startedAt = asIso(this.now());
    next.currentSegmentId = id;
    next.status = "active";
    delete next.pauseReason;
    next.segments.push({
      segmentId: id,
      phase: "discussion",
      roundIndex: 1,
      snapshotId: "pending",
      expectedMembers: [...MEMBER_IDS],
      status: "active",
      startedAt,
      deadline: asIso(new Date(this.now().getTime() + next.config.limits.segmentTimeoutMs)),
      minDiscussionRounds: rounds,
      maxDiscussionRounds: rounds,
      maxCalls: 2 * (rounds + 1) + 2,
      reviewVersions: [],
      reviews: [],
      ...(options.note === undefined ? {} : { note: options.note })
    });
    currentSegment(next).snapshotId = peerSnapshotId(next);
    this.event(next, "SegmentContinued", { rounds, sourceCount: sourceInputs.length });
    await this.commit(state, next);
    return this.run(sessionId, options.signal);
  }
}
