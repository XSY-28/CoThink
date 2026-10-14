import { MemberProviderConfigSchema } from "../peer/contracts.js";
import {
  ModelTransportFailure,
  type ModelTransport,
  type ModelReply,
  type ModelMetadata
} from "../transport/contracts.js";
import { allocateRoundTokens, BudgetCapacityError, OPENING_OUTPUT_TOKENS } from "./budget.js";
import { buildDiscussionMemberRequest, type ProtocolCodec } from "./codec.js";
import { JsonDiscussionCodec } from "./json-codec.js";
import { currentCompleteReview, evaluateConsensus } from "./consensus.js";
import { validateDiscussionReply } from "./protocol.js";
import { discussionHash } from "./state-utils.js";
import { selectFinalResult } from "./decision.js";
import { validateConstraintChecks, type ConstraintCheck } from "./result.js";
import {
  createDiscussionRun,
  appendDiscussionRunEvent,
  parseDiscussionRun,
  currentDiscussionSegment,
  currentDiscussionConstraintChecks,
  frozenDiscussionJobHash,
  canStartNextDiscussion,
  type DiscussionRun,
  type DiscussionRunInput,
  type DiscussionRunEvent,
  type FrozenDiscussionJob
} from "./store.js";

export interface DiscussionRunStore {
  load(sessionId: string): Promise<DiscussionRun>;
  commit(expectedRevision: number, state: DiscussionRun): Promise<void>;
}
export interface DiscussionEngineOptions {
  now?: () => number;
  codec?: ProtocolCodec;
  constraintChecks?: readonly ConstraintCheck[];
  /** Notification follows durable commit. Errors never roll back or dispatch. */
  onSaved?: (state: DiscussionRun, event: DiscussionRunEvent | { type: "created" }) => void | Promise<void>;
}
export interface DiscussionRetryOptions {
  signal?: AbortSignal;
  extraCalls?: number;
  extraAllocatedOutputTokens?: number;
  extendMs?: number;
}
export interface DiscussionContinueInput extends Partial<Omit<DiscussionRunInput, "sessionId">> {
  note?: string;
  signal?: AbortSignal;
}
const metadata = (reply: ModelReply): ModelMetadata => ({
  modelId: reply.modelId,
  protocol: reply.protocol,
  generationOptions: reply.generationOptions,
  usage: reply.usage,
  finishReason: reply.finishReason
});

