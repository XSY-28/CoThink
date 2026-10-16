import {
  legacyKernel,
  type BuildState,
  type BuildTransition,
  type BuildLeaseAllocator
} from "../agent-sync/legacy-v1/coordination.js";
export { validateBuildLease, buildScopesConflict } from "./state.js";
export function reserveBuildScope(
  state: BuildState,
  request: unknown,
  now: number,
  allocate: BuildLeaseAllocator
): BuildTransition {
  return legacyKernel.reserve(state, { operation: "reserve", request }, now, allocate);
}
export function releaseBuildScope(state: BuildState, lease: unknown, requestId: string, now: number): BuildTransition {
  return legacyKernel.release(state, { operation: "release", lease, requestId }, now);
}
export function revokeBuildScope(state: BuildState, lease: unknown, requestId: string, now: number): BuildTransition {
  return legacyKernel.revoke(state, { operation: "revoke", lease, requestId }, now);
}
export const ScopeCoordinator = Object.freeze({
  reserve: reserveBuildScope,
  release: releaseBuildScope,
  revoke: revokeBuildScope
});
