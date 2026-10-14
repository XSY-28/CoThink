import { z } from "zod";
import { MemberProviderConfigSchema, RuntimeMetadataSchema } from "../peer/contracts.js";
import { canonicalJson } from "../peer/hash.js";
import type { ModelCall, ModelMetadata } from "../transport/contracts.js";
import { activeDiscussionClaims, activeDiscussionObjections, latestDiscussionAnswers } from "./answers.js";
import { type DiscussionMemberRequest } from "./codec.js";
import { currentCompleteReview, evaluateConsensus } from "./consensus.js";
import {
  DISCUSSION_SCHEMA_VERSION,
  DISCUSSION_PROMPT_VERSION,
  DISCUSSION_CODEC_VERSION,
  DISCUSSION_POLICY_VERSION,
  type DiscussionSession,
  type DiscussionSessionInput,
  type SealedDiscussionReply
} from "./contracts.js";
import { validateFrozenJsonDiscussionRequest } from "./json-codec.js";
import { discussionSnapshotId, sharedDiscussionSnapshot } from "./context.js";
import {
  BudgetCapacityError,
  createBudgetLedger,
  freezeBudgetRoundLimit,
  reserveReviewBudget,
  reserveAttemptBatch,
  reserveRetryAttempts,
  settleBudgetAttempt,
  extendDiscussionBudget,
  type BudgetLedger,
  type AttemptOutcome
} from "./budget.js";
import { selectFinalResult } from "./decision.js";
import {
  createDiscussionSession,
  sealDiscussionReply,
  commitSealedDiscussionBatch,
  freezeDiscussionReview,
  resumeDiscussionAfterReview,
  discussionReviewItemCounts
} from "./protocol.js";
import {
  discussionConstraintContextHash,
  validateConstraintChecks,
  type ConstraintCheck,
  type FinalResult
} from "./result.js";
import { discussionHash, freezeDiscussionValue } from "./state-utils.js";

