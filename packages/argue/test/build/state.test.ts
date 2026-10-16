import { describe, expect, test } from "vitest";
import {
  createBuildState,
  bindBuildInput,
  admitBuildAction,
  settleBuildAction,
  expireBuildState,
  advanceBuildOwnerEpoch,
  parseBuildState,
  cancelBuildTask
} from "../../src/build/state.js";
import { reserveBuildScope, revokeBuildScope, releaseBuildScope, validateBuildLease } from "../../src/build/scope.js";
import { runInput, planInput } from "./fixtures.js";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import { sha256 } from "../../src/peer/hash.js";
const allocate = () => ({ attemptId: "attempt-a", token: "token-a" });
const granted = () => {
  const result = reserveBuildScope(
    createBuildState(runInput()),
    { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "reserve-a" },
    1000,
    allocate
  );
  if (result.result.kind !== "granted") throw new Error("Expected grant");
  return { state: result.state, lease: result.result.lease };
};
const input = () => ({
  baseVersion: "a".repeat(40),
  inputHash: sha256("frozen input"),
  contentHashes: { "SPEC.md": sha256("spec"), "src/normalize.ts": sha256("v0") }
});
const bound = () => {
  const { state, lease } = granted();
  const ready = bindBuildInput(state, lease, "bind-a", input(), 1001);
  return { state: ready.state, lease };
};
const action = { kind: "inspect" as const, path: "src/normalize.ts" };

