import { canonicalJson } from "../../peer/hash.js";
import type {
  KernelTask,
  KernelState,
  KernelAttempt,
  LeaseIdentity,
  ProjectIdentity,
  RequestHeader,
  RecordView
} from "./types.js";
export const isActiveAttempt = (attempt: { readonly status: string }) =>
  ["running", "checking", "publishing"].includes(attempt.status);
export function requestedLocks(
  state: { readonly plan: { readonly tasks: readonly KernelTask<string>[] } },
  taskId: string
): { path: string; mode: "R" | "W" }[] {
  const task = state.plan.tasks.find((task) => task.taskId === taskId);
  if (!task) throw new Error("Unknown build task");
  return [
    ...task.scope.read.map((path) => ({ path, mode: "R" as const })),
    ...task.scope.write.map((path) => ({ path, mode: "W" as const }))
  ];
}
export function scopesConflict(
  left: readonly { path: string; mode: "R" | "W" }[],
  right: readonly { path: string; mode: "R" | "W" }[]
): boolean {
  return left.some((a) => right.some((b) => a.path === b.path && (a.mode === "W" || b.mode === "W")));
}

export function assertCoordinationInvariants<
  M extends string,
  I extends string,
  Q extends RequestHeader,
  L extends LeaseIdentity<M>,
  R
>(
  state: KernelState<M, I, Q>,
  inspectRecord: (record: Q) => RecordView<L, R>,
  leaseFor: (state: ProjectIdentity, attempt: KernelAttempt<M>) => L
): void {
  const c = state.coordination;
  const fail = (message: string): never => {
    throw new Error(`Invalid build coordination: ${message}`);
  };
  const taskIds = state.plan.tasks.map((task) => task.taskId);
  for (const map of [c.taskEpochs, c.taskStates])
    if (Object.keys(map).length !== taskIds.length || taskIds.some((id) => !Object.hasOwn(map, id)))
      fail("exact task metadata required");
  if (c.lastNow < state.startedAt || state.waiting.some((item) => item.sequence >= c.nextSequence))
    fail("clock/queue sequence");
  const active = state.attempts.filter(isActiveAttempt);
  if (state.status !== "active" && active.length) fail("inactive run owns active attempts");
  if (
    new Set(active.map((a) => a.taskId)).size !== active.length ||
    new Set(active.map((a) => a.workerId)).size !== active.length
  )
    fail("multiple active tasks per task/worker");
  if (new Set(state.attempts.map((a) => a.token)).size !== state.attempts.length) fail("reused host token");
  for (const attempt of state.attempts) {
    if (attempt.leaseEpoch === undefined || attempt.leaseEpoch > c.taskEpochs[attempt.taskId]!)
      fail("attempt lease epoch");
    if (
      isActiveAttempt(attempt) &&
      (attempt.leaseEpoch !== c.taskEpochs[attempt.taskId] ||
        attempt.ownerEpoch !== state.ownerEpoch ||
        attempt.deadlineAt <= c.lastNow ||
        state.deadlineAt <= c.lastNow ||
        c.taskStates[attempt.taskId] !== attempt.status)
    )
      fail("active attempt status/epoch/deadline");
  }
  if (new Set(c.locks.map((lock) => `${lock.attemptId}:${lock.path}`)).size !== c.locks.length) fail("duplicate locks");
  for (const lock of c.locks) {
    const attempt = active.find((a) => a.attemptId === lock.attemptId);
    if (
      !attempt ||
      lock.taskId !== attempt.taskId ||
      lock.leaseEpoch !== attempt.leaseEpoch ||
      !requestedLocks(state, lock.taskId).some((x) => x.path === lock.path && x.mode === lock.mode)
    )
      fail("unknown/mismatched lock owner or scope");
  }
  for (const attempt of active) {
    const locks = c.locks.filter((lock) => lock.attemptId === attempt.attemptId);
    if (locks.length !== requestedLocks(state, attempt.taskId).length) fail("partial grant");
    if (state.waiting.some((item) => item.taskId === attempt.taskId)) fail("active task is queued");
  }
  for (let i = 0; i < c.locks.length; i++)
    for (let j = i + 1; j < c.locks.length; j++)
      if (c.locks[i]!.attemptId !== c.locks[j]!.attemptId && scopesConflict([c.locks[i]!], [c.locks[j]!]))
        fail("conflicting granted locks");
  for (const taskId of taskIds) {
    const taskState = c.taskStates[taskId];
    if ((taskState === "waiting") !== state.waiting.some((item) => item.taskId === taskId))
      fail("queue/task status mismatch");
    if (["running", "checking", "publishing"].includes(taskState!) && !active.some((a) => a.taskId === taskId))
      fail("active status without lease");
    if ((taskState === "completed") !== state.acceptedTasks.includes(taskId)) fail("accepted task/status mismatch");
  }
  if (new Set(c.requests.map((r) => r.requestId)).size !== c.requests.length) fail("duplicate request IDs");
  for (const request of c.requests) {
    if (request.attemptId !== null && !state.attempts.some((a) => a.attemptId === request.attemptId))
      fail("unknown request attempt");
    const view = inspectRecord(request);
    if ((request.status === "succeeded") !== view.hasResult) fail("receipt completion mismatch");
    if (request.status === "pending" && (!view.allowsPending || !active.some((a) => a.attemptId === request.attemptId)))
      fail("pending request has no active attempt");
    if (view.control?.kind === "granted") {
      const lease = view.control.lease;
      const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId);
      if (!attempt || canonicalJson(leaseFor(state, attempt)) !== canonicalJson(lease)) fail("grant receipt identity");
    }
  }
}
