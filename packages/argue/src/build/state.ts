import { cloneMutable } from "../agent-sync/kernel/types.js";
import { canonicalJson, hashJson } from "../peer/hash.js";
import {
  BuildHashSchema,
  BuildIdSchema,
  BuildLeaseSchema,
  parseBuildRun,
  type BuildControlResult,
  type BuildRun,
  type BuildCoordinationRequest
} from "./contracts.js";
import { BuildActionSchema, type BuildAction } from "./protocol.js";
import {
  legacyKernel,
  leaseFromBuildAttempt,
  type BuildState,
  type BuildStateDraft,
  type BuildTransition
} from "../agent-sync/legacy-v1/coordination.js";
export {
  BuildHostSchema,
  BuildReservationSchema,
  leaseFromBuildAttempt
} from "../agent-sync/legacy-v1/coordination.js";
export type {
  BuildState,
  BuildStateDraft,
  BuildRejection,
  BuildOperationResult,
  BuildTransition,
  BuildLeaseAllocator
} from "../agent-sync/legacy-v1/coordination.js";
import { isActiveAttempt } from "../agent-sync/kernel/invariants.js";
export const isActiveBuildAttempt: (attempt: BuildRun["attempts"][number]) => boolean = isActiveAttempt;
export const parseBuildState = legacyKernel.parse;
export const requestedBuildLocks: (state: BuildRun, taskId: string) => { path: string; mode: "R" | "W" }[] =
  legacyKernel.requestedLocks;
