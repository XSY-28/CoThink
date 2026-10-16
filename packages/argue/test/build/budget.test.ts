import { describe, expect, test } from "vitest";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import { createBuildState, bindBuildInput } from "../../src/build/state.js";
import { reserveBuildScope } from "../../src/build/scope.js";
import { reserveBuildCall, settleBuildCall, recoverBuildCalls } from "../../src/build/budget.js";
import { buildResult } from "../../src/build/result.js";
import { sha256 } from "../../src/peer/hash.js";
import { planInput, runInput } from "./fixtures.js";

function ready(limits: Record<string, number> = {}, bind = true) {
  const p = planInput();
  Object.assign(p.budget, limits);
  const initial = createBuildState({
    ...runInput(),
    plan: freezeBuildPlan(p),
    deadlineAt: 1000 + p.budget.runTimeoutMs
  });
  const grant = reserveBuildScope(
    initial,
    { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "reserve-a" },
    1000,
    () => ({ attemptId: "attempt-a", token: "private-token" })
  );
  if (grant.result.kind !== "granted") throw new Error("Expected grant");
  const lease = grant.result.lease;
  const state = bind
    ? bindBuildInput(
        grant.state,
        lease,
        "bind-a",
        {
          baseVersion: "a".repeat(40),
          inputHash: sha256("input"),
          contentHashes: { "SPEC.md": sha256("spec"), "src/normalize.ts": sha256("v0") }
        },
        1001
      ).state
    : grant.state;
  return { state, lease };
}

describe("durable model reservations", () => {
  test("reserves immutable call allocations before dispatch, with deadline clipped to attempt", () => {
    const { state, lease } = ready();
    const r = reserveBuildCall(state, lease, "call-1", 1002);
    expect(state.calls).toHaveLength(0);
    expect(r.state.calls).toHaveLength(1);
    expect(r.call).toMatchObject({
      callId: "call-1",
      attemptId: "attempt-a",
      taskId: "T-A",
      allocatedOutputTokens: 4096,
      reservedAt: 1002,
      deadlineAt: 121002,
      status: "reserved"
    });
    expect(Object.isFrozen(r.call)).toBe(true);
    expect(reserveBuildCall(r.state, lease, "call-late", 900999, 1).call.deadlineAt).toBe(901000);
  });
  test("rejects duplicates, invalid allocation, unbound input, wrong lease and exact expiry", () => {
    const { state, lease } = ready();
    const first = reserveBuildCall(state, lease, "one", 1002);
    expect(() => reserveBuildCall(first.state, lease, "one", 1003)).toThrow();
    for (const allocation of [0, -1, 1.5, 4097, Number.MAX_SAFE_INTEGER])
      expect(() => reserveBuildCall(state, lease, "bad", 1002, allocation)).toThrow();
    const unbound = ready({}, false);
    expect(() => reserveBuildCall(unbound.state, unbound.lease, "unbound", 1002)).toThrow();
    expect(() => reserveBuildCall(state, { ...lease, token: "wrong" }, "wrong", 1002)).toThrow();
    expect(() => reserveBuildCall(state, lease, "expired", 901000)).toThrow();
  });
  test("failed and unknown calls retain task and run allocations without refunds", () => {
    const { state, lease } = ready({
      maxCallsPerTask: 2,
      maxCalls: 2,
      maxOutputTokensPerCall: 4,
      maxAllocatedOutputTokensPerTask: 6,
      maxAllocatedOutputTokens: 6
    });
    const first = settleBuildCall(reserveBuildCall(state, lease, "first", 1002, 4).state, "first", "failed", 1003);
    const second = recoverBuildCalls(reserveBuildCall(first, lease, "second", 1004, 2).state, 1005);
    expect(second.calls.map((c) => c.status)).toEqual(["failed", "unknown"]);
    expect(() => reserveBuildCall(second, lease, "third", 1006, 1)).toThrow();
    expect(buildResult(second).budget).toEqual({
      calls: 2,
      allocatedOutputTokens: 6,
      maxCalls: 2,
      maxAllocatedOutputTokens: 6
    });
  });
  test("token ceiling alone blocks the next allocation", () => {
    const { state, lease } = ready({
      maxOutputTokensPerCall: 4,
      maxAllocatedOutputTokensPerTask: 5,
      maxAllocatedOutputTokens: 5
    });
    const r = reserveBuildCall(state, lease, "one", 1002, 4);
    expect(() => reserveBuildCall(r.state, lease, "two", 1003, 2)).toThrow();
  });
  test("terminal settlement is immutable and historical replay cannot change unknown", () => {
    const { state, lease } = ready();
    const r = reserveBuildCall(state, lease, "one", 1002);
    const done = settleBuildCall(r.state, "one", "succeeded", 1003);
    expect(settleBuildCall(done, "one", "succeeded", 1004)).toEqual(done);
    expect(() => settleBuildCall(done, "one", "failed", 1004)).toThrow();
    const unknown = recoverBuildCalls(r.state, 1004);
    expect(() => settleBuildCall(unknown, "one", "succeeded", 1005)).toThrow();
    expect(() => settleBuildCall(done, "missing", "failed", 1004)).toThrow();
    expect(recoverBuildCalls(unknown, 1005)).toEqual(unknown);
    expect(unknown.attempts).toEqual(r.state.attempts);
    expect(unknown.ownerEpoch).toBe(r.state.ownerEpoch);
  });
  test("late observations preserve authority time and expired reservations remain charged", () => {
    const { state, lease } = ready();
    const pending = reserveBuildCall(state, lease, "one", 1002).state;
    const recovered = recoverBuildCalls(pending, 9999999);
    expect(recovered.calls[0]!.status).toBe("unknown");
    expect(recovered.coordination.lastNow).toBe(1002);
    expect(recovered.attempts[0]!.status).toBe("running");
    const late = settleBuildCall(pending, "one", "cancelled", 9999999);
    expect(late.calls[0]!.status).toBe("cancelled");
    expect(late.coordination.lastNow).toBe(1002);
    expect(() => reserveBuildCall(recovered, lease, "again", 9999999)).toThrow();
    expect(() => recoverBuildCalls(pending, 1001)).toThrow();
  });
  test("call IDs cannot collide with durable host requests", () => {
    const { state, lease } = ready();
    expect(() => reserveBuildCall(state, lease, "bind-a", 1002)).toThrow();
  });
  test("public results expose bounded task status and cost without host authority", () => {
    const { state } = ready();
    const reasons = { "T-A": "call failed" };
    const result = buildResult(state, reasons);
    reasons["T-A"] = "changed";
    expect(result).toMatchObject({
      resultVersion: "build-result-v1",
      status: "incomplete",
      tasks: [
        { taskId: "T-A", status: "running", reason: "call failed" },
        { taskId: "T-B1", status: "queued", reason: "queued" },
        { taskId: "T-B2", status: "queued", reason: "queued" }
      ]
    });
    expect(Object.isFrozen(result.tasks)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(JSON.stringify(result)).not.toContain("ownerEpoch");
  });
});
