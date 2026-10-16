import { describe, expect, test } from "vitest";
import {
  createBuildState,
  cancelBuildTask,
  bindBuildInput,
  advanceBuildOwnerEpoch,
  expireBuildState,
  validateBuildLease
} from "../../src/build/state.js";
import { reserveBuildScope, releaseBuildScope } from "../../src/build/scope.js";
import { scheduleBuildTasks } from "../../src/build/scheduler.js";
import { planInput, runInput } from "../build/fixtures.js";
import * as project from "../../src/agent-sync/project/index.js";
import type { LeaseIdentity, KernelState, RequestHeader } from "../../src/agent-sync/kernel/types.js";
import { hashJson } from "../../src/peer/hash.js";
const requestVersion = project.AGENT_SYNC_REQUEST_VERSION;
const allocator = ({ taskId, leaseEpoch }: { taskId: string; leaseEpoch: number }) => ({
  attemptId: `${taskId}-${leaseEpoch}`,
  token: `${taskId}-token-${leaseEpoch}`
});
type ObservedState = KernelState<string, string, RequestHeader>;
type Step<S, L> = {
  readonly state: S;
  readonly result: { readonly kind: string; readonly code?: string; readonly lease?: L };
};
interface Harness<S extends ObservedState, L extends LeaseIdentity> {
  initial(): S;
  worker(index: 0 | 1): string;
  reserve(
    state: S,
    taskId: string,
    workerId: string,
    requestId: string,
    now: number,
    allocate: typeof allocator
  ): Step<S, L>;
  release(state: S, lease: L, requestId: string, now: number): Step<S, L>;
  cancel(state: S, taskId: string, workerId: string, requestId: string, now: number): Step<S, L>;
  bind(
    state: S,
    lease: L,
    requestId: string,
    snapshot: { baseVersion: string; inputHash: string; contentHashes: Record<string, string | null> },
    now: number
  ): Step<S, L>;
  epoch(state: S, requestId: string, now: number): Step<S, L>;
  expire(state: S, now: number): Step<S, L>;
  validate(state: S, lease: unknown, now: number): { valid: boolean };
  schedule(state: S, now: number, allocate: typeof allocator): { state: S; grants: readonly L[] };
}
function conformance<S extends ObservedState, L extends LeaseIdentity>(name: string, h: Harness<S, L>) {
  describe(name, () => {
    test("same-file waiting, independent bypass, busy worker, release, resume and immutable replay share one trace", () => {
      let allocations = 0;
      const allocate: typeof allocator = (context) => {
        allocations++;
        return allocator(context);
      };
      const initial = h.initial(),
        a = h.reserve(initial, "T-A", h.worker(0), "a", 1000, allocate);
      expect(a.result.kind).toBe("granted");
      const leaseA = a.result.lease!;
      const wait = h.reserve(a.state, "T-B2", h.worker(1), "wait", 1001, allocate);
      expect(wait.result.kind).toBe("waiting");
      expect(allocations).toBe(1);
      const b = h.reserve(wait.state, "T-B1", h.worker(1), "b", 1002, allocate);
      expect(b.result.kind).toBe("granted");
      const leaseB = b.result.lease!;
      expect(b.state.coordination.locks).toHaveLength(4);
      expect(b.state.plan).toEqual(initial.plan);
      const replay = h.reserve(b.state, "T-A", h.worker(0), "a", 1003, () => {
        throw Error("historical replay allocates");
      });
      expect(replay.result.kind).toBe("replayed");
      expect(hashJson(replay.state)).toBe(hashJson(b.state));
      const conflict = h.cancel(b.state, "T-A", h.worker(0), "a", 1003);
      expect(conflict.result).toEqual({ kind: "rejected", code: "request_id_conflict" });
      expect(conflict.state).toEqual(b.state);
      const released = h.release(b.state, leaseA, "release-a", 1003);
      expect(released.result.kind).toBe("released");
      expect(h.validate(released.state, leaseA, 1003).valid).toBe(false);
      const busy = h.schedule(released.state, 1003, allocate);
      expect(busy.grants).toHaveLength(0);
      const free = h.release(busy.state, leaseB, "release-b", 1004);
      const resumed = h.schedule(free.state, 1004, allocate);
      expect(resumed.grants.map((g) => g.taskId)).toEqual(["T-B2"]);
      expect(initial.attempts).toHaveLength(0);
      expect(Object.isFrozen(resumed.state)).toBe(true);
      expect(allocations).toBe(3);
    });
    test("binding exact paths and owner/clock/deadline boundaries preserve no-effect rejection", () => {
      const a = h.reserve(h.initial(), "T-A", h.worker(0), "a", 1000, allocator),
        lease = a.result.lease!;
      const snapshot = {
        baseVersion: a.state.acceptedVersion,
        inputHash: hashJson("input"),
        contentHashes: { "SPEC.md": null, "src/normalize.ts": null }
      };
      const bad = h.bind(a.state, lease, "bad", { ...snapshot, contentHashes: {} }, 1000);
      expect(bad.result).toEqual({ kind: "rejected", code: "snapshot_scope_or_version_mismatch" });
      expect(bad.state).toEqual(a.state);
      const bound = h.bind(a.state, lease, "bind", snapshot, 1001);
      expect(bound.result.kind).toBe("bound");
      expect(() => h.expire(bound.state, 1000)).toThrow(/clock/);
      const epoch = h.epoch(bound.state, "epoch", 1002);
      expect(epoch.state.ownerEpoch).toBe(2);
      expect(epoch.state.coordination.locks).toHaveLength(0);
      expect(h.validate(epoch.state, lease, 1002).valid).toBe(false);
      expect(h.epoch(epoch.state, "epoch", 1003).state).toEqual(epoch.state);
      const deadline = a.state.attempts[0]!.deadlineAt;
      expect(h.validate(a.state, lease, deadline).valid).toBe(false);
      const expired = h.expire(a.state, deadline);
      expect(expired.state.coordination.locks).toHaveLength(0);
      expect(expired.state.attempts[0]!.status).toBe("paused");
    });
  });
}
conformance("legacy adapter", {
  initial: () => createBuildState(runInput()),
  worker: (i) => (i === 0 ? "member-a" : "member-b"),
  reserve: (s, taskId, workerId, requestId, now, allocate) =>
    reserveBuildScope(s, { ownerEpoch: s.ownerEpoch, taskId, workerId, requestId }, now, allocate),
  release: releaseBuildScope,
  cancel: (s, taskId, workerId, requestId, now) =>
    cancelBuildTask(s, { ownerEpoch: s.ownerEpoch, taskId, workerId, requestId }, now),
  bind: bindBuildInput,
  epoch: (s, id, now) => advanceBuildOwnerEpoch(s, { ownerEpoch: s.ownerEpoch }, id, now),
  expire: (s, now) => expireBuildState(s, { ownerEpoch: s.ownerEpoch }, now),
  validate: validateBuildLease,
  schedule: (s, now, allocate) => scheduleBuildTasks(s, { ownerEpoch: s.ownerEpoch }, now, allocate)
});
conformance("project adapter", {
  initial() {
    const original = planInput();
    return project.createAgentSyncState({
      project: project.freezeAgentSyncProject({
        projectVersion: project.AGENT_SYNC_PROJECT_VERSION,
        projectKey: original.projectKey,
        memberIds: ["custom-a", "custom-b"],
        manifest: original.manifest,
        tasks: original.tasks.map((t) => ({ ...t, workerId: t.workerId === "member-a" ? "custom-a" : "custom-b" })),
        profiles: original.profiles.map((p) => ({ profileId: p.profileId, checkIds: p.groups })),
        finalProfileId: "final",
        checkConfigurationHash: hashJson("config")
      }),
      runId: "run",
      acceptedVersion: "a".repeat(40),
      now: 1000
    });
  },
  worker: (i) => (i === 0 ? "custom-a" : "custom-b"),
  reserve: (s, taskId, workerId, requestId, now, allocate) =>
    project.reserveAgentSyncScope(
      s,
      { requestVersion, operation: "reserve", ownerEpoch: s.ownerEpoch, taskId, workerId, requestId },
      now,
      allocate
    ),
  release: (s, lease, requestId, now) =>
    project.releaseAgentSyncScope(s, { requestVersion, operation: "release", requestId, lease }, now),
  cancel: (s, taskId, workerId, requestId, now) =>
    project.cancelAgentSyncTask(
      s,
      { requestVersion, operation: "cancel", ownerEpoch: s.ownerEpoch, taskId, workerId, requestId },
      now
    ),
  bind: (s, lease, requestId, snapshot, now) =>
    project.bindAgentSyncInput(s, { requestVersion, operation: "bind", requestId, lease, snapshot }, now),
  epoch: (s, requestId, now) =>
    project.advanceAgentSyncOwnerEpoch(
      s,
      { requestVersion, operation: "epoch", requestId, ownerEpoch: s.ownerEpoch },
      now
    ),
  expire: (s, now) => project.expireAgentSyncState(s, { ownerEpoch: s.ownerEpoch }, now),
  validate: project.validateAgentSyncLease,
  schedule: (s, now, allocate) => project.scheduleAgentSyncTasks(s, { ownerEpoch: s.ownerEpoch }, now, allocate)
});