export type DiscussionModelConfig = z.infer<typeof MemberProviderConfigSchema>;
export interface DiscussionRunInput {
  readonly sessionId: string;
  readonly question: string;
  readonly memberIds?: readonly string[];
  readonly members: Readonly<Record<string, DiscussionModelConfig>>;
  readonly policy: unknown;
  readonly constraints?: readonly string[];
  readonly sources?: DiscussionSessionInput["sources"];
}
export interface FrozenDiscussionJob {
  readonly jobId: string;
  readonly memberId: string;
  readonly phase: DiscussionSession["phase"];
  readonly roundIndex: number;
  readonly snapshotId: string;
  readonly request: DiscussionMemberRequest;
  readonly call: ModelCall;
  readonly inputHash: string;
}
export interface DiscussionRunSegment {
  readonly segmentId: number;
  readonly protocol: DiscussionSession;
  readonly ledger: BudgetLedger;
  readonly members: Readonly<Record<string, DiscussionModelConfig>>;
  readonly jobs: readonly FrozenDiscussionJob[];
  readonly attemptLinks: readonly { readonly attemptId: string; readonly jobId: string }[];
  readonly seals: readonly {
    readonly jobId: string;
    readonly attemptId: string;
    readonly reply: SealedDiscussionReply;
  }[];
  readonly observations: readonly {
    readonly attemptId: string;
    readonly outcome: AttemptOutcome;
    readonly rawContent?: string;
    readonly runtime?: ModelMetadata;
    readonly error?: { readonly code: string; readonly message: string };
  }[];
  readonly currentBatch?: {
    readonly batchId: string;
    readonly phase: DiscussionSession["phase"];
    readonly jobIds: readonly string[];
  };
  readonly activeReviewReservationId?: string;
  readonly status: "active" | "paused" | "completed";
  readonly pauseReason?: { readonly code: string; readonly message: string };
  readonly constraintChecks?: readonly ConstraintCheck[];
  readonly finalResult?: FinalResult;
  readonly stopReason?: "checkpoint" | "round_limit" | "budget_limit";
}
export type DiscussionRunEvent = { readonly atMs: number } & (
  | { readonly type: "reserve_review"; readonly reservationId: string }
  | {
      readonly type: "prepared";
      readonly batchId: string;
      readonly jobs: readonly FrozenDiscussionJob[];
      readonly attemptIds: Readonly<Record<string, string>>;
    }
  | { readonly type: "retry_prepared"; readonly attemptIds: Readonly<Record<string, string>> }
  | {
      readonly type: "settled";
      readonly attemptId: string;
      readonly outcome: AttemptOutcome;
      readonly payload?: unknown;
      readonly rawContent?: string;
      readonly runtime?: ModelMetadata;
      readonly error?: { readonly code: string; readonly message: string };
    }
  | { readonly type: "commit_batch" | "review_started" | "resume_review" | "recovered" | "resumed" }
  | { readonly type: "paused"; readonly code: string; readonly message: string }
  | {
      readonly type: "extended";
      readonly extensionId: string;
      readonly extraCalls?: number;
      readonly extraAllocatedOutputTokens?: number;
      readonly extendMs?: number;
    }
  | { readonly type: "continued"; readonly input: DiscussionRunInput }
  | { readonly type: "constraints_checked"; readonly checks: readonly ConstraintCheck[] }
  | {
      readonly type: "finalized";
      readonly stopReason: "checkpoint" | "round_limit" | "budget_limit";
      readonly constraintChecks?: readonly ConstraintCheck[];
    }
);
export interface DiscussionRun {
  readonly schemaVersion: typeof DISCUSSION_SCHEMA_VERSION;
  readonly promptVersion: typeof DISCUSSION_PROMPT_VERSION;
  readonly codecVersion: typeof DISCUSSION_CODEC_VERSION;
  readonly policyVersion: typeof DISCUSSION_POLICY_VERSION;
  readonly runtimeVersion: "discussion.runtime.v1";
  readonly sessionId: string;
  readonly revision: number;
  readonly initial: DiscussionRunInput;
  readonly startedAtMs: number;
  readonly currentSegmentId: number;
  readonly status: DiscussionRunSegment["status"];
  readonly segments: readonly DiscussionRunSegment[];
  readonly events: readonly DiscussionRunEvent[];
}
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function integer(value: unknown): asserts value is number {
  ensure(Number.isSafeInteger(value) && (value as number) >= 0, "Invalid runtime timestamp or revision");
}
function id(value: unknown): asserts value is string {
  ensure(typeof value === "string" && value.trim(), "Invalid runtime identifier");
}
function record(value: unknown): asserts value is Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
}
function keys(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  record(value);
  ensure(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown runtime field"
  );
}
function json(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    ensure(Number.isFinite(value), "Non-JSON number");
    return;
  }
  ensure(typeof value === "object" && value !== null, "Non-JSON runtime value");
  ensure(
    Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "Non-JSON object"
  );
  for (const child of Object.values(value)) {
    if (child !== undefined) json(child);
  }
}
function exactRoster(ids: readonly string[], map: Readonly<Record<string, unknown>>) {
  record(map);
  ensure(
    Object.keys(map).length === ids.length && ids.every((member) => Object.hasOwn(map, member)),
    "Runtime roster mismatch"
  );
}
function normalizeInput(
  input: DiscussionRunInput,
  segmentId: number
): { input: DiscussionRunInput; segment: DiscussionRunSegment } {
  keys(input, ["sessionId", "question", "memberIds", "members", "policy", "constraints", "sources"]);
  record(input.members);
  const memberIds = input.memberIds ?? Object.keys(input.members);
  exactRoster(memberIds, input.members);
  const members = Object.fromEntries(
    memberIds.map((member) => [member, MemberProviderConfigSchema.parse(input.members[member])])
  );
  const protocol = createDiscussionSession({ ...input, memberIds, segmentId, contextVersion: segmentId });
  const normalized = {
    sessionId: protocol.sessionId,
    question: protocol.question,
    memberIds: protocol.memberIds,
    members,
    policy: protocol.policy,
    constraints: protocol.constraints,
    sources: protocol.sources.map(({ sourceId, name, content }) => ({
      sourceId,
      ...(name === undefined ? {} : { name }),
      content
    }))
  };
  return {
    input: normalized,
    segment: {
      segmentId,
      protocol,
      ledger: createBudgetLedger(protocol.policy, 0),
      members,
      jobs: [],
      attemptLinks: [],
      seals: [],
      observations: [],
      status: "active"
    }
  };
}
export function createDiscussionRun(input: DiscussionRunInput, atMs: number): DiscussionRun {
  integer(atMs);
  const normalized = normalizeInput(input, 1);
  return freezeDiscussionValue(
    structuredClone({
      schemaVersion: DISCUSSION_SCHEMA_VERSION,
      promptVersion: DISCUSSION_PROMPT_VERSION,
      codecVersion: DISCUSSION_CODEC_VERSION,
      policyVersion: DISCUSSION_POLICY_VERSION,
      runtimeVersion: "discussion.runtime.v1" as const,
      sessionId: normalized.input.sessionId,
      revision: 0,
      initial: normalized.input,
      startedAtMs: atMs,
      currentSegmentId: 1,
      status: "active" as const,
      segments: [{ ...normalized.segment, ledger: createBudgetLedger(normalized.segment.protocol.policy, atMs) }],
      events: []
    })
  );
}
export function currentDiscussionSegment(run: DiscussionRun): DiscussionRunSegment {
  const segment = run.segments.find((item) => item.segmentId === run.currentSegmentId);
  ensure(segment, "Missing current segment");
  return segment;
}
/** Historical answer checks stay recorded, but do not transfer to a newer version.
 * Context/global evidence remains effective throughout its original frozen segment. */