export const buildScopesConflict = legacyKernel.scopesConflict;
export const validateBuildNow = legacyKernel.validateNow;
export const buildDraft = legacyKernel.internals.draft;
export const commitBuildState = legacyKernel.internals.commit;
export const rejectBuildOperation: (state: BuildState, code: string) => BuildTransition = legacyKernel.internals.reject;
export const buildRequestHash: (
  state: BuildState,
  operation: BuildCoordinationRequest["operation"],
  payload: unknown
) => string = legacyKernel.requestHash;
export const replayBuildRequest: (
  state: BuildState,
  requestId: string,
  payloadHash: string
) => BuildTransition | undefined = legacyKernel.replay;
export const validateBuildLease = legacyKernel.validateLease;
export const invalidateBuildAttempt = legacyKernel.internals.invalidateAttempt;
export const sweepBuildDeadlines = legacyKernel.internals.sweepDeadlines;
export const expireBuildState: (input: BuildState, host: unknown, now: number) => BuildTransition = legacyKernel.expire;
export function recordBuildControl(
  draft: BuildStateDraft,
  requestId: string,
  payloadHash: string,
  operation: BuildCoordinationRequest["operation"],
  result: BuildControlResult,
  attemptId: string | null
): void {
  if (operation === "action" || result.kind === "settled") {
    draft.coordination.requests.push({
      requestId,
      payloadHash,
      operation,
      status: "succeeded",
      attemptId,
      binding: null,
      result: cloneMutable(result)
    });
    return;
  }
  legacyKernel.internals.recordControl(draft, requestId, payloadHash, operation, result, attemptId);
}
export function advanceBuildOwnerEpoch(
  state: BuildState,
  host: unknown,
  requestId: string,
  now: number
): BuildTransition {
  return legacyKernel.advanceOwner(state, { operation: "epoch", host, requestId }, now);
}
export function cancelBuildTask(state: BuildState, request: unknown, now: number): BuildTransition {
  return legacyKernel.cancel(state, { operation: "cancel", request }, now);
}
export function bindBuildInput(
  state: BuildState,
  lease: unknown,
  requestId: string,
  snapshot: unknown,
  now: number
): BuildTransition {
  return legacyKernel.bindInput(state, { operation: "bind", lease, requestId, snapshot }, now);
}
/** A fresh stage-0 run may be initialized; old active runs require later recovery, never guessed ownership. */
export function createBuildState(input: unknown): BuildState {
  const run = parseBuildRun(input);
  if (
    run.coordination ||
    run.attempts.length ||
    run.waiting.length ||
    run.calls.length ||
    run.actionReceipts.length ||
    run.checkReceipts.length ||
    run.publishReceipts.length
  )
    throw new Error("Expected a fresh run, not recoverable active history");
  return parseBuildState({
    ...run,
    coordination: {
      coordinationVersion: "build-scope-v1",
      lastNow: run.startedAt,
      nextSequence: 0,
      taskEpochs: Object.fromEntries(run.plan.tasks.map((t) => [t.taskId, 0])),
      taskStates: Object.fromEntries(
        run.plan.tasks.map((t) => [t.taskId, run.acceptedTasks.includes(t.taskId) ? "completed" : "queued"])
      ),
      locks: [],
      requests: []
    }
  });
}
/** Admit a tool request only. No action executes here; later host gateways must recheck the lease before effects. */
export function admitBuildAction(
  input: BuildState,
  rawLease: unknown,
  requestId: string,
  inputHash: string,
  rawAction: unknown,
  now: number
): BuildTransition {
  const state = parseBuildState(input);
  validateBuildNow(state, now);
  const lease = BuildLeaseSchema.parse(rawLease);
  const action: BuildAction = BuildActionSchema.parse(rawAction);
  BuildIdSchema.parse(requestId);
  BuildHashSchema.parse(inputHash);
  const binding = {
    kind: action.kind,
    inputHash,
    payloadHash: hashJson({ requestId, action }),
    leaseHash: hashJson(lease)
  };
  const hash = buildRequestHash(state, "action", binding);
  const replay = replayBuildRequest(state, requestId, hash);
  if (replay) return replay;
  const valid = validateBuildLease(state, lease, now);
  if (!valid.valid) return rejectBuildOperation(state, valid.code);
  const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId)!;
  if (attempt.inputHash === null) return rejectBuildOperation(state, "input_not_bound");
  if (attempt.inputHash !== inputHash) return rejectBuildOperation(state, "input_hash_mismatch");
  const task = state.plan.tasks.find((t) => t.taskId === lease.taskId)!;
  if (action.kind === "inspect" && ![...task.scope.read, ...task.scope.write].includes(action.path))
    return rejectBuildOperation(state, "scope_mismatch");
  if (action.kind === "edit" && !task.scope.write.includes(action.path))
    return rejectBuildOperation(state, "scope_mismatch");
  const draft = buildDraft(state);
  sweepBuildDeadlines(draft, now);
  draft.coordination.requests.push({
    requestId,
    payloadHash: hash,
    operation: "action",
    status: "pending",
    attemptId: lease.attemptId,
    binding: { kind: action.kind, inputHash, payloadHash: hashJson({ requestId, action }), leaseHash: hashJson(lease) },
    result: null
  });
  return { state: commitBuildState(state, draft, now), result: { kind: "ready", requestId } };
}
export function settleBuildAction(
  input: BuildState,
  rawLease: unknown,
  requestId: string,
  outputHash: string,
  now: number
): BuildTransition {
  const state = parseBuildState(input);
  validateBuildNow(state, now);
  const lease = BuildLeaseSchema.parse(rawLease);
  BuildIdSchema.parse(requestId);
  BuildHashSchema.parse(outputHash);
  const request = state.coordination.requests.find((r) => r.requestId === requestId);
  if (!request || request.operation !== "action" || request.attemptId !== lease.attemptId)
    return rejectBuildOperation(state, "unknown_request");
  if (request.status === "succeeded") {
    const result = request.result!;
    if (result.kind !== "settled" || result.receipt.outputHash !== outputHash)
      return rejectBuildOperation(state, "request_id_conflict");
    // Historical settlement queries cannot use another identity, even if the attempt has ended.
    const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId)!;
    if (canonicalJson(leaseFromBuildAttempt(attempt)) !== canonicalJson(lease))
      return rejectBuildOperation(state, "identity_mismatch");
    return { state, result: { kind: "replayed", receipt: result.receipt } };
  }
  const valid = validateBuildLease(state, lease, now);
  if (!valid.valid) return rejectBuildOperation(state, valid.code);
  if (request.status !== "pending") return rejectBuildOperation(state, "request_invalidated");
  const draft = buildDraft(state);
  sweepBuildDeadlines(draft, now);
  const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId)!;
  // Host-only settlement records the observation, not execution or verification success.
  const pending = draft.coordination.requests.find((r) => r.requestId === requestId)!;
  const binding = pending.binding!;
  const receipt = {
    requestId,
    attemptId: lease.attemptId,
    inputHash: attempt.inputHash!,
    payloadHash: binding.payloadHash,
    kind: binding.kind,
    status: "succeeded" as const,
    outputHash
  };
  const result = { kind: "settled" as const, receipt };
  pending.status = "succeeded";
  pending.result = result;
  draft.actionReceipts.push(receipt);
  return { state: commitBuildState(state, draft, now), result };
}
