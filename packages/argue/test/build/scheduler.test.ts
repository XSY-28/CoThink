import { describe, expect, test } from "vitest";
import { createBuildState } from "../../src/build/state.js";
import { reserveBuildScope, releaseBuildScope } from "../../src/build/scope.js";
import { scheduleBuildTasks } from "../../src/build/scheduler.js";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import { planInput, runInput } from "./fixtures.js";
const identities = () => {
  let i = 0;
  return () => ({ attemptId: `attempt-${++i}`, token: `token-${i}` });
};
const request = (taskId: string, workerId: "member-a" | "member-b", requestId = `reserve-${taskId}`) => ({
  taskId,
  workerId,
  requestId,
  ownerEpoch: 1
});

describe("bounded stable domain scheduler", () => {
  test("busy worker's queued task holds no locks; release does not auto-start it", () => {
    const allocate = identities();
    let s = createBuildState(runInput());
    const b = reserveBuildScope(s, request("T-B1", "member-b"), 1000, allocate);
    s = b.state;
    const b2 = reserveBuildScope(s, request("T-B2", "member-b"), 1001, allocate);
    expect(b2.result).toMatchObject({ kind: "waiting", reasons: [{ kind: "worker" }] });
    expect(b2.state.attempts).toHaveLength(1);
    expect(b2.state.coordination.locks.some((x) => x.taskId === "T-B2")).toBe(false);
    if (b.result.kind !== "granted") throw new Error("expected grant");
    const released = releaseBuildScope(b2.state, b.result.lease, "release-b", 1002);
    expect(released.state.attempts).toHaveLength(1);
    const next = scheduleBuildTasks(released.state, { ownerEpoch: 1 }, 1003, allocate);
    expect(next.grants.map((x) => x.taskId)).toEqual(["T-B2"]);
    expect(next.state.calls).toEqual([]);
  });
  test("earlier eligible writer is not bypassed by a later compatible reader", () => {
    const p = planInput();
    p.tasks[0]!.scope = { read: ["src/normalize.ts"], write: ["src/report.ts"] };
    p.manifest.push({ path: "src/other.ts", access: "writable", contentHash: p.manifest[1]!.contentHash });
    p.tasks[1]!.scope = { read: ["src/normalize.ts"], write: ["src/other.ts"] };
    // A later reader of normalize still has an independent write file.
    const allocate = identities();
    let s = createBuildState({ ...runInput(), plan: freezeBuildPlan(p) });
    const a = reserveBuildScope(s, request("T-A", "member-a"), 1000, allocate);
    s = a.state;
    const writer = reserveBuildScope(s, request("T-B2", "member-b"), 1001, allocate);
    s = writer.state;
    const reader = reserveBuildScope(s, request("T-B1", "member-b"), 1002, allocate);
    expect(reader.result).toMatchObject({ kind: "waiting", reasons: [{ kind: "queue", taskIds: ["T-B2"] }] });
    expect(reader.state.waiting.map((x) => x.taskId)).toEqual(["T-B2", "T-B1"]);
    if (a.result.kind !== "granted") throw new Error("expected grant");
    s = releaseBuildScope(reader.state, a.result.lease, "release-a", 1003).state;
    const scheduled = scheduleBuildTasks(s, { ownerEpoch: 1 }, 1004, allocate);
    expect(scheduled.grants.map((x) => x.taskId)).toEqual(["T-B2"]);
  });
  test("dependency blocking is separate from locks and does not block its prerequisite", () => {
    const p = planInput();
    p.tasks[2]!.dependsOn = ["T-A"];
    const allocate = identities();
    let s = createBuildState({ ...runInput(), plan: freezeBuildPlan(p) });
    const dep = reserveBuildScope(s, request("T-B2", "member-b"), 1000, allocate);
    s = dep.state;
    expect(dep.result).toMatchObject({ kind: "waiting", reasons: [{ kind: "dependency", taskIds: ["T-A"] }] });
    expect(s.attempts).toEqual([]);
    const a = reserveBuildScope(s, request("T-A", "member-a"), 1001, allocate);
    expect(a.result.kind).toBe("granted");
    if (a.result.kind !== "granted") throw new Error("expected grant");
    s = releaseBuildScope(a.state, a.result.lease, "release-a", 1002).state;
    expect(scheduleBuildTasks(s, { ownerEpoch: 1 }, 1003, allocate).grants).toEqual([]);
    // Only later trusted publisher acceptance will supply acceptedTasks; release alone proves no completion.
    const accepted = {
      ...s,
      acceptedTasks: ["T-A"],
      coordination: { ...s.coordination, taskStates: { ...s.coordination.taskStates, "T-A": "completed" as const } }
    };
    const ready = scheduleBuildTasks(accepted, { ownerEpoch: 1 }, 1004, allocate);
    expect(ready.grants.map((x) => x.taskId)).toEqual(["T-B2"]);
  });
  test("queue sequence survives replay, repeated polling, removals and fresh retry", () => {
    const allocate = identities();
    const a = reserveBuildScope(createBuildState(runInput()), request("T-A", "member-a"), 1000, allocate);
    const b = reserveBuildScope(a.state, request("T-B2", "member-b"), 1001, allocate);
    const again = reserveBuildScope(b.state, request("T-B2", "member-b"), 1002, allocate);
    expect(again.result.kind).toBe("replayed");
    expect(again.state).toEqual(b.state);
    const polled = scheduleBuildTasks(b.state, { ownerEpoch: 1 }, 1003, allocate);
    expect(polled.state.waiting).toEqual(b.state.waiting);
    expect(polled.state.attempts).toHaveLength(1);
    expect(polled.state.coordination.nextSequence).toBe(2);
  });
  test("same request ID with another payload is rejected before allocation", () => {
    const allocate = identities();
    const a = reserveBuildScope(createBuildState(runInput()), request("T-A", "member-a", "same"), 1000, allocate);
    const bad = reserveBuildScope(a.state, request("T-B1", "member-b", "same"), 1001, () => {
      throw new Error("must not allocate");
    });
    expect(bad.result).toMatchObject({ kind: "rejected", code: "request_id_conflict" });
    expect(bad.state).toEqual(a.state);
  });
});
