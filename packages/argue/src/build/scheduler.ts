import {
  legacyKernel,
  type BuildState,
  type BuildLeaseAllocator,
  type BuildStateDraft
} from "../agent-sync/legacy-v1/coordination.js";
import type { BuildLease, BuildWaitReason, BuildRun } from "./contracts.js";
export type BuildSchedule = {
  readonly state: BuildState;
  readonly grants: readonly BuildLease[];
  readonly waiting: readonly { taskId: string; reasons: readonly BuildWaitReason[] }[];
  readonly rejected?: string;
};
export function buildWaitReasons(
  state: BuildRun,
  taskId: string,
  earlierEligible: readonly string[]
): BuildWaitReason[] {
  if (!state.coordination) throw new Error("Coordination required");
  return legacyKernel.waitReasons({ ...state, coordination: state.coordination }, taskId, earlierEligible);
}
export const drainBuildQueue: (
  draft: BuildStateDraft,
  now: number,
  allocate: BuildLeaseAllocator
) => { grants: BuildLease[]; waiting: { taskId: string; reasons: BuildWaitReason[] }[] } =
  legacyKernel.internals.drainQueue;
export const scheduleBuildTasks: (
  input: BuildState,
  rawHost: unknown,
  now: number,
  allocate: BuildLeaseAllocator
) => BuildSchedule = legacyKernel.schedule;