describe("clock, lease and request lifecycle", () => {
  test("grant is unbound until host freezes exact full-scope input", () => {
    const { state, lease } = granted();
    const blocked = admitBuildAction(state, lease, "inspect-a", input().inputHash, action, 1001);
    expect(blocked.result).toMatchObject({ kind: "rejected", code: "input_not_bound" });
    expect(blocked.state).toEqual(state);
    const ready = bindBuildInput(state, lease, "bind-a", input(), 1001);
    expect(ready.result.kind).toBe("bound");
    expect(ready.state.attempts[0]).toMatchObject(input());
    expect(Object.isFrozen(ready.state.attempts[0]!.contentHashes)).toBe(true);
    expect(admitBuildAction(ready.state, lease, "inspect-a", input().inputHash, action, 1002).result.kind).toBe(
      "ready"
    );
  });
  test("binding rejects missing/extra scope hashes, wrong base and mutation of an existing input", () => {
    const { state, lease } = granted();
    for (const invalid of [
      { ...input(), contentHashes: { "SPEC.md": sha256("spec") } },
      { ...input(), contentHashes: { ...input().contentHashes, "src/report.ts": sha256("report") } },
      { ...input(), baseVersion: "b".repeat(40) }
    ]) {
      const r = bindBuildInput(state, lease, "bad-bind", invalid, 1001);
      expect(r.result.kind).toBe("rejected");
      expect(r.state).toEqual(state);
    }
    const ready = bindBuildInput(state, lease, "bind-a", input(), 1001);
    expect(
      bindBuildInput(ready.state, lease, "bind-again", { ...input(), inputHash: sha256("different") }, 1002).result.kind
    ).toBe("rejected");
  });
  test("grant after waiting captures the then-current accepted version", () => {
    const { state, lease } = granted();
    const wait = reserveBuildScope(
      state,
      { ownerEpoch: 1, workerId: "member-b", taskId: "T-B2", requestId: "reserve-b2" },
      1001,
      () => {
        throw new Error("wait must not allocate");
      }
    );
    expect(wait.result.kind).toBe("waiting");
    const released = releaseBuildScope(wait.state, lease, "release-a", 1002);
    const updated = { ...released.state, acceptedVersion: "b".repeat(40) };
    const fresh = reserveBuildScope(
      updated,
      { ownerEpoch: 1, workerId: "member-b", taskId: "T-B2", requestId: "reserve-b2-fresh" },
      1003,
      () => ({ attemptId: "attempt-b", token: "token-b" })
    );
    expect(fresh.result.kind).toBe("granted");
    expect(fresh.state.attempts[1]).toMatchObject({ baseVersion: "b".repeat(40), inputHash: null, contentHashes: {} });
  });
  test("exact attempt deadline rejects new work and sweep revokes before freeing locks", () => {
    const { state, lease } = bound();
    const deadline = state.attempts[0]!.deadlineAt;
    expect(validateBuildLease(state, lease, deadline - 1).valid).toBe(true);
    expect(validateBuildLease(state, lease, deadline).valid).toBe(false);
    expect(admitBuildAction(state, lease, "late", input().inputHash, action, deadline).result.kind).toBe("rejected");
    const expired = expireBuildState(state, { ownerEpoch: 1 }, deadline);
    expect(expired.state.attempts[0]!.status).toBe("paused");
    expect(expired.state.coordination.locks).toEqual([]);
    expect(expired.state.calls).toEqual([]);
  });
  test("run deadline stops grants, expires all attempts and preserves the accepted version", () => {
    const { state } = bound();
    const expired = expireBuildState(state, { ownerEpoch: 1 }, state.deadlineAt);
    expect(expired.state.status).toBe("paused");
    expect(expired.state.acceptedVersion).toBe(state.acceptedVersion);
    expect(
      reserveBuildScope(
        expired.state,
        { ownerEpoch: 1, workerId: "member-b", taskId: "T-B1", requestId: "after-run" },
        state.deadlineAt,
        () => {
          throw new Error("must not allocate");
        }
      ).result.kind
    ).toBe("rejected");
  });
  test("epoch handoff invalidates all old leases and preserves immutable history", () => {
    const { state, lease } = bound();
    const changed = advanceBuildOwnerEpoch(state, { ownerEpoch: 1 }, "handoff", 1002);
    expect(changed.result.kind).toBe("epoch_advanced");
    expect(changed.state.ownerEpoch).toBe(2);
    expect(changed.state.coordination.locks).toEqual([]);
    expect(validateBuildLease(changed.state, lease, 1002).valid).toBe(false);
    expect(admitBuildAction(changed.state, lease, "old-new", input().inputHash, action, 1003).result.kind).toBe(
      "rejected"
    );
    expect(advanceBuildOwnerEpoch(changed.state, { ownerEpoch: 1 }, "bad-handoff", 1003).result.kind).toBe("rejected");
  });
  test("successful request replay after revoke or epoch change returns only original receipt", () => {
    const { state, lease } = bound();
    const pending = admitBuildAction(state, lease, "inspect-a", input().inputHash, action, 1002);
    expect(pending.result.kind).toBe("ready");
    const done = settleBuildAction(pending.state, lease, "inspect-a", sha256("observed output"), 1003);
    expect(done.result.kind).toBe("settled");
    expect(done.state.actionReceipts).toHaveLength(1);
    const revoked = revokeBuildScope(done.state, lease, "revoke-a", 1004);
    const replay = admitBuildAction(revoked.state, lease, "inspect-a", input().inputHash, action, 1005);
    expect(replay.result).toMatchObject({ kind: "replayed", receipt: { outputHash: sha256("observed output") } });
    expect(replay.state).toEqual(revoked.state);
    expect(replay.state.actionReceipts).toHaveLength(1);
    expect(admitBuildAction(revoked.state, lease, "new-inspect", input().inputHash, action, 1005).result.kind).toBe(
      "rejected"
    );
    const changed = advanceBuildOwnerEpoch(done.state, { ownerEpoch: 1 }, "epoch", 1004);
    expect(admitBuildAction(changed.state, lease, "inspect-a", input().inputHash, action, 1005).result.kind).toBe(
      "replayed"
    );
  });
  test("unfinished request cannot be queried as success after revoke or settled late", () => {
    const { state, lease } = bound();
    const pending = admitBuildAction(state, lease, "pending", input().inputHash, action, 1002);
    expect(admitBuildAction(pending.state, lease, "pending", input().inputHash, action, 1003).result).toMatchObject({
      kind: "rejected",
      code: "request_in_flight"
    });
    const revoked = revokeBuildScope(pending.state, lease, "revoke", 1003);
    expect(admitBuildAction(revoked.state, lease, "pending", input().inputHash, action, 1004).result.kind).toBe(
      "rejected"
    );
    expect(settleBuildAction(revoked.state, lease, "pending", sha256("late"), 1004).result.kind).toBe("rejected");
    expect(revoked.state.actionReceipts).toEqual([]);
  });
  test("same request ID with changed action/hash/identity is rejected even after completion", () => {
    const { state, lease } = bound();
    const pending = admitBuildAction(state, lease, "same", input().inputHash, action, 1002);
    const done = settleBuildAction(pending.state, lease, "same", sha256("output"), 1003);
    for (const [identity, hash, payload] of [
      [lease, input().inputHash, { kind: "check" }],
      [lease, sha256("new"), action],
      [{ ...lease, token: "forged" }, input().inputHash, action]
    ] as const) {
      const bad = admitBuildAction(done.state, identity, "same", hash, payload, 1004);
      expect(bad.result).toMatchObject({ kind: "rejected", code: "request_id_conflict" });
      expect(bad.state).toEqual(done.state);
    }
    expect(settleBuildAction(done.state, lease, "same", sha256("another output"), 1004).result.kind).toBe("rejected");
  });
  test.each([
    { kind: "inspect", path: "src/report.ts" },
    { kind: "edit", path: "SPEC.md", text: "x", expectedContentHash: null }
  ])("current lease does not expand scope: %j", (payload) => {
    const { state, lease } = bound();
    expect(admitBuildAction(state, lease, "outside", input().inputHash, payload, 1002).result.kind).toBe("rejected");
  });
  test("monotonic injected time rejects backwards/invalid clocks without resurrecting expired work", () => {
    const { state, lease } = bound();
    for (const now of [999, -1, NaN, Infinity, 0.5]) expect(() => validateBuildLease(state, lease, now)).toThrow();
    const expired = expireBuildState(state, { ownerEpoch: 1 }, 901000);
    expect(() => validateBuildLease(expired.state, lease, 1002)).toThrow();
  });
  test("state validation rejects partial locks, conflicting locks and unknown owners", () => {
    const { state } = bound();
    const partial = { ...state, coordination: { ...state.coordination, locks: state.coordination.locks.slice(1) } };
    expect(() => parseBuildState(partial)).toThrow();
    expect(() =>
      parseBuildState({
        ...state,
        coordination: {
          ...state.coordination,
          locks: [...state.coordination.locks, { ...state.coordination.locks[0], attemptId: "missing" }]
        }
      })
    ).toThrow();
    expect(() =>
      parseBuildState({
        ...state,
        coordination: { ...state.coordination, taskEpochs: { ...state.coordination.taskEpochs, "T-A": 99 } }
      })
    ).toThrow();
  });
  test("host allocator errors or reuse cannot leave partial state", () => {
    const { state, lease } = granted();
    const released = releaseBuildScope(state, lease, "release", 1001);
    expect(() =>
      reserveBuildScope(
        released.state,
        { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "retry" },
        1002,
        allocate
      )
    ).toThrow();
    expect(released.state.attempts).toHaveLength(1);
    expect(released.state.coordination.locks).toEqual([]);
  });
});

