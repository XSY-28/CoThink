import { BuildIdSchema, type BuildLease, type BuildRun } from "./contracts.js";
import {
  buildDraft,
  commitBuildState,
  parseBuildState,
  validateBuildLease,
  validateBuildNow,
  type BuildState
} from "./state.js";

type BuildCall = BuildRun["calls"][number];
type TerminalCallStatus = Exclude<BuildCall["status"], "reserved">;

/** Reserve the full output allowance before dispatch. Every historical call still counts. */
export function reserveBuildCall(
  input: BuildState,
  lease: BuildLease,
  callId: string,
  now: number,
  allocatedOutputTokens = input.plan.budget.maxOutputTokensPerCall
): { state: BuildState; call: BuildCall } {
  const state = parseBuildState(input);
  validateBuildNow(state, now);
  BuildIdSchema.parse(callId);
  const valid = validateBuildLease(state, lease, now);
  if (!valid.valid) throw new Error(valid.code);
  if (
    state.calls.some((call) => call.callId === callId) ||
    state.coordination.requests.some((request) => request.requestId === callId) ||
    state.workspace?.toolReceipts.some((receipt) => receipt.requestId === callId)
  )
    throw new Error("Duplicate build call ID");
  const attempt = state.attempts.find((attempt) => attempt.attemptId === lease.attemptId)!;
  if (attempt.inputHash === null) throw new Error("Build input is not bound");
  const budget = state.plan.budget;
  if (
    !Number.isSafeInteger(allocatedOutputTokens) ||
    allocatedOutputTokens <= 0 ||
    allocatedOutputTokens > budget.maxOutputTokensPerCall
  )
    throw new Error("Invalid output allocation");
  const taskCalls = state.calls.filter((call) => call.taskId === lease.taskId);
  const total = (calls: readonly BuildCall[]) => calls.reduce((sum, call) => sum + call.allocatedOutputTokens, 0);
  if (
    state.calls.length >= budget.maxCalls ||
    taskCalls.length >= budget.maxCallsPerTask ||
    total(state.calls) + allocatedOutputTokens > budget.maxAllocatedOutputTokens ||
    total(taskCalls) + allocatedOutputTokens > budget.maxAllocatedOutputTokensPerTask
  )
    throw new Error("Build call budget exhausted");
  const draft = buildDraft(state);
  draft.calls.push({
    callId,
    attemptId: attempt.attemptId,
    taskId: attempt.taskId,
    inputHash: attempt.inputHash,
    allocatedOutputTokens,
    reservedAt: now,
    deadlineAt: Math.min(now + budget.callTimeoutMs, attempt.deadlineAt, state.deadlineAt),
    status: "reserved"
  });
  const next = commitBuildState(state, draft, now);
  return { state: next, call: next.calls.find((call) => call.callId === callId)! };
}

/** Settlement observes cost; it cannot authorize a tool or revive a terminal call. */
export function settleBuildCall(
  input: BuildState,
  callId: string,
  status: TerminalCallStatus,
  now: number
): BuildState {
  const state = parseBuildState(input);
  validateBuildNow(state, now);
  BuildIdSchema.parse(callId);
  if (!["succeeded", "failed", "cancelled", "unknown"].includes(status))
    throw new Error("Invalid terminal call status");
  const call = state.calls.find((call) => call.callId === callId);
  if (!call) throw new Error("Unknown build call");
  if (call.status !== "reserved") {
    if (call.status !== status) throw new Error("Terminal build call cannot change");
    return state;
  }
  const draft = buildDraft(state);
  draft.calls.find((call) => call.callId === callId)!.status = status;
  // Observation must not advance the authority clock or implicitly expire another lease.
  return commitBuildState(state, draft, state.coordination.lastNow);
}

/** A crash loses response certainty, never the already allocated budget. No retry occurs. */
export function recoverBuildCalls(input: BuildState, now: number): BuildState {
  const state = parseBuildState(input);
  validateBuildNow(state, now);
  if (!state.calls.some((call) => call.status === "reserved")) return state;
  const draft = buildDraft(state);
  for (const call of draft.calls) if (call.status === "reserved") call.status = "unknown";
  return commitBuildState(state, draft, state.coordination.lastNow);
}