/** Only this coordinator dispatches. All data transitions and integrity checks are in the store contract. */
export class DiscussionEngine {
  private readonly now: () => number;
  private readonly codec: ProtocolCodec;
  private readonly busy = new Set<string>();
  constructor(
    private readonly store: DiscussionRunStore,
    private readonly transport: ModelTransport,
    private readonly options: DiscussionEngineOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.codec = options.codec ?? new JsonDiscussionCodec();
  }
  private notify(state: DiscussionRun, event: DiscussionRunEvent | { type: "created" }): void {
    try {
      void Promise.resolve(this.options.onSaved?.(state, event)).catch(() => {});
    } catch {
      /* isolated observer */
    }
  }
  private async exclusive(sessionId: string, work: () => Promise<DiscussionRun>): Promise<DiscussionRun> {
    if (this.busy.has(sessionId)) throw new Error("Discussion engine is already running this session");
    this.busy.add(sessionId);
    try {
      return await work();
    } finally {
      this.busy.delete(sessionId);
    }
  }
  private async append(state: DiscussionRun, event: DiscussionRunEvent): Promise<DiscussionRun> {
    const next = appendDiscussionRunEvent(state, event);
    await this.store.commit(state.revision, next);
    this.notify(next, event);
    return next;
  }
  async start(input: DiscussionRunInput, signal?: AbortSignal): Promise<DiscussionRun> {
    return this.exclusive(input.sessionId, async () => {
      const state = createDiscussionRun(input, this.now());
      if (this.codec.codecVersion !== state.codecVersion)
        throw new Error("Codec does not match frozen runtime version");
      await this.store.commit(-1, state);
      this.notify(state, { type: "created" });
      return this.drive(state, signal);
    });
  }
  /** Restart is recovery, never authorization to repeat a potentially billed call. */
  async run(sessionId: string): Promise<DiscussionRun> {
    return this.recover(sessionId);
  }
  async recover(sessionId: string): Promise<DiscussionRun> {
    return this.exclusive(sessionId, async () => {
      const state = parseDiscussionRun(await this.store.load(sessionId));
      if (state.status !== "active") return state;
      return this.append(state, { type: "recovered", atMs: this.now() });
    });
  }
  async retry(sessionId: string, options: DiscussionRetryOptions = {}): Promise<DiscussionRun> {
    return this.exclusive(sessionId, async () => {
      let state = parseDiscussionRun(await this.store.load(sessionId));
      if (state.status === "completed") return state;
      if (this.codec.codecVersion !== state.codecVersion)
        throw new Error("Codec does not match frozen runtime version");
      if (state.status === "active") return this.append(state, { type: "recovered", atMs: this.now() });
      if (
        options.extraCalls !== undefined ||
        options.extraAllocatedOutputTokens !== undefined ||
        options.extendMs !== undefined
      )
        state = await this.append(state, {
          type: "extended",
          atMs: this.now(),
          extensionId: `extension-${state.events.length + 1}`,
          ...(options.extraCalls === undefined ? {} : { extraCalls: options.extraCalls }),
          ...(options.extraAllocatedOutputTokens === undefined
            ? {}
            : { extraAllocatedOutputTokens: options.extraAllocatedOutputTokens }),
          ...(options.extendMs === undefined ? {} : { extendMs: options.extendMs })
        });
      const segment = currentDiscussionSegment(state);
      if (segment.currentBatch) {
        const missing = segment.currentBatch.jobIds
          .filter((id) => !segment.seals.some((seal) => seal.jobId === id))
          .map((id) => segment.jobs.find((job) => job.jobId === id)!);
        if (missing.length) {
          try {
            state = await this.append(state, {
              type: "retry_prepared",
              atMs: this.now(),
              attemptIds: Object.fromEntries(
                missing.map((job) => [
                  job.memberId,
                  `attempt-${state.events.length + 1}-${encodeURIComponent(job.memberId)}`
                ])
              )
            });
          } catch (error) {
            if (error instanceof BudgetCapacityError) return state;
            throw error;
          }
        } else state = await this.append(state, { type: "resumed", atMs: this.now() });
      } else state = await this.append(state, { type: "resumed", atMs: this.now() });
      return this.drive(state, options.signal);
    });
  }
  async continue(sessionId: string, input: DiscussionContinueInput = {}): Promise<DiscussionRun> {
    return this.exclusive(sessionId, async () => {
      let state = parseDiscussionRun(await this.store.load(sessionId));
      if (state.status === "active") return this.append(state, { type: "recovered", atMs: this.now() });
      if (this.codec.codecVersion !== state.codecVersion)
        throw new Error("Codec does not match frozen runtime version");
      const old = currentDiscussionSegment(state),
        nextId = state.currentSegmentId + 1;
      const sources = [
        ...old.protocol.sources.map(({ sourceId, name, content }) => ({
          sourceId,
          ...(name === undefined ? {} : { name }),
          content
        })),
        ...(input.sources ?? []),
        ...(input.note === undefined ? [] : [{ sourceId: `segment-${nextId}:note`, content: input.note }])
      ];
      state = await this.append(state, {
        type: "continued",
        atMs: this.now(),
        input: {
          sessionId,
          question: input.question ?? old.protocol.question,
          memberIds: input.memberIds ?? (input.members ? Object.keys(input.members) : old.protocol.memberIds),
          members: input.members ?? old.members,
          policy: input.policy ?? old.protocol.policy,
          constraints: input.constraints ?? old.protocol.constraints,
          sources
        }
      });
      return this.drive(state, input.signal);
    });
  }
  private jobs(state: DiscussionRun): FrozenDiscussionJob[] {
    const segment = currentDiscussionSegment(state),
      protocol = segment.protocol;
    const allocation =
      protocol.phase === "opening"
        ? Object.fromEntries(protocol.memberIds.map((id) => [id, OPENING_OUTPUT_TOKENS]))
        : protocol.phase === "discussion"
          ? allocateRoundTokens(protocol.policy, protocol.roundIndex - 1)
          : segment.ledger.reservations.find(
              (reservation) => reservation.reservationId === segment.activeReviewReservationId
            )!.allocation;
    return protocol.memberIds.map((memberId) => {
      const config = MemberProviderConfigSchema.parse(segment.members[memberId]);
      const request = buildDiscussionMemberRequest(protocol, memberId, allocation[memberId]!, this.codec);
      const job = {
        jobId: `${state.sessionId}:s${segment.segmentId}:job-${state.events.length + 1}:${encodeURIComponent(memberId)}`,
        memberId,
        phase: protocol.phase,
        roundIndex: protocol.roundIndex,
        snapshotId: request.snapshotId,
        request,
        call: {
          protocol: config.protocol,
          baseUrl: config.baseUrl,
          modelId: config.modelId,
          apiKeyEnv: config.apiKeyEnv,
          generationOptions: config.generationOptions,
          outputMode: config.outputMode,
          maxOutputTokens: request.maxOutputTokens,
          messages: structuredClone(request.messages)
        }
      };
      return { ...job, inputHash: frozenDiscussionJobHash(job) };
    });
  }
  private async drive(initial: DiscussionRun, signal?: AbortSignal): Promise<DiscussionRun> {
    if (this.codec.codecVersion !== initial.codecVersion)
      throw new Error("Codec does not match frozen runtime version");
    let state = initial,
      operation = Promise.resolve();
    const scope = new AbortController();
    const abort = () => scope.abort(signal?.reason ?? new Error("Discussion interrupted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const write = (event: DiscussionRunEvent): Promise<void> => {
      const result = operation.then(async () => {
        state = await this.append(state, event);
      });
      operation = result.then(
        () => {},
        () => {}
      );
      return result;
    };
    const pause = async (code: string, message: string) => {
      // Prepared intents may be interrupted before dispatch. They stay charged.
      for (const attempt of currentDiscussionSegment(state).ledger.attempts.filter((item) => item.status === "pending"))
        await write({
          type: "settled",
          atMs: this.now(),
          attemptId: attempt.attemptId,
          outcome: "cancelled",
          error: { code, message }
        });
      await write({ type: "paused", atMs: this.now(), code, message });
      return state;
    };
    const finalize = async (stopReason: "checkpoint" | "round_limit" | "budget_limit") => {
      const checks = currentDiscussionConstraintChecks(currentDiscussionSegment(state));
      let result;
      try {
        result = selectFinalResult({
          session: currentDiscussionSegment(state).protocol,
          stopReason,
          constraintChecks: checks
        });
      } catch (error) {
        return pause("constraint_failed", error instanceof Error ? error.message : String(error));
      }
      if (result.outcome === "incomplete") return pause(result.incompleteReason!, "Final selection is incomplete");
      // Storage failures must propagate. They are never model or constraint failures.
      await write({ type: "finalized", atMs: this.now(), stopReason, constraintChecks: checks });
      return state;
    };
    try {
      while (state.status === "active") {
        let segment = currentDiscussionSegment(state);
        if (scope.signal.aborted) return await pause("cancelled", "Interrupted; explicit retry required");
        if (this.now() >= segment.ledger.deadlineAtMs)
          return await pause("deadline", "Segment deadline reached; explicit extension required");
        if (segment.currentBatch) {
          const pending = segment.currentBatch.jobIds.flatMap((jobId) => {
            const link = segment.attemptLinks.filter((item) => item.jobId === jobId).at(-1)!;
            const attempt = segment.ledger.attempts.find((item) => item.attemptId === link.attemptId)!;
            return attempt.status === "pending"
              ? [{ job: segment.jobs.find((item) => item.jobId === jobId)!, attempt }]
              : [];
          });
          if (pending.length) {
            await Promise.all(
              pending.map(async ({ job, attempt }) => {
                const outcome = await this.call(job, attempt.deadlineAtMs, scope.signal);
                const atMs = this.now();
                if (outcome.kind === "success") {
                  let payload: unknown;
                  try {
                    if (scope.signal.aborted || atMs >= attempt.deadlineAtMs)
                      throw new Error("Late or cancelled response");
                    if (outcome.reply.finishReason !== "stop") throw new Error("Invalid or truncated finish reason");
                    payload = this.codec.decode(outcome.reply.rawContent);
                    validateDiscussionReply(currentDiscussionSegment(state).protocol, {
                      memberId: job.memberId,
                      snapshotId: job.snapshotId,
                      payload
                    });
                  } catch (error) {
                    await write({
                      type: "settled",
                      atMs,
                      attemptId: attempt.attemptId,
                      outcome: scope.signal.aborted ? "cancelled" : "failed",
                      rawContent: outcome.reply.rawContent,
                      runtime: metadata(outcome.reply),
                      error: { code: "invalid_reply", message: error instanceof Error ? error.message : String(error) }
                    });
                    return;
                  }
                  await write({
                    type: "settled",
                    atMs,
                    attemptId: attempt.attemptId,
                    outcome: "succeeded",
                    payload,
                    rawContent: outcome.reply.rawContent,
                    runtime: metadata(outcome.reply)
                  });
                } else {
                  const failure = outcome.error instanceof ModelTransportFailure ? outcome.error : undefined;
                  await write({
                    type: "settled",
                    atMs,
                    attemptId: attempt.attemptId,
                    outcome: outcome.kind === "cancelled" ? "cancelled" : "failed",
                    ...(failure?.details.rawContent === undefined ? {} : { rawContent: failure.details.rawContent }),
                    ...(failure?.details.runtime === undefined ? {} : { runtime: failure.details.runtime }),
                    error: {
                      code: failure?.error.code ?? (outcome.kind === "cancelled" ? "cancelled" : "transport_error"),
                      message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
                    }
                  });
                }
              })
            );
          }
          if (scope.signal.aborted) return await pause("cancelled", "Interrupted; sealed peers are retained");
          segment = currentDiscussionSegment(state);
          if (!segment.currentBatch!.jobIds.every((jobId) => segment.seals.some((seal) => seal.jobId === jobId)))
            return await pause(
              this.now() >= segment.ledger.deadlineAtMs ? "deadline" : "model_failure",
              "Incomplete batch; retry only missing members"
            );
          await write({ type: "commit_batch", atMs: this.now() });
          continue;
        }
        // This decision also runs after recovery from a committed discussion batch.
        if (segment.protocol.phase === "discussion") {
          const last = segment.protocol.committedBatches.at(-1);
          if (last?.phase === "discussion") {
            const ready = last.replies.every(
              (reply) => reply.payload.phase === "discussion" && reply.payload.readyToReview
            );
            const unanswered = segment.protocol.messages.some(
              (message) => message.kind !== "reply" && !message.respondedBy.length
            );
            if (
              segment.protocol.roundIndex - 1 >= segment.ledger.roundLimit! ||
              (ready && !unanswered) ||
              !canStartNextDiscussion(segment, this.now())
            ) {
              await write({ type: "review_started", atMs: this.now() });
              continue;
            }
          }
        }
        const epoch = currentCompleteReview(segment.protocol);
        if (epoch) {
          const incoming = (this.options.constraintChecks ?? []).filter(
            (check) =>
              !segment.constraintChecks?.some(
                (old) => old.checkId === check.checkId && discussionHash(old) === discussionHash(check)
              )
          );
          if (incoming.length) {
            const event = { type: "constraints_checked" as const, atMs: this.now(), checks: incoming };
            try {
              validateConstraintChecks(segment.protocol, incoming);
              // Validate before the disk operation; a CAS error must still escape.
              appendDiscussionRunEvent(state, event);
            } catch (error) {
              return await pause("constraint_failed", error instanceof Error ? error.message : String(error));
            }
            await write(event);
            segment = currentDiscussionSegment(state);
          }
          const checks = currentDiscussionConstraintChecks(segment);
          let consensus;
          try {
            consensus = evaluateConsensus(segment.protocol, checks);
          } catch (error) {
            return await pause("constraint_failed", error instanceof Error ? error.message : String(error));
          }
          if (
            checks.some((check) => check.status === "failed" && check.answerVersionId === null) ||
            (!consensus.length && evaluateConsensus(segment.protocol).length)
          )
            return await pause("constraint_failed", "Saved candidates do not pass the known host constraints");
          if (consensus.length) {
            await finalize("checkpoint");
            continue;
          }
          if (epoch.roundIndex >= segment.ledger.roundLimit!) {
            await finalize("round_limit");
            continue;
          }
          if (!canStartNextDiscussion(segment, this.now())) {
            await finalize("budget_limit");
            continue;
          }
          const existing = segment.ledger.reservations.find(
            (item) => item.reservationId === segment.activeReviewReservationId && !Object.keys(item.attemptIds).length
          );
          if (!existing)
            await write({
              type: "reserve_review",
              atMs: this.now(),
              reservationId: `review-${state.events.length + 1}`
            });
          await write({ type: "resume_review", atMs: this.now() });
          continue;
        }
        if (segment.protocol.phase !== "review") {
          const existing = segment.activeReviewReservationId;
          await write({
            type: "reserve_review",
            atMs: this.now(),
            reservationId: existing ?? `review-${state.events.length + 1}`
          });
        }
        const jobs = this.jobs(state);
        await write({
          type: "prepared",
          atMs: this.now(),
          batchId: `batch-${state.events.length + 1}`,
          jobs,
          attemptIds: Object.fromEntries(
            jobs.map((job) => [job.memberId, `attempt-${state.events.length + 1}:${encodeURIComponent(job.memberId)}`])
          )
        });
      }
      return state;
    } catch (error) {
      scope.abort(error);
      if (
        error instanceof BudgetCapacityError &&
        !currentDiscussionSegment(state).ledger.attempts.some((attempt) => attempt.status === "pending")
      )
        return await pause(
          "budget_exhausted",
          "Budget cannot fund the complete next batch; explicit extension required"
        );
      throw error;
    } finally {
      scope.abort();
      signal?.removeEventListener("abort", abort);
    }
  }
  private call(
    job: FrozenDiscussionJob,
    deadlineAtMs: number,
    signal: AbortSignal
  ): Promise<{ kind: "success"; reply: ModelReply } | { kind: "failure" | "cancelled"; error: unknown }> {
    return new Promise((resolve) => {
      const controller = new AbortController();
      let finished = false;
      const finish = (
        value: { kind: "success"; reply: ModelReply } | { kind: "failure" | "cancelled"; error: unknown }
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        resolve(value);
      };
      const cancel = () => {
        controller.abort(signal.reason);
        finish({ kind: "cancelled", error: signal.reason ?? new Error("Cancelled") });
      };
      const timer = setTimeout(
        () => {
          controller.abort(new Error("Call deadline reached"));
          finish({ kind: "cancelled", error: new Error("Call deadline reached") });
        },
        Math.max(0, deadlineAtMs - this.now())
      );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted || this.now() >= deadlineAtMs) {
        cancel();
        return;
      }
      try {
        Promise.resolve(this.transport.respond(structuredClone(job.call), controller.signal)).then(
          (reply) => finish({ kind: "success", reply }),
          (error) => finish({ kind: "failure", error })
        );
      } catch (error) {
        finish({ kind: "failure", error });
      }
    });
  }
}