describe("explicit host retry and cancellation", () => {
  test("fresh reserve at exact expiry first invalidates old lease and grants a new epoch", () => {
    const { state, lease } = bound();
    const now = state.attempts[0]!.deadlineAt;
    const fresh = reserveBuildScope(
      state,
      { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "retry-expired" },
      now,
      () => ({ attemptId: "attempt-new", token: "token-new" })
    );
    expect(fresh.result).toMatchObject({ kind: "granted", lease: { leaseEpoch: 3 } });
    expect(fresh.state.attempts[0]!.status).toBe("paused");
    expect(fresh.state.coordination.locks.every((x) => x.attemptId === "attempt-new")).toBe(true);
    expect(validateBuildLease(fresh.state, lease, now).valid).toBe(false);
  });
  test("cancelling a waiting task removes its queue item without affecting independent owner", () => {
    const { state, lease } = granted();
    const wait = reserveBuildScope(
      state,
      { ownerEpoch: 1, workerId: "member-b", taskId: "T-B2", requestId: "queue-b2" },
      1001,
      () => {
        throw new Error("must not allocate");
      }
    );
    const cancelled = cancelBuildTask(
      wait.state,
      { ownerEpoch: 1, workerId: "member-b", taskId: "T-B2", requestId: "cancel-b2" },
      1002
    );
    expect(cancelled.result.kind).toBe("cancelled");
    expect(cancelled.state.waiting).toEqual([]);
    expect(cancelled.state.coordination.taskStates["T-B2"]).toBe("cancelled");
    expect(cancelled.state.attempts).toHaveLength(1);
    expect(validateBuildLease(cancelled.state, lease, 1002).valid).toBe(true);
    const replay = cancelBuildTask(
      cancelled.state,
      { ownerEpoch: 1, workerId: "member-b", taskId: "T-B2", requestId: "cancel-b2" },
      1003
    );
    expect(replay.result.kind).toBe("replayed");
    expect(replay.state).toEqual(cancelled.state);
  });
  test("wrong host cannot cancel an active task; current host cancellation invalidates pending actions", () => {
    const { state, lease } = bound();
    const pending = admitBuildAction(state, lease, "pending-cancel", input().inputHash, action, 1002);
    const bad = cancelBuildTask(
      pending.state,
      { ownerEpoch: 2, workerId: "member-a", taskId: "T-A", requestId: "bad-cancel" },
      1003
    );
    expect(bad.result.kind).toBe("rejected");
    expect(bad.state).toEqual(pending.state);
    const good = cancelBuildTask(
      pending.state,
      { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "cancel-active" },
      1003
    );
    expect(good.state.coordination.requests.find((r) => r.requestId === "pending-cancel")?.status).toBe("invalidated");
    expect(good.state.coordination.locks).toEqual([]);
    expect(admitBuildAction(good.state, lease, "pending-cancel", input().inputHash, action, 1004).result.kind).toBe(
      "rejected"
    );
  });
  test("an exact completed release query after a new grant cannot release the replacement", () => {
    const { state, lease } = granted();
    const released = releaseBuildScope(state, lease, "release-id", 1001);
    const fresh = reserveBuildScope(
      released.state,
      { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "retry-after-release" },
      1002,
      () => ({ attemptId: "replacement", token: "replacement-token" })
    );
    const replay = releaseBuildScope(fresh.state, lease, "release-id", 1003);
    expect(replay.result.kind).toBe("replayed");
    expect(replay.state).toEqual(fresh.state);
    expect(replay.state.coordination.locks.every((x) => x.attemptId === "replacement")).toBe(true);
  });
});

