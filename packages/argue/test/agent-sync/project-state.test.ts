import { describe, expect, test } from "vitest";
import * as api from "../../src/agent-sync/project/index.js";
import { sha256, hashJson } from "../../src/peer/hash.js";
import { projectState, control, allocate } from "./project-fixture.js";
describe("shared project coordinator", () => {
  test("exports the project coordination operations", () => {
    expect(api).toHaveProperty("reserveAgentSyncScope", expect.any(Function));
  });
  test.each([1, 2, 3])("preserves %i custom workers and queues full scopes", (count) => {
    let state = projectState(count);
    const first = api.reserveAgentSyncScope(state, control("reserve", 0), 1000, allocate);
    state = first.state;
    expect(first.result.kind).toBe("granted");
    expect(state.attempts[0]?.workerId).toBe("custom0");
    if (count > 1) {
      const second = api.reserveAgentSyncScope(state, control("reserve", 1), 1001, allocate);
      state = second.state;
      expect(second.result.kind).toBe("waiting");
    }
    if (count > 2) {
      const third = api.reserveAgentSyncScope(state, control("reserve", 2), 1002, allocate);
      state = third.state;
      expect(third.result.kind).toBe("granted");
    }
    expect(state.coordination.locks.map((x) => x.path)).toEqual(
      count === 3 ? ["shared.ts", "other.ts"] : ["shared.ts"]
    );
    const replay = api.reserveAgentSyncScope(state, control("reserve", 0), 1003, () => {
      throw Error("replay allocated");
    });
    expect(replay.result.kind).toBe("replayed");
    expect(replay.state).toEqual(state);
    const lease = api.agentSyncLeaseFromAttempt(state, state.attempts[0]!);
    for (const corrupted of [
      { ...lease, projectKey: "foreign" },
      { ...lease, runId: "foreign" },
      { ...lease, planHash: sha256("foreign") },
      { ...lease, leaseVersion: "other" }
    ])
      expect(api.validateAgentSyncLease(state, corrupted, 1003).valid).toBe(false);
    const released = api.releaseAgentSyncScope(
      state,
      { requestVersion: api.AGENT_SYNC_REQUEST_VERSION, operation: "release", requestId: "release", lease },
      1003
    );
    expect(released.result.kind).toBe("released");
    expect(api.validateAgentSyncLease(released.state, lease, 1003).valid).toBe(false);
    if (count > 1)
      expect(api.scheduleAgentSyncTasks(released.state, { ownerEpoch: 1 }, 1004, allocate).grants[0]?.workerId).toBe(
        "custom1"
      );
    expect(api.agentSyncRequestHash(state, "reserve", control("reserve", 0))).toBe(
      hashJson({
        projectKey: state.projectKey,
        runId: state.runId,
        planHash: state.plan.planHash,
        operation: "reserve",
        payload: control("reserve", 0)
      })
    );
  });
  test("semantic parsing rejects unexplained pending control requests", () => {
    const state = projectState();
    expect(() =>
      api.parseAgentSyncState({
        ...state,
        coordination: {
          ...state.coordination,
          requests: [
            {
              requestVersion: api.AGENT_SYNC_REQUEST_VERSION,
              requestId: "pending",
              payloadHash: sha256("pending"),
              operation: "reserve",
              status: "pending",
              attemptId: null,
              result: null
            }
          ]
        }
      })
    ).toThrow();
  });
});

