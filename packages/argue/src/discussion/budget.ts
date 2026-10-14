import { type AgentId, type Complexity, type DiscussionPolicy } from "./contracts.js";
import {
  discussionEffortDefaults,
  normalizeDiscussionPolicy,
  resolveRoundLimit,
  validateDiscussionMemberIds
} from "./policy.js";

export const OPENING_OUTPUT_TOKENS = 2048;
export const DISCUSSION_OUTPUT_FLOOR = 2048;
export const REVIEW_OUTPUT_FLOOR = 4096;
export const REVIEW_TOKENS_PER_ITEM = 256;

/** A valid operation cannot fit within the currently authorized hard caps. */
export class BudgetCapacityError extends Error {
  override readonly name = "BudgetCapacityError";
}

export interface BudgetExtension {
  readonly extensionId: string;
  readonly atMs: number;
  readonly extraCalls: number;
  readonly extraAllocatedOutputTokens: number;
  readonly extendMs: number;
}

type Allocation = Readonly<Record<AgentId, number>>;
export type BudgetPhase = "opening" | "discussion" | "review";
export type AttemptOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export interface ObservedBudgetUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}
export interface BudgetAttempt {
  readonly attemptId: string;
  readonly memberId: AgentId;
  readonly phase: BudgetPhase;
  readonly roundIndex?: number;
  readonly reservationId?: string;
  readonly maxOutputTokens: number;
  readonly chargedAtMs: number;
  readonly timeoutMs: number;
  readonly deadlineAtMs: number;
  readonly status: "pending" | AttemptOutcome;
  readonly settledAtMs?: number;
  readonly observedUsage?: ObservedBudgetUsage;
}
export interface ReviewReservation {
  readonly reservationId: string;
  readonly checkpointId: string;
  readonly kind: "checkpoint" | "retry";
  readonly createdAtMs: number;
  readonly windowMs: number;
  readonly allocation: Allocation;
  readonly attemptIds: Readonly<Record<AgentId, string>>;
  readonly updates: readonly { readonly atMs: number; readonly allocation: Allocation }[];
}
export interface BudgetLedger {
  readonly ledgerVersion: "discussion-budget-v1";
  readonly policy: DiscussionPolicy;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly lastRecordedAtMs: number;
  readonly roundLimit?: number;
  readonly attempts: readonly BudgetAttempt[];
  readonly reservations: readonly ReviewReservation[];
  readonly extensions?: readonly BudgetExtension[];
}
export interface AttemptBatch {
  readonly phase: BudgetPhase;
  readonly attemptIds: Readonly<Record<AgentId, string>>;
  /** Zero-based discussion index; also drives integer remainder rotation. */
  readonly roundIndex?: number;
  readonly reservationId?: string;
}

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`);
}
function identifier(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
}
function exactMembers(ids: readonly AgentId[], value: Readonly<Record<AgentId, unknown>>): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(value, id))
  )
    throw new Error("Allocation must include every expected member and no unknown member");
}
const frozenAllocation = (pairs: Array<readonly [string, number]>): Allocation =>
  Object.freeze(Object.fromEntries(pairs));
function freezeReservation(reservation: ReviewReservation): ReviewReservation {
  return Object.freeze({
    ...reservation,
    allocation: Object.freeze({ ...reservation.allocation }),
    attemptIds: Object.freeze({ ...reservation.attemptIds }),
    updates: Object.freeze(
      reservation.updates.map((update) =>
        Object.freeze({ ...update, allocation: Object.freeze({ ...update.allocation }) })
      )
    )
  });
}
function freezeLedger(ledger: BudgetLedger): BudgetLedger {
  return Object.freeze({
    ...ledger,
    attempts: Object.freeze(
      ledger.attempts.map((attempt) =>
        Object.freeze({
          ...attempt,
          ...(attempt.observedUsage === undefined ? {} : { observedUsage: Object.freeze({ ...attempt.observedUsage }) })
        })
      )
    ),
    reservations: Object.freeze(ledger.reservations.map(freezeReservation)),
    ...(ledger.extensions === undefined
      ? {}
      : { extensions: Object.freeze(ledger.extensions.map((extension) => Object.freeze({ ...extension }))) })
  });
}

/** Equal floors first, then exact largest remainders; no floating-point pool overrun. */
export function allocateDiscussionTokens(
  memberIds: readonly AgentId[],
  weights: Readonly<Record<AgentId, number>>,
  totalPool: number,
  floor: number,
  roundIndex: number
): Record<AgentId, number> {
  validateDiscussionMemberIds(memberIds);
  exactMembers(memberIds, weights);
  integer(totalPool, "Output pool");
  integer(floor, "Member floor", 1);
  integer(roundIndex, "Round index");
  for (const id of memberIds) {
    const weight = weights[id]!;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0.1 || weight > 100)
      throw new Error("Participation weight must be finite and between 0.1 and 100");
  }
  const remainder = BigInt(totalPool) - BigInt(floor) * BigInt(memberIds.length);
  if (remainder < 0n) throw new BudgetCapacityError("Output budget cannot fund every member floor");
  // Values in 0.1..100 stringify as plain decimal numbers. Scale them to
  // integers so very large pools and nearly equal weights remain deterministic.
  const decimals = memberIds.map((id) => weights[id]!.toString().split("."));
  const scale = Math.max(...decimals.map((parts) => parts[1]?.length ?? 0));
  const wholeWeights = decimals.map((parts) => BigInt(parts[0]! + (parts[1] ?? "").padEnd(scale, "0")));
  const sum = wholeWeights.reduce((total, weight) => total + weight, 0n);
  const portions = wholeWeights.map((weight, index) => ({
    index,
    extra: (remainder * weight) / sum,
    fraction: (remainder * weight) % sum
  }));
  const spare = Number(remainder - portions.reduce((total, item) => total + item.extra, 0n));
  const rotation = roundIndex % memberIds.length;
  const order = [...portions].sort((left, right) =>
    left.fraction === right.fraction
      ? ((left.index - rotation + memberIds.length) % memberIds.length) -
        ((right.index - rotation + memberIds.length) % memberIds.length)
      : left.fraction > right.fraction
        ? -1
        : 1
  );
  for (const item of order.slice(0, spare)) item.extra += 1n;
  return Object.fromEntries(portions.map((item) => [memberIds[item.index]!, floor + Number(item.extra)]));
}
export function allocateRoundTokens(policy: DiscussionPolicy, roundIndex: number): Record<AgentId, number> {
  const ids = policy.roundingOrder;
  return allocateDiscussionTokens(
    ids,
    Object.fromEntries(ids.map((id) => [id, policy.weights[id]!.participationWeight])),
    discussionEffortDefaults(policy.effort, ids.length).discussionTokenPool,
    DISCUSSION_OUTPUT_FLOOR,
    roundIndex
  );
}
/** Coverage, never participation or decision weight, determines review quota. */
export function allocateReviewTokens(
  memberIds: readonly AgentId[],
  requiredReviewItems: Readonly<Record<AgentId, number>>
): Record<AgentId, number> {
  validateDiscussionMemberIds(memberIds);
  exactMembers(memberIds, requiredReviewItems);
  return Object.fromEntries(
    memberIds.map((id) => {
      integer(requiredReviewItems[id]!, "Required review items");
      const quota = Math.max(REVIEW_OUTPUT_FLOOR, REVIEW_TOKENS_PER_ITEM * requiredReviewItems[id]!);
      integer(quota, "Review output quota", 1);
      return [id, quota];
    })
  );
}

export function createBudgetLedger(policy: DiscussionPolicy, startedAtMs: number): BudgetLedger {
  integer(startedAtMs, "Start time");
  // Copy and revalidate the complete policy so subsequent caller edits cannot
  // alter a running segment's caps, roster, weights or rounding order.
  const snapshot = normalizeDiscussionPolicy(policy, policy.roundingOrder);
  const deadlineAtMs = startedAtMs + snapshot.maxDurationMs;
  integer(deadlineAtMs, "Segment deadline");
  return freezeLedger({
    ledgerVersion: "discussion-budget-v1",
    policy: snapshot,
    startedAtMs,
    deadlineAtMs,
    lastRecordedAtMs: startedAtMs,
    attempts: [],
    reservations: []
  });
}
export function freezeBudgetRoundLimit(ledger: BudgetLedger, complexities: Record<AgentId, Complexity>): BudgetLedger {
  if (ledger.roundLimit !== undefined) throw new Error("Discussion round limit is already frozen");
  return freezeLedger({ ...ledger, roundLimit: resolveRoundLimit(ledger.policy, complexities) });
}
function clock(ledger: BudgetLedger, nowMs: number): void {
  integer(nowMs, "Current time");
  if (nowMs < ledger.lastRecordedAtMs) throw new Error("Budget clock cannot move backwards");
}
function pendingMembers(reservation: ReviewReservation): AgentId[] {
  return Object.keys(reservation.allocation).filter((id) => !Object.hasOwn(reservation.attemptIds, id));
}
/** Remaining caps include reserved amounts; available dispatch quota subtracts them. */
export function remainingBudget(ledger: BudgetLedger, nowMs: number) {
  clock(ledger, nowMs);
  let reservedCalls = 0,
    reservedOutputTokens = 0,
    reservedReviewDurationMs = 0;
  for (const reservation of ledger.reservations) {
    const pending = pendingMembers(reservation);
    reservedCalls += pending.length;
    reservedOutputTokens += pending.reduce((total, id) => total + reservation.allocation[id]!, 0);
    // The roster uses one parallel review window, not N serial windows.
    if (pending.length) reservedReviewDurationMs = Math.max(reservedReviewDurationMs, reservation.windowMs);
  }
  return {
    remainingCalls:
      ledger.policy.maxCalls +
      (ledger.extensions ?? []).reduce((total, extension) => total + extension.extraCalls, 0) -
      ledger.attempts.length,
    remainingAllocatedOutputTokens:
      ledger.policy.maxAllocatedOutputTokens +
      (ledger.extensions ?? []).reduce((total, extension) => total + extension.extraAllocatedOutputTokens, 0) -
      ledger.attempts.reduce((total, a) => total + a.maxOutputTokens, 0),
    remainingDurationMs: Math.max(0, ledger.deadlineAtMs - nowMs),
    reservedCalls,
    reservedOutputTokens,
    reservedReviewDurationMs
  };
}
function assertCapacity(ledger: BudgetLedger, nowMs: number): void {
  const remaining = remainingBudget(ledger, nowMs);
  if (
    remaining.remainingCalls < remaining.reservedCalls ||
    remaining.remainingAllocatedOutputTokens < remaining.reservedOutputTokens
  )
    throw new BudgetCapacityError("Budget cannot fund all attempts and complete review quotas");
  if (remaining.remainingDurationMs < remaining.reservedReviewDurationMs || remaining.remainingDurationMs <= 0)
    throw new BudgetCapacityError("Time budget cannot fund the full review window before the deadline");
}

/** Reserve all reviewers atomically. Coverage may grow before dispatch, never shrink. */
export function reserveReviewBudget(
  ledger: BudgetLedger,
  reservationId: string,
  requiredReviewItems: Readonly<Record<AgentId, number>>,
  nowMs: number
): BudgetLedger {
  clock(ledger, nowMs);
  identifier(reservationId, "review reservation ID");
  const required = allocateReviewTokens(ledger.policy.roundingOrder, requiredReviewItems);
  const existing = ledger.reservations.find((item) => item.reservationId === reservationId);
  if (existing && (existing.kind !== "checkpoint" || Object.keys(existing.attemptIds).length))
    throw new Error("Dispatched review reservation is frozen");
  if (!existing && ledger.reservations.some((item) => pendingMembers(item).length))
    throw new Error("An unused complete review reservation already exists");
  const allocation = frozenAllocation(
    ledger.policy.roundingOrder.map((id) => [id, Math.max(required[id]!, existing?.allocation[id] ?? 0)])
  );
  const reservation: ReviewReservation = {
    reservationId,
    checkpointId: reservationId,
    kind: "checkpoint",
    createdAtMs: existing?.createdAtMs ?? nowMs,
    windowMs: ledger.policy.callTimeoutMs,
    allocation,
    attemptIds: {},
    updates: [...(existing?.updates ?? []), { atMs: nowMs, allocation }]
  };
  const next = {
    ...ledger,
    lastRecordedAtMs: nowMs,
    reservations: existing
      ? ledger.reservations.map((item) => (item === existing ? reservation : item))
      : [...ledger.reservations, reservation]
  };
  assertCapacity(next, nowMs);
  return freezeLedger(next);
}
/** An explicit retry reserves the same full member quota and never refunds the old attempt. */
export function reserveReviewRetry(
  ledger: BudgetLedger,
  reservationId: string,
  checkpointId: string,
  memberId: AgentId,
  nowMs: number
): BudgetLedger {
  clock(ledger, nowMs);
  identifier(reservationId, "review retry ID");
  const checkpoint = ledger.reservations.find(
    (item) => item.reservationId === checkpointId && item.kind === "checkpoint"
  );
  if (!checkpoint || !Object.hasOwn(checkpoint.allocation, memberId))
    throw new Error("Unknown review checkpoint or member");
  if (ledger.reservations.some((item) => item.reservationId === reservationId))
    throw new Error("Review reservation ID already exists");
  const related = ledger.reservations.filter((item) => item.checkpointId === checkpointId);
  if (related.some((item) => pendingMembers(item).includes(memberId)))
    throw new Error("Member review quota is already reserved");
  const attempts = ledger.attempts.filter(
    (attempt) => attempt.memberId === memberId && related.some((item) => item.reservationId === attempt.reservationId)
  );
  const previous = attempts.at(-1);
  if (!previous || previous.status === "pending" || previous.status === "succeeded")
    throw new Error("Only a failed, cancelled or unknown review attempt may be explicitly retried");
  const allocation = frozenAllocation([[memberId, previous.maxOutputTokens]]);
  const reservation: ReviewReservation = {
    reservationId,
    checkpointId,
    kind: "retry",
    createdAtMs: nowMs,
    windowMs: checkpoint.windowMs,
    allocation,
    attemptIds: {},
    updates: [{ atMs: nowMs, allocation }]
  };
  const next = { ...ledger, lastRecordedAtMs: nowMs, reservations: [...ledger.reservations, reservation] };
  assertCapacity(next, nowMs);
  return freezeLedger(next);
}

/** Build and charge the entire required batch before the host persists it and dispatches. */
export function reserveAttemptBatch(ledger: BudgetLedger, batch: AttemptBatch, nowMs: number): BudgetLedger {
  clock(ledger, nowMs);
  if (!["opening", "discussion", "review"].includes(batch.phase)) throw new Error("Invalid budget phase");
  const balance = remainingBudget(ledger, nowMs);
  let allocation: Allocation;
  let reservation: ReviewReservation | undefined;
  let timeoutMs: number;
  if (batch.phase === "review") {
    reservation = ledger.reservations.find((item) => item.reservationId === batch.reservationId);
    if (!reservation || !pendingMembers(reservation).length) throw new Error("Missing or consumed review reservation");
    allocation = frozenAllocation(pendingMembers(reservation).map((id) => [id, reservation!.allocation[id]!]));
    timeoutMs = reservation.windowMs;
    if (balance.remainingDurationMs < timeoutMs)
      throw new BudgetCapacityError("Time budget cannot fund a complete review before the deadline");
  } else {
    if (batch.reservationId !== undefined) throw new Error("Non-review attempts cannot consume a review reservation");
    if (
      !ledger.reservations.some(
        (item) => item.kind === "checkpoint" && pendingMembers(item).length === ledger.policy.roundingOrder.length
      )
    )
      throw new Error("Reserve a complete review before non-review dispatch");
    if (batch.phase === "opening") {
      if (batch.roundIndex !== undefined) throw new Error("Opening has no discussion round index");
      allocation = frozenAllocation(ledger.policy.roundingOrder.map((id) => [id, OPENING_OUTPUT_TOKENS]));
    } else {
      if (ledger.roundLimit === undefined || batch.roundIndex === undefined)
        throw new Error("Discussion requires a frozen round limit and round index");
      integer(batch.roundIndex, "Discussion round index");
      if (batch.roundIndex >= ledger.roundLimit) throw new Error("Discussion round limit exceeded");
      allocation = allocateRoundTokens(ledger.policy, batch.roundIndex);
    }
    timeoutMs = Math.min(ledger.policy.callTimeoutMs, balance.remainingDurationMs - balance.reservedReviewDurationMs);
    if (timeoutMs <= 0)
      throw new BudgetCapacityError("Time budget is reserved for complete review before the deadline");
  }
  const members = Object.keys(allocation);
  exactMembers(members, batch.attemptIds);
  const seen = new Set(ledger.attempts.map((attempt) => attempt.attemptId));
  const additions: BudgetAttempt[] = members.map((memberId) => {
    const attemptId = batch.attemptIds[memberId]!;
    identifier(attemptId, "attempt ID");
    if (seen.has(attemptId)) throw new Error("Attempt ID must be unique");
    seen.add(attemptId);
    return {
      attemptId,
      memberId,
      phase: batch.phase,
      ...(batch.phase === "discussion" ? { roundIndex: batch.roundIndex } : {}),
      ...(reservation ? { reservationId: reservation.reservationId } : {}),
      maxOutputTokens: allocation[memberId]!,
      chargedAtMs: nowMs,
      timeoutMs,
      deadlineAtMs: nowMs + timeoutMs,
      status: "pending"
    };
  });
  const reservations = ledger.reservations.map((item) =>
    item === reservation
      ? {
          ...item,
          attemptIds: {
            ...item.attemptIds,
            ...Object.fromEntries(additions.map((attempt) => [attempt.memberId, attempt.attemptId]))
          }
        }
      : item
  );
  const next = { ...ledger, lastRecordedAtMs: nowMs, attempts: [...ledger.attempts, ...additions], reservations };
  assertCapacity(next, nowMs);
  return freezeLedger(next);
}

/** Explicit authorization adds capacity without rewriting a segment's original policy. */
export function extendDiscussionBudget(
  ledger: BudgetLedger,
  extension: {
    readonly extensionId: string;
    readonly extraCalls?: number;
    readonly extraAllocatedOutputTokens?: number;
    readonly extendMs?: number;
  },
  nowMs: number
): BudgetLedger {
  clock(ledger, nowMs);
  identifier(extension.extensionId, "budget extension ID");
  if (ledger.extensions?.some((item) => item.extensionId === extension.extensionId))
    throw new Error("Budget extension ID must be unique");
  const addition: BudgetExtension = {
    extensionId: extension.extensionId,
    atMs: nowMs,
    extraCalls: extension.extraCalls === undefined ? 0 : extension.extraCalls,
    extraAllocatedOutputTokens:
      extension.extraAllocatedOutputTokens === undefined ? 0 : extension.extraAllocatedOutputTokens,
    extendMs: extension.extendMs === undefined ? 0 : extension.extendMs
  };
  integer(addition.extraCalls, "Extra calls");
  integer(addition.extraAllocatedOutputTokens, "Extra allocated output tokens");
  integer(addition.extendMs, "Deadline extension");
  if (!addition.extraCalls && !addition.extraAllocatedOutputTokens && !addition.extendMs)
    throw new Error("Budget extension must add positive capacity");
  const extensions = [...(ledger.extensions ?? []), addition];
  integer(ledger.policy.maxCalls + extensions.reduce((sum, item) => sum + item.extraCalls, 0), "Call cap");
  integer(
    ledger.policy.maxAllocatedOutputTokens + extensions.reduce((sum, item) => sum + item.extraAllocatedOutputTokens, 0),
    "Allocated output cap"
  );
  const deadlineAtMs = ledger.deadlineAtMs + addition.extendMs;
  integer(deadlineAtMs, "Segment deadline");
  return freezeLedger({ ...ledger, extensions, deadlineAtMs, lastRecordedAtMs: nowMs });
}

/** Charge only explicitly missing members using the already frozen request's output cap. */
export function reserveRetryAttempts(
  ledger: BudgetLedger,
  attemptIds: Readonly<Record<AgentId, string>>,
  priorAttemptIds: Readonly<Record<AgentId, string>>,
  nowMs: number
): BudgetLedger {
  clock(ledger, nowMs);
  const roster = ledger.policy.roundingOrder;
  if (
    attemptIds === null ||
    typeof attemptIds !== "object" ||
    Array.isArray(attemptIds) ||
    !Reflect.ownKeys(attemptIds).length ||
    Reflect.ownKeys(attemptIds).some((key) => typeof key !== "string" || !roster.includes(key))
  )
    throw new Error("Retry must include a nonempty subset of known members");
  const members = roster.filter((id) => Object.hasOwn(attemptIds, id));
  exactMembers(members, priorAttemptIds);
  const seen = new Set(ledger.attempts.map((attempt) => attempt.attemptId));
  const previous = members.map((memberId) => {
    const attemptId = attemptIds[memberId]!;
    identifier(attemptId, "attempt ID");
    if (seen.has(attemptId)) throw new Error("Attempt ID must be unique");
    seen.add(attemptId);
    const prior = ledger.attempts.find((attempt) => attempt.attemptId === priorAttemptIds[memberId]);
    if (!prior || prior.memberId !== memberId) throw new Error("Retry must reference the member's existing attempt");
    const checkpointId = ledger.reservations.find((item) => item.reservationId === prior.reservationId)?.checkpointId;
    const latest = [...ledger.attempts]
      .reverse()
      .find(
        (attempt) =>
          attempt.memberId === memberId &&
          attempt.phase === prior.phase &&
          attempt.roundIndex === prior.roundIndex &&
          (prior.phase !== "review" ||
            ledger.reservations.find((item) => item.reservationId === attempt.reservationId)?.checkpointId ===
              checkpointId)
      );
    if (prior !== latest || prior.status === "pending" || prior.status === "succeeded")
      throw new Error("Only the latest failed, cancelled or unknown member attempt may be explicitly retried");
    return { prior, checkpointId, attemptId };
  });
  const first = previous[0]!;
  if (
    previous.some(
      ({ prior, checkpointId }) =>
        prior.phase !== first.prior.phase ||
        prior.roundIndex !== first.prior.roundIndex ||
        (prior.phase === "review" && checkpointId !== first.checkpointId)
    )
  )
    throw new Error("Retry members must belong to the same phase and round or review checkpoint");
  if (first.prior.phase === "review") {
    let next = ledger;
    for (const { prior, checkpointId, attemptId } of previous) {
      const reservationId = `${attemptId}:reservation`;
      next = reserveReviewRetry(next, reservationId, checkpointId!, prior.memberId, nowMs);
      next = reserveAttemptBatch(
        next,
        { phase: "review", reservationId, attemptIds: { [prior.memberId]: attemptId } },
        nowMs
      );
    }
    return next;
  }
  if (!ledger.reservations.some((item) => item.kind === "checkpoint" && pendingMembers(item).length === roster.length))
    throw new Error("Reserve a complete review before non-review dispatch");
  const balance = remainingBudget(ledger, nowMs);
  const timeoutMs = Math.min(
    ledger.policy.callTimeoutMs,
    balance.remainingDurationMs - balance.reservedReviewDurationMs
  );
  if (timeoutMs <= 0) throw new BudgetCapacityError("Time budget is reserved for complete review before the deadline");
  const additions: BudgetAttempt[] = previous.map(({ prior, attemptId }) => ({
    attemptId,
    memberId: prior.memberId,
    phase: prior.phase,
    ...(prior.roundIndex === undefined ? {} : { roundIndex: prior.roundIndex }),
    maxOutputTokens: prior.maxOutputTokens,
    chargedAtMs: nowMs,
    timeoutMs,
    deadlineAtMs: nowMs + timeoutMs,
    status: "pending"
  }));
  const next = { ...ledger, lastRecordedAtMs: nowMs, attempts: [...ledger.attempts, ...additions] };
  assertCapacity(next, nowMs);
  return freezeLedger(next);
}
/** Observe terminal outcome/usage; charged calls and output caps are never reduced. */
export function settleBudgetAttempt(
  ledger: BudgetLedger,
  attemptId: string,
  outcome: AttemptOutcome,
  nowMs: number,
  observedUsage?: ObservedBudgetUsage
): BudgetLedger {
  clock(ledger, nowMs);
  if (!["succeeded", "failed", "cancelled", "unknown"].includes(outcome)) throw new Error("Invalid attempt outcome");
  const attempt = ledger.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt || attempt.status !== "pending") throw new Error("Attempt must exist and be pending");
  if (outcome === "succeeded" && nowMs >= attempt.deadlineAtMs)
    throw new Error("Cannot accept a success after its attempt deadline");
  if (observedUsage !== undefined) {
    if (observedUsage === null || typeof observedUsage !== "object" || Array.isArray(observedUsage))
      throw new Error("Invalid observed usage");
    for (const [key, value] of Object.entries(observedUsage)) {
      if (!["inputTokens", "outputTokens", "reasoningTokens"].includes(key)) throw new Error("Unknown usage field");
      if (value !== undefined) integer(value, "Observed token usage");
    }
  }
  return freezeLedger({
    ...ledger,
    lastRecordedAtMs: nowMs,
    attempts: ledger.attempts.map((item) =>
      item === attempt
        ? { ...item, status: outcome, settledAtMs: nowMs, ...(observedUsage === undefined ? {} : { observedUsage }) }
        : item
    )
  });
}
