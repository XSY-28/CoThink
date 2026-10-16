import { z } from "zod";
import { canonicalJson, hashJson } from "../../peer/hash.js";
import { SyncIdSchema } from "./primitives.js";
import { assertCoordinationInvariants, isActiveAttempt, requestedLocks, scopesConflict } from "./invariants.js";
import type {
  ControlOperation,
  ControlResult,
  KernelState,
  KernelProtocol,
  LeaseIdentity,
  RequestHeader,
  RequestStatus,
  SyncMutable,
  Transition,
  LeaseAllocator,
  Schedule,
  WaitReason
} from "./types.js";
const HostSchema = z.object({ ownerEpoch: z.number().int().positive().safe() }).strict();
/** Fixed pure algorithms; protocol callbacks only preserve concrete serialization and extensions. */
export function createCoordinationKernel<
  M extends string,
  I extends string,
  Q extends RequestHeader,
  L extends LeaseIdentity<M>,
  S extends KernelState<M, I, Q>,
  R
>(protocol: KernelProtocol<M, I, Q, L, S, R>) {
  function parse(input: unknown): S {
    const state = protocol.parseShape(input);
    assertCoordinationInvariants(state, protocol.inspectRecord, protocol.leaseFor);
    protocol.validateExtension(state);
    return state;
  }
  const draft = protocol.draft;
  function validateNow(state: S, now: number): void {
    if (!Number.isSafeInteger(now) || now < state.coordination.lastNow)
      throw new Error("Invalid or backwards injected clock");
  }
  function commit(state: S, value: SyncMutable<S>, now: number): S {
    const draftCore = protocol.core(value);
    draftCore.coordination.lastNow = now;
    if (canonicalJson(value) === canonicalJson(state)) return state;
    draftCore.revision = state.revision + 1;
    return parse(value);
  }
  const reject = (state: S, code: string): Transition<S, L, R> => ({
    state,
    result: { kind: "rejected", code }
  });
  function requestHash(state: S, operation: string, payload: unknown): string {
    return hashJson({
      projectKey: state.projectKey,
      runId: state.runId,
      planHash: state.plan.planHash,
      operation,
      payload
    });
  }
  function replay(state: S, requestId: string, payloadHash: string): Transition<S, L, R> | undefined {
    const prior = state.coordination.requests.find((r) => r.requestId === requestId);
    if (!prior) return;
    if (prior.payloadHash !== payloadHash) return reject(state, "request_id_conflict");
    if (prior.status !== "succeeded")
      return reject(state, prior.status === "pending" ? "request_in_flight" : "request_invalidated");
    const receipt = protocol.inspectRecord(prior).replay;
    if (receipt === null) throw new Error("Missing replay result");
    return { state, result: { kind: "replayed", receipt } };
  }
  function recordControl(
    value: SyncMutable<S>,
    requestId: string,
    payloadHash: string,
    operation: ControlOperation,
    result: ControlResult<L>,
    attemptId: string | null
  ): void {
    protocol
      .core(value)
      .coordination.requests.push(protocol.encodeControl({ requestId, payloadHash, operation, result, attemptId }));
  }
  function validateLease(input: S, identity: unknown, now: number): { valid: true } | { valid: false; code: string } {
    const state = parse(input);
    validateNow(state, now);
    return validateParsedLease(state, identity, now);
  }
  function validateParsedLease(
    state: S,
    identity: unknown,
    now: number
  ): { valid: true } | { valid: false; code: string } {
    let lease: L;
    try {
      lease = protocol.parseLease(identity);
    } catch {
      return { valid: false, code: "invalid_identity" };
    }
    const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId);
    if (!attempt || canonicalJson(protocol.leaseFor(state, attempt)) !== canonicalJson(lease))
      return { valid: false, code: "identity_mismatch" };
    if (
      state.status !== "active" ||
      !isActiveAttempt(attempt) ||
      lease.ownerEpoch !== state.ownerEpoch ||
      lease.leaseEpoch !== state.coordination.taskEpochs[lease.taskId]
    )
      return { valid: false, code: "attempt_invalidated" };
    if (now >= state.deadlineAt || now >= attempt.deadlineAt) return { valid: false, code: "deadline_exceeded" };
    return { valid: true };
  }
  /** Invalidate status/epoch and unfinished requests before removing any lock. */
  function invalidateAttempt(value: SyncMutable<S>, attemptId: string, status: "paused" | "cancelled"): void {
    const draftCore = protocol.core(value);
    const attempt = draftCore.attempts.find((a) => a.attemptId === attemptId)!;
    attempt.status = status;
    draftCore.coordination.taskStates[attempt.taskId] = status;
    draftCore.coordination.taskEpochs[attempt.taskId]!++;
    for (const request of draftCore.coordination.requests)
      if (request.attemptId === attemptId && request.status === "pending") {
        const mutable: { status: RequestStatus } = request;
        mutable.status = "invalidated";
      }
    draftCore.coordination.locks = draftCore.coordination.locks.filter((lock) => lock.attemptId !== attemptId);
  }
  function sweepDeadlines(value: SyncMutable<S>, now: number): string[] {
    const draftCore = protocol.core(value);
    const expired = draftCore.attempts
      .filter((a) => isActiveAttempt(a) && (now >= a.deadlineAt || now >= draftCore.deadlineAt))
      .map((a) => a.attemptId);
    for (const id of expired) invalidateAttempt(value, id, "paused");
    if (now >= draftCore.deadlineAt && draftCore.status === "active") draftCore.status = "paused";
    return expired;
  }
  function expire(input: S, host: unknown, now: number): Transition<S, L, R> {
    const state = parse(input);
    validateNow(state, now);
    const identity = HostSchema.parse(host);
    if (identity.ownerEpoch !== state.ownerEpoch) return reject(state, "owner_epoch_mismatch");
    const value = draft(state);
    const attemptIds = sweepDeadlines(value, now);
    return { state: commit(state, value, now), result: { kind: "expired", attemptIds } };
  }
  function advanceOwner(input: S, rawRequest: unknown, now: number): Transition<S, L, R> {
    const state = parse(input);
    validateNow(state, now);
    const identity = protocol.parseControl(rawRequest);
    if (identity.operation !== "epoch") throw new Error("Control operation mismatch");
    const requestId = identity.requestId;
    const hash = requestHash(state, "epoch", identity.hashPayload);
    const priorReplay = replay(state, requestId, hash);
    if (priorReplay) return priorReplay;
    if (identity.ownerEpoch !== state.ownerEpoch) return reject(state, "owner_epoch_mismatch");
    const value = draft(state);
    const draftCore = protocol.core(value);
    for (const attempt of draftCore.attempts.filter(isActiveAttempt))
      invalidateAttempt(value, attempt.attemptId, "paused");
    sweepDeadlines(value, now);
    draftCore.ownerEpoch++;
    const result = { kind: "epoch_advanced" as const, ownerEpoch: draftCore.ownerEpoch };
    recordControl(value, requestId, hash, "epoch", result, null);
    return { state: commit(state, value, now), result };
  }
  function cancel(input: S, raw: unknown, now: number): Transition<S, L, R> {
    const state = parse(input);
    validateNow(state, now);
    const request = protocol.parseControl(raw);
    if (request.operation !== "cancel") throw new Error("Control operation mismatch");
    const hash = requestHash(state, "cancel", request.hashPayload);
    const priorReplay = replay(state, request.requestId, hash);
    if (priorReplay) return priorReplay;
    const task = state.plan.tasks.find((t) => t.taskId === request.taskId);
    if (request.ownerEpoch !== state.ownerEpoch || !task || task.workerId !== request.workerId)
      return reject(state, "identity_mismatch");
    if (state.acceptedTasks.includes(task.taskId)) return reject(state, "task_completed");
    const value = draft(state);
    const draftCore = protocol.core(value);
    sweepDeadlines(value, now);
    const active = draftCore.attempts.find((a) => a.taskId === task.taskId && isActiveAttempt(a));
    if (active) invalidateAttempt(value, active.attemptId, "cancelled");
    else draftCore.coordination.taskEpochs[task.taskId]!++;
    draftCore.waiting = draftCore.waiting.filter((item) => item.taskId !== task.taskId);
    draftCore.coordination.taskStates[task.taskId] = "cancelled";
    const result = { kind: "cancelled" as const, taskId: task.taskId };
    recordControl(value, request.requestId, hash, "cancel", result, active?.attemptId ?? null);
    return { state: commit(state, value, now), result };
  }
  /** Stage 2 supplies actual immutable-version hashes after grant; this reducer never reads content. */
  function bindInput(input: S, rawRequest: unknown, now: number): Transition<S, L, R> {
    const state = parse(input);
    validateNow(state, now);
    const request = protocol.parseControl(rawRequest);
    if (request.operation !== "bind") throw new Error("Control operation mismatch");
    const { lease, requestId, snapshot } = request;
    const hash = requestHash(state, "bind", request.hashPayload);
    const priorReplay = replay(state, requestId, hash);
    if (priorReplay) return priorReplay;
    const valid = validateParsedLease(state, lease, now);
    if (!valid.valid) return reject(state, valid.code);
    const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId)!;
    if (attempt.inputHash !== null) return reject(state, "input_already_bound");
    const paths = requestedLocks(state, lease.taskId).map((x) => x.path);
    if (
      snapshot.baseVersion !== attempt.baseVersion ||
      Object.keys(snapshot.contentHashes).length !== paths.length ||
      paths.some((path) => !Object.hasOwn(snapshot.contentHashes, path))
    )
      return reject(state, "snapshot_scope_or_version_mismatch");
    const value = draft(state);
    const draftCore = protocol.core(value);
    sweepDeadlines(value, now);
    Object.assign(draftCore.attempts.find((a) => a.attemptId === lease.attemptId)!, snapshot);
    const result = { kind: "bound" as const, attemptId: lease.attemptId };
    recordControl(value, requestId, hash, "bind", result, lease.attemptId);
    return { state: commit(state, value, now), result };
  }

  function reserve(input: S, rawRequest: unknown, now: number, allocate: LeaseAllocator<M>): Transition<S, L, R> {
    const state = parse(input);
    validateNow(state, now);
    const request = protocol.parseControl(rawRequest);
    if (request.operation !== "reserve") throw new Error("Control operation mismatch");
    const hash = requestHash(state, "reserve", request.hashPayload);
    const priorReplay = replay(state, request.requestId, hash);
    if (priorReplay) return priorReplay;
    const task = state.plan.tasks.find((t) => t.taskId === request.taskId);
    if (request.ownerEpoch !== state.ownerEpoch || !task || task.workerId !== request.workerId)
      return reject(state, "identity_mismatch");
    if (state.status !== "active" || now >= state.deadlineAt) return reject(state, "run_inactive");
    if (state.acceptedTasks.includes(task.taskId)) return reject(state, "task_completed");
    const value = draft(state);
    const draftCore = protocol.core(value);
    sweepDeadlines(value, now);
    if (draftCore.attempts.some((a) => a.taskId === task.taskId && isActiveAttempt(a)))
      return reject(state, "task_already_active");
    if (!draftCore.waiting.some((item) => item.taskId === task.taskId)) {
      draftCore.waiting.push({ taskId: task.taskId, sequence: draftCore.coordination.nextSequence++ });
      draftCore.coordination.taskStates[task.taskId] = "waiting";
    }
    const scheduled = drainQueue(value, now, allocate);
    const grant = scheduled.grants.find((lease) => lease.taskId === task.taskId);
    const result: ControlResult<L> = grant
      ? { kind: "granted", lease: grant }
      : {
          kind: "waiting",
          taskId: task.taskId,
          reasons:
            scheduled.waiting.find((item) => item.taskId === task.taskId)?.reasons ??
            waitReasons(draftCore, task.taskId, [])
        };
    recordControl(value, request.requestId, hash, "reserve", result, grant?.attemptId ?? null);
    return { state: commit(state, value, now), result };
  }
  function endScope(input: S, rawRequest: unknown, now: number, operation: "release" | "revoke"): Transition<S, L, R> {
    const state = parse(input);
    validateNow(state, now);
    const request = protocol.parseControl(rawRequest);
    if (request.operation !== operation) throw new Error("Control operation mismatch");
    const { lease, requestId } = request;
    const hash = requestHash(state, operation, request.hashPayload);
    const priorReplay = replay(state, requestId, hash);
    if (priorReplay) return priorReplay;
    const valid = validateParsedLease(state, lease, now);
    if (!valid.valid) return reject(state, valid.code);
    const value = draft(state);
    sweepDeadlines(value, now);
    invalidateAttempt(value, lease.attemptId, operation === "release" ? "paused" : "cancelled");
    const result: ControlResult<L> =
      operation === "release"
        ? { kind: "released", attemptId: lease.attemptId }
        : { kind: "revoked", attemptId: lease.attemptId };
    recordControl(value, requestId, hash, operation, result, lease.attemptId);
    // Releasing does not accept a task, publish a version, or automatically schedule another attempt.
    return { state: commit(state, value, now), result };
  }
  function release(state: S, request: unknown, now: number): Transition<S, L, R> {
    return endScope(state, request, now, "release");
  }
  function revoke(state: S, request: unknown, now: number): Transition<S, L, R> {
    return endScope(state, request, now, "revoke");
  }
  /** Dependency/busy-worker requests do not reserve resources or queue priority. */
  function waitReasons(state: KernelState<M, I, Q>, taskId: string, earlierEligible: readonly string[]): WaitReason[] {
    const task = state.plan.tasks.find((t) => t.taskId === taskId)!;
    const dependencies = task.dependsOn.filter((id) => !state.acceptedTasks.includes(id));
    if (dependencies.length) return [{ kind: "dependency", taskIds: dependencies }];
    const busy = state.attempts.filter((a) => a.workerId === task.workerId && isActiveAttempt(a));
    if (busy.length) return [{ kind: "worker", attemptIds: busy.map((a) => a.attemptId) }];
    const locks = requestedLocks(state, taskId);
    const conflicts = state.coordination.locks.filter((lock) => scopesConflict(locks, [lock]));
    if (conflicts.length)
      return [
        {
          kind: "lock",
          paths: [...new Set(conflicts.map((x) => x.path))],
          attemptIds: [...new Set(conflicts.map((x) => x.attemptId))]
        }
      ];
    const queue = earlierEligible.filter((id) => scopesConflict(locks, requestedLocks(state, id)));
    return queue.length ? [{ kind: "queue", taskIds: queue }] : [];
  }
  /** Full scopes are tested first; host identity allocation occurs only for an actual grant. */
  function drainQueue(
    value: SyncMutable<S>,
    now: number,
    allocate: LeaseAllocator<M>
  ): { grants: L[]; waiting: { taskId: string; reasons: WaitReason[] }[] } {
    const draftCore = protocol.core(value);
    const grants: L[] = [];
    const waiting: { taskId: string; reasons: WaitReason[] }[] = [];
    const earlierEligible: string[] = [];
    if (draftCore.status !== "active" || now >= draftCore.deadlineAt) return { grants, waiting };
    for (const queued of [...draftCore.waiting].sort((a, b) => a.sequence - b.sequence)) {
      const reasons = waitReasons(draftCore, queued.taskId, earlierEligible);
      if (reasons.length) {
        waiting.push({ taskId: queued.taskId, reasons });
        if (reasons.every((r) => r.kind === "lock" || r.kind === "queue")) earlierEligible.push(queued.taskId);
        continue;
      }
      const task = draftCore.plan.tasks.find((t) => t.taskId === queued.taskId)!;
      const leaseEpoch = draftCore.coordination.taskEpochs[task.taskId]! + 1;
      const identity = allocate(
        Object.freeze({
          taskId: task.taskId,
          workerId: task.workerId,
          ownerEpoch: draftCore.ownerEpoch,
          leaseEpoch,
          baseVersion: draftCore.acceptedVersion
        })
      );
      SyncIdSchema.parse(identity.attemptId);
      if (
        typeof identity.token !== "string" ||
        identity.token.length < 1 ||
        identity.token.length > 512 ||
        draftCore.attempts.some((a) => a.attemptId === identity.attemptId || a.token === identity.token)
      )
        throw new Error("Invalid/reused host lease identity");
      const attempt = {
        ...identity,
        taskId: task.taskId,
        workerId: task.workerId,
        ownerEpoch: draftCore.ownerEpoch,
        leaseEpoch,
        baseVersion: draftCore.acceptedVersion,
        inputHash: null,
        contentHashes: {},
        startedAt: now,
        deadlineAt: Math.min(now + protocol.taskTimeoutMs(value), draftCore.deadlineAt),
        status: "running" as const
      };
      draftCore.attempts.push(attempt);
      draftCore.coordination.taskEpochs[task.taskId] = leaseEpoch;
      draftCore.coordination.taskStates[task.taskId] = "running";
      draftCore.coordination.locks.push(
        ...requestedLocks(draftCore, task.taskId).map((lock) => ({
          ...lock,
          taskId: task.taskId,
          attemptId: identity.attemptId,
          leaseEpoch
        }))
      );
      draftCore.waiting = draftCore.waiting.filter((item) => item.taskId !== task.taskId);
      grants.push(protocol.leaseFor(draftCore, attempt));
    }
    return { grants, waiting };
  }
  /** A finite pass over this plan's queue. No timer, model, filesystem or implicit retry. */
  function schedule(input: S, rawHost: unknown, now: number, allocate: LeaseAllocator<M>): Schedule<S, L> {
    const state = parse(input);
    validateNow(state, now);
    const host = HostSchema.parse(rawHost);
    if (host.ownerEpoch !== state.ownerEpoch)
      return { state, grants: [], waiting: [], rejected: "owner_epoch_mismatch" };
    const value = draft(state);
    sweepDeadlines(value, now);
    const scheduled = drainQueue(value, now, allocate);
    return { state: commit(state, value, now), ...scheduled };
  }

  return {
    parse,
    validateNow,
    requestedLocks,
    scopesConflict,
    waitReasons,
    requestHash,
    replay,
    reserve,
    release,
    revoke,
    cancel,
    bindInput,
    advanceOwner,
    expire,
    schedule,
    validateLease,
    leaseFor: protocol.leaseFor,
    internals: {
      validateParsedLease,
      draft,
      commit,
      recordControl,
      invalidateAttempt,
      sweepDeadlines,
      drainQueue,
      reject
    }
  };
}