describe("project protocol boundary cases", () => {
  test("versioned raw controls reject wrong operation and unversioned legacy layouts", () => {
    const initial = projectState(),
      request = control("reserve", 0);
    const { requestVersion: _version, ...legacy } = request;
    void _version;
    expect(() => api.reserveAgentSyncScope(initial, legacy, 1000, allocate)).toThrow();
    const grant = api.reserveAgentSyncScope(initial, request, 1000, allocate);
    const lease = api.agentSyncLeaseFromAttempt(grant.state, grant.state.attempts[0]!);
    expect(() =>
      api.releaseAgentSyncScope(
        grant.state,
        { requestVersion: api.AGENT_SYNC_REQUEST_VERSION, operation: "revoke", requestId: "wrong", lease },
        1001
      )
    ).toThrow(/operation/);
    const { leaseVersion: _lv, projectKey: _pk, runId: _r, planHash: _p, ...oldLease } = lease;
    void [_lv, _pk, _r, _p];
    expect(api.validateAgentSyncLease(grant.state, oldLease, 1001)).toEqual({ valid: false, code: "invalid_identity" });
    expect(initial.attempts).toHaveLength(0);
  });
  test("semantic parser rejects partial locks, duplicate tokens, stale ownership and queue-state disagreement", () => {
    let state = api.reserveAgentSyncScope(projectState(), control("reserve", 0), 1000, allocate).state;
    state = api.reserveAgentSyncScope(state, control("reserve", 2), 1000, allocate).state;
    for (const bad of [
      { ...state, coordination: { ...state.coordination, locks: state.coordination.locks.slice(1) } },
      { ...state, attempts: state.attempts.map((a) => ({ ...a, token: "duplicate" })) },
      { ...state, ownerEpoch: 2 },
      {
        ...state,
        coordination: { ...state.coordination, taskStates: { ...state.coordination.taskStates, task1: "waiting" } }
      }
    ])
      expect(() => api.parseAgentSyncState(bad)).toThrow();
  });
  test("eligible waiter reserves queue priority for its full scope without taking partial locks", () => {
    const base = projectState(),
      { planHash: _hash, ...definition } = base.plan;
    void _hash;
    const project = api.freezeAgentSyncProject({
      ...definition,
      tasks: definition.tasks.map((t) =>
        t.taskId === "task1" ? { ...t, scope: { read: [], write: ["shared.ts", "other.ts"] } } : t
      )
    });
    let state = api.createAgentSyncState({ project, runId: "fair", acceptedVersion: base.acceptedVersion, now: 1000 });
    let allocations = 0;
    const alloc: api.AgentSyncLeaseAllocator = (c) => {
      allocations++;
      return allocate(c);
    };
    state = api.reserveAgentSyncScope(state, control("reserve", 0), 1000, alloc).state;
    state = api.reserveAgentSyncScope(state, control("reserve", 1), 1001, alloc).state;
    const queued = api.reserveAgentSyncScope(state, control("reserve", 2), 1002, alloc);
    state = queued.state;
    expect(queued.result).toMatchObject({ kind: "waiting", reasons: [{ kind: "queue", taskIds: ["task1"] }] });
    expect(allocations).toBe(1);
    expect(state.coordination.locks).toHaveLength(1);
    const lease = api.agentSyncLeaseFromAttempt(state, state.attempts[0]!);
    const released = api.releaseAgentSyncScope(
      state,
      { requestVersion: api.AGENT_SYNC_REQUEST_VERSION, operation: "release", requestId: "release", lease },
      1003
    );
    const next = api.scheduleAgentSyncTasks(released.state, { ownerEpoch: 1 }, 1003, alloc);
    expect(next.grants.map((g) => g.taskId)).toEqual(["task1"]);
    expect(next.state.coordination.locks.map((l) => l.path).sort()).toEqual(["other.ts", "shared.ts"]);
  });
  test("dependency-blocked waiter does not take conflict priority", () => {
    const base = projectState(),
      { planHash: _hash, ...definition } = base.plan;
    void _hash;
    const project = api.freezeAgentSyncProject({
      ...definition,
      tasks: definition.tasks.map((t) => ({
        ...t,
        scope: { read: [], write: ["shared.ts"] },
        dependsOn: t.taskId === "task1" ? ["task0"] : []
      }))
    });
    const initial = api.createAgentSyncState({
      project,
      runId: "dependency",
      acceptedVersion: base.acceptedVersion,
      now: 1000
    });
    const wait = api.reserveAgentSyncScope(initial, control("reserve", 1), 1000, allocate);
    expect(wait.result).toMatchObject({ kind: "waiting", reasons: [{ kind: "dependency", taskIds: ["task0"] }] });
    const next = api.reserveAgentSyncScope(wait.state, control("reserve", 2), 1001, allocate);
    expect(next.result.kind).toBe("granted");
    expect(next.state.coordination.locks).toHaveLength(1);
  });
  test("host identities cannot reuse attempt IDs or tokens; cancel allows an explicit new lease", () => {
    const grant = api.reserveAgentSyncScope(projectState(), control("reserve", 0), 1000, allocate);
    expect(() =>
      api.reserveAgentSyncScope(grant.state, control("reserve", 2), 1001, () => ({
        attemptId: "task0-1",
        token: "different"
      }))
    ).toThrow(/identity/);
    expect(() =>
      api.reserveAgentSyncScope(grant.state, control("reserve", 2), 1001, () => ({
        attemptId: "different",
        token: "token-task0-1"
      }))
    ).toThrow(/identity/);
    const cancelled = api.cancelAgentSyncTask(grant.state, control("cancel", 0), 1001);
    expect(cancelled.state.coordination.locks).toHaveLength(0);
    const resumed = api.reserveAgentSyncScope(cancelled.state, control("reserve", 0, "resume"), 1002, allocate);
    expect(resumed.result.kind).toBe("granted");
    expect(resumed.state.attempts[1]?.leaseEpoch).toBe(3);
  });
});

test("publication check selection unions accepted tasks and declared final profile in declaration order", () => {
  const initial = projectState(),
    { planHash: _hash, ...definition } = initial.plan;
  void _hash;
  const project = api.freezeAgentSyncProject({
    ...definition,
    profiles: [
      { profileId: "first", checkIds: ["zeta", "shared"] },
      { profileId: "second", checkIds: ["alpha", "shared"] },
      { profileId: "complete", checkIds: ["end", "zeta"] }
    ],
    finalProfileId: "complete",
    tasks: definition.tasks.map((t) => ({ ...t, checkProfileId: t.taskId === "task0" ? "first" : "second" }))
  });
  const state = api.createAgentSyncState({
    project,
    runId: "checks",
    acceptedVersion: initial.acceptedVersion,
    now: 1000
  });
  expect(api.agentSyncPublicationChecks(state, "task0")).toEqual(["zeta", "shared"]);
  expect(api.agentSyncPublicationChecks({ ...state, acceptedTasks: ["task0"] }, "task1")).toEqual([
    "zeta",
    "shared",
    "alpha"
  ]);
  expect(api.agentSyncPublicationChecks({ ...state, acceptedTasks: ["task0", "task1"] }, "task2")).toEqual([
    "zeta",
    "shared",
    "alpha",
    "end"
  ]);
});
