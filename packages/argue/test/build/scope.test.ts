import { describe, expect, test } from "vitest";
import { createBuildState } from "../../src/build/state.js";
import { reserveBuildScope, releaseBuildScope, revokeBuildScope, validateBuildLease } from "../../src/build/scope.js";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import { planInput, runInput } from "./fixtures.js";

export const identities = () => {
  let count = 0;
  return () => ({ attemptId: `attempt-${++count}`, token: `token-${count}` });
};
export const reserve = (taskId: string, workerId: "member-a" | "member-b", requestId = `reserve-${taskId}`) => ({
  taskId,
  workerId,
  requestId,
  ownerEpoch: 1
});

describe("complete scope grants", () => {
  test("A blocks B2 without partial locks; independent B1 shares public reads", () => {
    const allocate = identities();
    const start = createBuildState(runInput());
    const a = reserveBuildScope(start, reserve("T-A", "member-a"), 1000, allocate);
    expect(a.result.kind).toBe("granted");
    const b2 = reserveBuildScope(a.state, reserve("T-B2", "member-b"), 1001, allocate);
    expect(b2.result).toMatchObject({ kind: "waiting", reasons: [{ kind: "lock" }] });
    expect(b2.state.coordination.locks.filter((x) => x.taskId === "T-B2")).toEqual([]);
    expect(b2.state.attempts).toHaveLength(1);
    const b1 = reserveBuildScope(b2.state, reserve("T-B1", "member-b"), 1002, allocate);
    expect(b1.result.kind).toBe("granted");
    expect(b1.state.attempts.filter((x) => x.status === "running").map((x) => x.taskId)).toEqual(["T-A", "T-B1"]);
    expect(b1.state.coordination.locks.filter((x) => x.path === "SPEC.md").map((x) => x.mode)).toEqual(["R", "R"]);
    expect(b1.state.calls).toEqual([]);
    expect(b1.state.attempts[0]).toMatchObject({ baseVersion: "a".repeat(40), inputHash: null, contentHashes: {} });
    expect(start.attempts).toEqual([]);
  });
  test.each([
    ["R", "R", true],
    ["R", "W", false],
    ["W", "R", false],
    ["W", "W", false]
  ] as const)("%s/%s compatibility=%s", (first, second, compatible) => {
    const p = planInput();
    p.tasks[0]!.scope = {
      read: first === "R" ? ["src/normalize.ts"] : [],
      write: first === "W" ? ["src/normalize.ts"] : ["src/report.ts"]
    };
    p.manifest.push({ path: "src/other.ts", access: "writable", contentHash: p.manifest[1]!.contentHash });
    p.tasks[1]!.scope = {
      read: second === "R" ? ["src/normalize.ts"] : [],
      write: second === "W" ? ["src/normalize.ts"] : ["src/other.ts"]
    };
    const allocate = identities();
    const s = createBuildState({ ...runInput(), plan: freezeBuildPlan(p) });
    const a = reserveBuildScope(s, reserve("T-A", "member-a"), 1000, allocate);
    const b = reserveBuildScope(a.state, reserve("T-B1", "member-b"), 1001, allocate);
    expect(b.result.kind).toBe(compatible ? "granted" : "waiting");
    expect(b.state.coordination.locks.filter((x) => x.taskId === "T-B1")).toHaveLength(compatible ? 2 : 0);
  });
  test("a two-write request is all-or-none even when the first path is free", () => {
    const p = planInput();
    p.tasks[0]!.scope.write = ["src/report.ts"];
    p.tasks[2]!.scope.write = ["src/report.ts", "src/normalize.ts"];
    const allocate = identities();
    const a = reserveBuildScope(
      createBuildState({ ...runInput(), plan: freezeBuildPlan(p) }),
      reserve("T-A", "member-a"),
      1000,
      allocate
    );
    const b = reserveBuildScope(a.state, reserve("T-B2", "member-b"), 1001, allocate);
    expect(b.result.kind).toBe("waiting");
    expect(b.state.coordination.locks.some((x) => x.taskId === "T-B2")).toBe(false);
    expect(b.state.attempts).toHaveLength(1);
  });
  test("wrong worker/epoch/task cannot reserve or release someone else's scope", () => {
    const allocate = identities();
    const a = reserveBuildScope(createBuildState(runInput()), reserve("T-A", "member-a"), 1000, allocate);
    if (a.result.kind !== "granted") throw new Error("expected grant");
    for (const request of [
      reserve("T-A", "member-b", "bad-worker"),
      { ...reserve("T-B1", "member-b"), ownerEpoch: 2 },
      reserve("missing", "member-a")
    ]) {
      const bad = reserveBuildScope(a.state, request, 1001, allocate);
      expect(bad.result.kind).toBe("rejected");
      expect(bad.state).toEqual(a.state);
    }
    for (const lease of [
      { ...a.result.lease, workerId: "member-b" as const },
      { ...a.result.lease, taskId: "T-B1" },
      { ...a.result.lease, token: "forged" },
      { ...a.result.lease, leaseEpoch: 2 }
    ]) {
      const bad = releaseBuildScope(a.state, lease, "bad-release", 1001);
      expect(bad.result.kind).toBe("rejected");
      expect(bad.state).toEqual(a.state);
    }
  });
  test("revoke invalidates A before release, preserves B and old leases cannot be revived", () => {
    const allocate = identities();
    const a = reserveBuildScope(createBuildState(runInput()), reserve("T-A", "member-a"), 1000, allocate);
    const b = reserveBuildScope(a.state, reserve("T-B1", "member-b"), 1001, allocate);
    if (a.result.kind !== "granted" || b.result.kind !== "granted") throw new Error("expected grants");
    const revoked = revokeBuildScope(b.state, a.result.lease, "revoke-a", 1002);
    expect(revoked.result.kind).toBe("revoked");
    expect(validateBuildLease(revoked.state, a.result.lease, 1002).valid).toBe(false);
    expect(validateBuildLease(revoked.state, b.result.lease, 1002).valid).toBe(true);
    expect(revoked.state.coordination.locks.every((x) => x.taskId === "T-B1")).toBe(true);
    const fresh = reserveBuildScope(revoked.state, reserve("T-A", "member-a", "retry-a"), 1003, allocate);
    expect(fresh.result).toMatchObject({ kind: "granted", lease: { leaseEpoch: 3 } });
    expect(releaseBuildScope(fresh.state, a.result.lease, "late-release", 1004).result.kind).toBe("rejected");
  });
});
