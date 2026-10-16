import { describe, expect, test } from "vitest";
import { createBuildState } from "../../src/build/state.js";
import { reserveBuildScope } from "../../src/build/scope.js";
import { hashJson } from "../../src/peer/hash.js";
import {
  validatePublisherPortResult,
  validateVerifierPortResult,
  validateWorkspacePortResult
} from "../../src/build/sync-port.js";
import { runInput } from "./fixtures.js";
import { exerciseSyncPortContract, MemoryBuildSync } from "./sync-port-fixture.js";

function setup() {
  const reservation = reserveBuildScope(
    createBuildState(runInput()),
    { taskId: "T-A", workerId: "member-a", requestId: "reserve-a", ownerEpoch: 1 },
    1000,
    () => ({ attemptId: "attempt-a", token: "token-a" })
  );
  if (reservation.result.kind !== "granted") throw new Error("expected lease");
  return {
    sync: new MemoryBuildSync(reservation.state, {
      "SPEC.md": "spec",
      "src/normalize.ts": "v0",
      "src/report.ts": "total"
    }),
    lease: reservation.result.lease
  };
}
describe("replaceable sync contracts; memory is not isolation evidence", () => {
  test("shared contract exercises real memory state effects and read-only replay", async () => {
    const { sync, lease } = setup();
    await exerciseSyncPortContract({ ports: sync.ports, lease, load: () => sync.load() });
  });
  test("workspace rejects wrong hashes, versions, kinds and request identity without effects", async () => {
    const { sync, lease } = setup();
    await sync.ports.workspace.freezeInput(lease, "freeze");
    const read = await sync.ports.workspace.inspect(lease, "inspect", "src/normalize.ts");
    const state = sync.state;
    const request = { operation: "inspect" as const, lease, requestId: "inspect", path: "src/normalize.ts" };
    for (const bad of [
      { ...read, contentHash: hashJson("wrong") },
      { ...read, baseVersion: "f".repeat(40) },
      { ...read, kind: "sealed" }
    ])
      expect(() => validateWorkspacePortResult(state, request, bad)).toThrow();
    expect(() => validateWorkspacePortResult(state, { ...request, requestId: "different" }, read)).toThrow();
    expect(sync.state).toBe(state);
  });
  test("verifier rejects bad candidates, request identities and legacy fake passed", async () => {
    const { sync, lease } = setup();
    await sync.ports.workspace.freezeInput(lease, "freeze");
    const candidate = await sync.ports.workspace.seal(lease, "seal");
    const request = { requestId: "check", lease, candidate };
    const response = await sync.ports.verifier.check(request);
    const state = sync.state;
    for (const bad of [
      { ...response, requestId: "different" },
      { ...response, receipt: { ...response.receipt, candidateHash: hashJson("wrong") } },
      { ...response, receipt: { ...response.receipt, version: "f".repeat(40) } }
    ])
      expect(() => validateVerifierPortResult(state, request, bad)).toThrow();
    const {
      baseVersion: _b,
      version: _v,
      planHash: _p,
      imageDigest: _i,
      sourceHashBefore: _s,
      sourceHashAfter: _a,
      ...legacy
    } = response.receipt;
    void [_b, _v, _p, _i, _s, _a];
    expect(() => validateVerifierPortResult(state, request, { ...response, receipt: legacy })).toThrow();
    expect(() =>
      validateVerifierPortResult({ ...state, acceptedVersion: "f".repeat(40) }, request, response)
    ).toThrow();
    expect(() =>
      validateVerifierPortResult(
        state,
        { ...request, candidate: { ...candidate, candidateHash: hashJson("wrong") } },
        response
      )
    ).toThrow();
    expect(sync.state).toBe(state);
  });
  test("publisher requires durable modern acceptance and rejects fake success", async () => {
    const { sync, lease } = setup();
    await sync.ports.workspace.freezeInput(lease, "freeze");
    const before = sync.state;
    const response = await sync.ports.publisher.finish(lease, "publish");
    const after = sync.state;
    expect(() => validatePublisherPortResult(before, lease, "publish", response, before)).toThrow();
    expect(() => validatePublisherPortResult(before, lease, "different", response, after)).toThrow();
    expect(() =>
      validatePublisherPortResult(
        before,
        lease,
        "publish",
        { ...response, receipt: { ...response.receipt, candidateHash: hashJson("wrong") } },
        after
      )
    ).toThrow();
    expect(sync.state).toBe(after);
  });
  test("publication validation follows concurrent accepted history and historical replay", async () => {
    const { sync, lease } = setup();
    const b = reserveBuildScope(
      sync.state,
      {
        taskId: "T-B1",
        workerId: "member-b",
        requestId: "reserve-b",
        ownerEpoch: 1
      },
      1000,
      () => ({ attemptId: "attempt-b", token: "token-b" })
    );
    if (b.result.kind !== "granted") throw new Error("expected B lease");
    sync.save(b.state);
    const leaseB = b.result.lease;
    await sync.ports.workspace.freezeInput(lease, "freeze-a");
    await sync.ports.workspace.freezeInput(leaseB, "freeze-b");
    const beforeBoth = sync.state;
    const a = await sync.ports.publisher.finish(lease, "publish-a");
    const second = await sync.ports.publisher.finish(leaseB, "publish-b");
    expect(validatePublisherPortResult(beforeBoth, leaseB, "publish-b", second, sync.state)).toEqual(second);
    expect(validatePublisherPortResult(beforeBoth, lease, "publish-a", a, sync.state)).toEqual(a);
    expect(await sync.ports.publisher.finish(lease, "publish-a")).toEqual(a);
  });
});