describe("exact keys and completed request references", () => {
  test("declared __proto__ filename retains its own hash through binding and parsing", () => {
    const p = planInput();
    p.manifest.push({ path: "__proto__", access: "writable", contentHash: sha256("file") });
    p.tasks[0]!.scope.write.push("__proto__");
    const initial = createBuildState({ ...runInput(), plan: freezeBuildPlan(p) });
    const grant = reserveBuildScope(
      initial,
      { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "reserve-prototype" },
      1000,
      allocate
    );
    if (grant.result.kind !== "granted") throw new Error("expected grant");
    const snapshot = {
      ...input(),
      contentHashes: Object.fromEntries([...Object.entries(input().contentHashes), ["__proto__", sha256("file")]])
    };
    const bound = bindBuildInput(grant.state, grant.result.lease, "bind-prototype", snapshot, 1001);
    expect(bound.result.kind).toBe("bound");
    expect(Object.hasOwn(bound.state.attempts[0]!.contentHashes, "__proto__")).toBe(true);
    expect(bound.state.attempts[0]!.contentHashes["__proto__"]).toBe(sha256("file"));
    expect(parseBuildState(bound.state)).toEqual(bound.state);
  });
  test("completed request cannot reference another request's successful receipt or binding", () => {
    const { state, lease } = bound();
    const first = settleBuildAction(
      admitBuildAction(state, lease, "one", input().inputHash, action, 1002).state,
      lease,
      "one",
      sha256("one output"),
      1003
    );
    const second = settleBuildAction(
      admitBuildAction(first.state, lease, "two", input().inputHash, action, 1004).state,
      lease,
      "two",
      sha256("two output"),
      1005
    );
    const two = second.state.coordination.requests.find((x) => x.requestId === "two")!;
    const swapped = {
      ...second.state,
      actionReceipts: second.state.actionReceipts.filter((x) => x.requestId !== "one"),
      coordination: {
        ...second.state.coordination,
        requests: second.state.coordination.requests.map((x) =>
          x.requestId === "one" ? { ...x, binding: two.binding, result: two.result } : x
        )
      }
    };
    expect(() => parseBuildState(swapped)).toThrow();
    const badAttempt = {
      ...second.state,
      coordination: {
        ...second.state.coordination,
        requests: second.state.coordination.requests.map((x) => (x.requestId === "one" ? { ...x, attemptId: null } : x))
      }
    };
    expect(() => parseBuildState(badAttempt)).toThrow();
  });
});