export function currentDiscussionConstraintChecks(segment: DiscussionRunSegment): readonly ConstraintCheck[] {
  const ids = new Set(latestDiscussionAnswers(segment.protocol).map((answer) => answer.answerVersionId));
  const contextHash = discussionConstraintContextHash(segment.protocol);
  return validateConstraintChecks(
    segment.protocol,
    (segment.constraintChecks ?? []).filter(
      (check) => check.contextHash === contextHash && (check.answerVersionId === null || ids.has(check.answerVersionId))
    )
  );
}
export function frozenDiscussionJobHash(job: Omit<FrozenDiscussionJob, "inputHash"> | FrozenDiscussionJob): string {
  const { jobId, memberId, phase, roundIndex, snapshotId, request, call } = job;
  return discussionHash({ jobId, memberId, phase, roundIndex, snapshotId, request, call });
}
/** Conservative action capacity before discussion; actual checkpoints never drop a member or item. */
export function prospectiveReviewCounts(segment: DiscussionRunSegment): Record<string, number> {
  const state = segment.protocol;
  const n = state.memberIds.length;
  const count =
    state.phase === "opening"
      ? 6 * n
      : activeDiscussionClaims(state).length + 3 * n + activeDiscussionObjections(state).length;
  return Object.fromEntries(state.memberIds.map((member) => [member, count]));
}
export function canStartNextDiscussion(segment: DiscussionRunSegment, nowMs: number): boolean {
  integer(nowMs);
  if (segment.ledger.roundLimit === undefined || segment.protocol.roundIndex - 1 >= segment.ledger.roundLimit)
    return false;
  try {
    const availableReservation = segment.ledger.reservations.find(
      (item) => item.reservationId === segment.activeReviewReservationId && !Object.keys(item.attemptIds).length
    );
    const reservationId =
      availableReservation?.reservationId ??
      `probe-review-${segment.protocol.roundIndex}-${segment.ledger.reservations.length}`;
    const reserved = reserveReviewBudget(segment.ledger, reservationId, prospectiveReviewCounts(segment), nowMs);
    reserveAttemptBatch(
      reserved,
      {
        phase: "discussion",
        roundIndex: segment.protocol.roundIndex - 1,
        attemptIds: Object.fromEntries(
          segment.protocol.memberIds.map((member, index) => [
            member,
            `probe-attempt-${segment.ledger.attempts.length}-${index}`
          ])
        )
      },
      nowMs
    );
    return true;
  } catch (error) {
    if (error instanceof BudgetCapacityError) return false;
    throw error;
  }
}
function validateJob(segment: DiscussionRunSegment, job: FrozenDiscussionJob, maxOutputTokens: number): void {
  keys(job, ["jobId", "memberId", "phase", "roundIndex", "snapshotId", "request", "call", "inputHash"]);
  id(job.jobId);
  const state = segment.protocol;
  ensure(
    job.phase === state.phase && job.roundIndex === state.roundIndex && job.snapshotId === discussionSnapshotId(state),
    "Frozen job snapshot mismatch"
  );
  ensure(state.memberIds.includes(job.memberId), "Unknown job member");
  const request = job.request;
  keys(request, ["memberId", "snapshotId", "codecVersion", "maxOutputTokens", "messages", "outputSchema", "inputHash"]);
  const { inputHash, ...requestFields } = request;
  ensure(inputHash === discussionHash(requestFields), "Frozen request hash mismatch");
  ensure(
    request.memberId === job.memberId &&
      request.snapshotId === job.snapshotId &&
      request.codecVersion === state.codecVersion &&
      request.maxOutputTokens === maxOutputTokens,
    "Frozen request binding mismatch"
  );
  keys(job.call, [
    "protocol",
    "baseUrl",
    "modelId",
    "apiKeyEnv",
    "messages",
    "outputMode",
    "maxOutputTokens",
    "generationOptions"
  ]);
  const config = segment.members[job.memberId]!;
  ensure(
    equal(job.call, {
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      apiKeyEnv: config.apiKeyEnv,
      outputMode: config.outputMode,
      generationOptions: config.generationOptions,
      messages: request.messages,
      maxOutputTokens
    }),
    "Frozen model configuration mismatch"
  );
  ensure(Array.isArray(request.messages) && request.messages.length > 0, "Missing frozen messages");
  for (const message of request.messages) {
    keys(message, ["role", "content"]);
    ensure(
      ["system", "user"].includes(message.role as string) && typeof message.content === "string",
      "Invalid frozen message"
    );
  }
  record(request.outputSchema);
  validateFrozenJsonDiscussionRequest(
    sharedDiscussionSnapshot(state),
    { memberId: job.memberId, maxOutputTokens },
    request
  );
  ensure(
    request.messages.reduce((total, message) => total + message.content.length, 0) <=
      Math.min(100000, config.maxInputCharacters ?? 100000),
    "Frozen input exceeds character cap"
  );
  ensure(job.inputHash === frozenDiscussionJobHash(job), "Frozen job hash mismatch");
}
const eventKeys: Record<DiscussionRunEvent["type"], readonly string[]> = {
  reserve_review: ["reservationId"],
  prepared: ["batchId", "jobs", "attemptIds"],
  retry_prepared: ["attemptIds"],
  settled: ["attemptId", "outcome", "payload", "rawContent", "runtime", "error"],
  commit_batch: [],
  review_started: [],
  resume_review: [],
  recovered: [],
  resumed: [],
  paused: ["code", "message"],
  extended: ["extensionId", "extraCalls", "extraAllocatedOutputTokens", "extendMs"],
  continued: ["input"],
  constraints_checked: ["checks"],
  finalized: ["stopReason", "constraintChecks"]
};
function reduce(run: DiscussionRun, event: DiscussionRunEvent): DiscussionRun {
  json(event);
  record(event);
  ensure(Object.hasOwn(eventKeys, event.type), "Invalid runtime event type");
  keys(event, ["type", "atMs", ...eventKeys[event.type]]);
  integer(event.atMs);
  ensure(event.atMs >= (run.events.at(-1)?.atMs ?? run.startedAtMs), "Runtime clock cannot move backwards");
  const current = currentDiscussionSegment(run);
  ensure(current.status !== "completed" || event.type === "continued", "Completed segment is immutable");
  let next: DiscussionRunSegment = { ...current };
  const hasPending = () => next.ledger.attempts.some((attempt) => attempt.status === "pending");
  const active = () => ensure(next.status === "active", "Runtime segment must be active");
  const idle = () => ensure(!hasPending(), "Pending attempts prevent transition");
  switch (event.type) {
    case "reserve_review": {
      active();
      idle();
      ensure(!next.currentBatch, "Cannot reserve during a pending batch");
      next = {
        ...next,
        ledger: reserveReviewBudget(next.ledger, event.reservationId, prospectiveReviewCounts(next), event.atMs),
        activeReviewReservationId: event.reservationId
      };
      break;
    }
    case "prepared": {
      active();
      idle();
      ensure(!next.currentBatch, "Batch already prepared");
      id(event.batchId);
      ensure(!run.events.some((old) => old.type === "prepared" && old.batchId === event.batchId), "Duplicate batch ID");
      ensure(next.protocol.phase !== "review" || !currentCompleteReview(next.protocol), "Review already committed");
      ensure(
        Array.isArray(event.jobs) && event.jobs.length === next.protocol.memberIds.length,
        "Complete jobs required"
      );
      exactRoster(next.protocol.memberIds, Object.fromEntries(event.jobs.map((job) => [job.memberId, job.jobId])));
      const ledger = reserveAttemptBatch(
        next.ledger,
        {
          phase: next.protocol.phase,
          attemptIds: event.attemptIds,
          ...(next.protocol.phase === "discussion" ? { roundIndex: next.protocol.roundIndex - 1 } : {}),
          ...(next.protocol.phase === "review" ? { reservationId: next.activeReviewReservationId } : {})
        },
        event.atMs
      );
      const newIds = new Set(run.segments.flatMap((segment) => segment.jobs.map((job) => job.jobId)));
      for (const job of event.jobs) {
        ensure(!newIds.has(job.jobId), "Duplicate job ID");
        newIds.add(job.jobId);
        validateJob(
          next,
          job,
          ledger.attempts.find((attempt) => attempt.attemptId === event.attemptIds[job.memberId])!.maxOutputTokens
        );
      }
      next = {
        ...next,
        ledger,
        jobs: [...next.jobs, ...event.jobs],
        attemptLinks: [
          ...next.attemptLinks,
          ...event.jobs.map((job) => ({ jobId: job.jobId, attemptId: event.attemptIds[job.memberId]! }))
        ],
        currentBatch: { batchId: event.batchId, phase: next.protocol.phase, jobIds: event.jobs.map((job) => job.jobId) }
      };
      break;
    }
    case "retry_prepared": {
      ensure(next.status === "paused" && next.currentBatch, "Retry requires paused batch");
      idle();
      const missing = next.currentBatch.jobIds
        .filter((jobId) => !next.seals.some((seal) => seal.jobId === jobId))
        .map((jobId) => next.jobs.find((job) => job.jobId === jobId)!);
      ensure(missing.length, "No missing member to retry");
      exactRoster(
        missing.map((job) => job.memberId),
        event.attemptIds
      );
      const prior = Object.fromEntries(
        missing.map((job) => [
          job.memberId,
          next.attemptLinks.filter((link) => link.jobId === job.jobId).at(-1)!.attemptId
        ])
      );
      next = {
        ...next,
        ledger: reserveRetryAttempts(next.ledger, event.attemptIds, prior, event.atMs),
        status: "active",
        pauseReason: undefined,
        attemptLinks: [
          ...next.attemptLinks,
          ...missing.map((job) => ({ jobId: job.jobId, attemptId: event.attemptIds[job.memberId]! }))
        ]
      };
      break;
    }
    case "settled": {
      active();
      ensure(next.currentBatch, "Settlement requires active batch");
      const link = next.attemptLinks.find((item) => item.attemptId === event.attemptId);
      ensure(link && next.currentBatch.jobIds.includes(link.jobId), "Attempt not in current batch");
      ensure(
        next.attemptLinks.filter((item) => item.jobId === link.jobId).at(-1)?.attemptId === event.attemptId,
        "Stale attempt response"
      );
      const job = next.jobs.find((item) => item.jobId === link.jobId)!;
      if (event.runtime !== undefined) RuntimeMetadataSchema.parse(event.runtime);
      if (event.rawContent !== undefined) ensure(typeof event.rawContent === "string", "Invalid raw observation");
      if (event.error !== undefined) {
        keys(event.error, ["code", "message"]);
        id(event.error.code);
        id(event.error.message);
      }
      const usage = event.runtime?.usage;
      next = {
        ...next,
        ledger: settleBudgetAttempt(
          next.ledger,
          event.attemptId,
          event.outcome,
          event.atMs,
          usage
            ? {
                ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
                ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens })
              }
            : undefined
        )
      };
      if (event.outcome === "succeeded") {
        ensure(event.payload !== undefined, "Successful response requires payload");
        const protocol = sealDiscussionReply(next.protocol, {
          memberId: job.memberId,
          snapshotId: job.snapshotId,
          payload: event.payload
        });
        const reply = protocol.pendingBatch!.sealedReplies.find((item) => item.memberId === job.memberId)!;
        next = { ...next, protocol, seals: [...next.seals, { jobId: job.jobId, attemptId: event.attemptId, reply }] };
      }
      next = {
        ...next,
        observations: [
          ...next.observations,
          {
            attemptId: event.attemptId,
            outcome: event.outcome,
            ...(event.rawContent === undefined ? {} : { rawContent: event.rawContent }),
            ...(event.runtime === undefined ? {} : { runtime: event.runtime }),
            ...(event.error === undefined ? {} : { error: event.error })
          }
        ]
      };
      break;
    }
    case "commit_batch": {
      active();
      idle();
      ensure(next.currentBatch, "No batch to commit");
      ensure(
        next.currentBatch.jobIds.every((jobId) => next.seals.some((seal) => seal.jobId === jobId)),
        "Successful half batch cannot commit"
      );
      const protocol = commitSealedDiscussionBatch(next.protocol);
      next = {
        ...next,
        protocol,
        currentBatch: undefined,
        ledger:
          next.currentBatch.phase === "opening"
            ? freezeBudgetRoundLimit(next.ledger, protocol.complexities)
            : next.ledger
      };
      break;
    }
    case "review_started": {
      active();
      idle();
      ensure(!next.currentBatch && next.activeReviewReservationId, "Review requires reserved full budget");
      const protocol = freezeDiscussionReview(next.protocol);
      next = {
        ...next,
        protocol,
        ledger: reserveReviewBudget(
          next.ledger,
          next.activeReviewReservationId,
          discussionReviewItemCounts(protocol),
          event.atMs
        )
      };
      break;
    }
    case "resume_review": {
      active();
      idle();
      ensure(!next.currentBatch && currentCompleteReview(next.protocol), "Review must be complete");
      const checks = currentDiscussionConstraintChecks(next);
      ensure(
        !checks.some((check) => check.answerVersionId === null && check.status === "failed"),
        "Failed global constraint prevents further discussion in this segment"
      );
      ensure(!evaluateConsensus(next.protocol, checks).length, "Consensus must stop subsequent discussion");
      ensure(
        next.activeReviewReservationId &&
          next.ledger.reservations.some(
            (reservation) =>
              reservation.reservationId === next.activeReviewReservationId &&
              !Object.keys(reservation.attemptIds).length
          ),
        "Next discussion requires new review reservation"
      );
      next = { ...next, protocol: resumeDiscussionAfterReview(next.protocol) };
      break;
    }
    case "paused": {
      active();
      idle();
      id(event.code);
      id(event.message);
      next = { ...next, status: "paused", pauseReason: { code: event.code, message: event.message } };
      break;
    }
    case "recovered": {
      ensure(next.status !== "completed", "Finalized results never recover by dispatch");
      for (const attempt of next.ledger.attempts)
        if (attempt.status === "pending")
          next = { ...next, ledger: settleBudgetAttempt(next.ledger, attempt.attemptId, "unknown", event.atMs) };
      next = {
        ...next,
        status: "paused",
        pauseReason: { code: "recovered_interruption", message: "Recovered state; explicit resume or retry required" }
      };
      break;
    }
    case "resumed": {
      ensure(next.status === "paused", "Resume requires pause");
      idle();
      next = { ...next, status: "active", pauseReason: undefined };
      break;
    }
    case "extended": {
      ensure(next.status === "paused", "Extension requires explicit paused state");
      idle();
      next = { ...next, ledger: extendDiscussionBudget(next.ledger, event, event.atMs) };
      break;
    }
    case "continued": {
      ensure(
        next.status === "completed" || next.status === "paused",
        "Continuation requires complete or paused segment"
      );
      idle();
      ensure(event.input.sessionId === run.sessionId, "Continuation cannot change session ID");
      const addition = normalizeInput(event.input, run.currentSegmentId + 1).segment;
      const segment = { ...addition, ledger: createBudgetLedger(addition.protocol.policy, event.atMs) };
      return freezeDiscussionValue({
        ...run,
        revision: run.revision + 1,
        currentSegmentId: segment.segmentId,
        status: "active",
        segments: [...run.segments, segment],
        events: [...run.events, structuredClone(event)]
      });
    }
    case "constraints_checked": {
      active();
      idle();
      ensure(!next.currentBatch && currentCompleteReview(next.protocol), "Constraint checks require complete review");
      const checks = validateConstraintChecks(next.protocol, event.checks);
      const previous = next.constraintChecks ?? [];
      for (const check of checks) {
        const prior = previous.find((item) => item.checkId === check.checkId);
        ensure(!prior || equal(prior, check), "Persisted constraint check ID is immutable");
      }
      next = {
        ...next,
        constraintChecks: [
          ...previous,
          ...checks.filter((check) => !previous.some((item) => item.checkId === check.checkId))
        ]
      };
      break;
    }
    case "finalized": {
      active();
      idle();
      ensure(!next.currentBatch && currentCompleteReview(next.protocol), "Finalization requires complete review");
      ensure(event.atMs < next.ledger.deadlineAtMs, "Deadline is an abnormal stop");
      const effectiveChecks = currentDiscussionConstraintChecks(next);
      ensure(
        equal(event.constraintChecks ?? [], effectiveChecks),
        "Finalization must preserve all persisted constraint checks"
      );
      if (event.stopReason === "checkpoint")
        ensure(evaluateConsensus(next.protocol, effectiveChecks).length, "Checkpoint lacks consensus");
      else if (event.stopReason === "round_limit")
        ensure(
          next.ledger.roundLimit !== undefined && next.protocol.roundIndex - 1 >= next.ledger.roundLimit,
          "Round limit not reached"
        );
      else if (event.stopReason === "budget_limit")
        ensure(
          next.ledger.roundLimit !== undefined &&
            next.protocol.roundIndex - 1 < next.ledger.roundLimit &&
            !canStartNextDiscussion(next, event.atMs),
          "Budget limit not established"
        );
      else throw new Error("Invalid normal stop reason");
      const finalResult = selectFinalResult({
        session: next.protocol,
        stopReason: event.stopReason,
        constraintChecks: effectiveChecks
      });
      ensure(finalResult.outcome !== "incomplete", "Cannot finalize incomplete selection");
      next = { ...next, finalResult, stopReason: event.stopReason, status: "completed", pauseReason: undefined };
      break;
    }
  }
  return freezeDiscussionValue({
    ...run,
    revision: run.revision + 1,
    status: next.status,
    segments: run.segments.map((segment) => (segment === current ? next : segment)),
    events: [...run.events, structuredClone(event)]
  });
}
export function appendDiscussionRunEvent(run: DiscussionRun, event: DiscussionRunEvent): DiscussionRun {
  return reduce(parseDiscussionRun(run), structuredClone(event));
}
/** Rebuild every cached field from frozen initial input and append-only events; no codec or model invocation. */
export function parseDiscussionRun(raw: unknown): DiscussionRun {
  keys(raw, [
    "schemaVersion",
    "promptVersion",
    "codecVersion",
    "policyVersion",
    "runtimeVersion",
    "sessionId",
    "revision",
    "initial",
    "startedAtMs",
    "currentSegmentId",
    "status",
    "segments",
    "events"
  ]);
  ensure(
    raw.schemaVersion === DISCUSSION_SCHEMA_VERSION &&
      raw.promptVersion === DISCUSSION_PROMPT_VERSION &&
      raw.codecVersion === DISCUSSION_CODEC_VERSION &&
      raw.policyVersion === DISCUSSION_POLICY_VERSION &&
      raw.runtimeVersion === "discussion.runtime.v1",
    "Unsupported discussion runtime version"
  );
  integer(raw.revision);
  integer(raw.startedAtMs);
  ensure(Array.isArray(raw.events), "Missing runtime history");
  json(raw);
  let replay = createDiscussionRun(raw.initial as DiscussionRunInput, raw.startedAtMs);
  for (const event of raw.events) replay = reduce(replay, event as DiscussionRunEvent);
  ensure(equal(raw, replay), "Corrupt runtime history or cached state");
  return replay;
}
/** Store adapters accept exactly one event and preserve the entire old event prefix. */
export function validateDiscussionRunTransition(next: DiscussionRun, current?: DiscussionRun): void {
  const parsed = parseDiscussionRun(next);
  if (!current) {
    ensure(parsed.revision === 0 && !parsed.events.length, "New runtime must start at revision zero");
    return;
  }
  const old = parseDiscussionRun(current);
  ensure(
    parsed.sessionId === old.sessionId && parsed.startedAtMs === old.startedAtMs && equal(parsed.initial, old.initial),
    "Immutable runtime initial input changed"
  );
  ensure(
    parsed.revision === old.revision + 1 &&
      parsed.events.length === old.events.length + 1 &&
      equal(parsed.events.slice(0, old.events.length), old.events),
    "Runtime transition must append exactly one event"
  );
}
