import { describe, test, expect } from "vitest";
import { createDispatcher, WIRE_VERSION, publicResult } from "../../../../tools/agent-sync/protocol.mjs";
const bindings = { admin: { role: "host" }, a: { workerId: "alice" }, b: { workerId: "bob" } };
const lease = (epoch = 1) => ({
  projectKey: "project",
  runId: "run",
  planHash: "sha256:" + "1".repeat(64),
  taskId: "change",
  workerId: "alice",
  attemptId: "attempt-" + epoch,
  ownerEpoch: 1,
  leaseEpoch: epoch,
  token: "PRIVATE_LEASE_SENTINEL_" + epoch
});
function fixture() {
  let epoch = 1,
    checks = 0,
    calls = 0,
    invalidBasis = false;
  const worker = {
    requestScope: async () => ({ kind: "granted", lease: lease(epoch) }),
    currentLease: async () => lease(epoch),
    read: async (l: ReturnType<typeof lease>) => {
      calls++;
      if (l.leaseEpoch !== epoch) throw Object.assign(new Error("PRIVATE_DIAGNOSTIC"), { code: "attempt_invalidated" });
      return { text: "hello" };
    },
    seal: async () => ({ kind: "sealed", version: "1".repeat(40) }),
    check: async () => {
      checks++;
      if (invalidBasis) throw Object.assign(new Error("PRIVATE_DIAGNOSTIC"), { code: "port_rejected" });
      return { receipt: { passed: true } };
    },
    release: async () => {
      epoch++;
      return { kind: "released" };
    }
  };
  const service = {
    forWorker: (id: string) => {
      expect(id).toBe("alice");
      return worker;
    },
    status: async () => ({ status: "active" }),
    close: () => {}
  };
  const dispatcher = createDispatcher({
    service,
    bindings,
    loadState: async () => {
      throw Error("no durable success");
    }
  });
  const request = (requestId: string, method: string, params = {}) => ({
    protocolVersion: WIRE_VERSION,
    requestId,
    method,
    params
  });
  const call = (id: string, method: string, params = {}, connection = "a") =>
    dispatcher.dispatch(connection, request(id, method, params));
  return {
    dispatcher,
    call,
    request,
    checks: () => checks,
    calls: () => calls,
    invalidate: () => {
      invalidBasis = true;
    }
  };
}
describe("thin wire dispatch (pure transport tests; no isolation claim)", () => {
  test("strict version, role, and unknown identity fields reject before service calls", async () => {
    const f = fixture();
    await expect(
      f.dispatcher.dispatch("a", { ...f.request("bad-v", "status"), protocolVersion: "old" })
    ).rejects.toMatchObject({ code: "wire_version" });
    await expect(f.call("bad-body", "read", { taskId: "change", lease: lease() })).rejects.toMatchObject({
      code: "wire_invalid_request"
    });
    await expect(f.call("not-admin", "recover", {})).rejects.toMatchObject({ code: "wire_forbidden" });
    await expect(f.call("bad-connection", "status", {}, "unknown")).rejects.toMatchObject({
      code: "wire_unknown_connection"
    });
    expect(f.calls()).toBe(0);
  });
  test("captures grant lease and never lets a stale context adopt a renewed lease", async () => {
    const f = fixture(),
      first = await f.call("scope1", "requestScope", { taskId: "change" });
    expect(JSON.stringify(first)).not.toContain("PRIVATE_LEASE_SENTINEL");
    const cap = first.capability;
    await f.call("release", "release", { taskId: "change", capability: cap });
    const second = await f.call("scope2", "requestScope", { taskId: "change" });
    expect(second.capability).not.toBe(cap);
    await expect(
      f.call("stale", "read", { taskId: "change", capability: cap, path: "lib/value.ts" })
    ).rejects.toMatchObject({ code: "attempt_invalidated" });
  });
  test("same ID changed context refuses; settled checks reenter core and its live evidence guard", async () => {
    const f = fixture(),
      grant = await f.call("scope", "requestScope", { taskId: "change" });
    const p = { taskId: "change", capability: grant.capability };
    await f.call("seal", "seal", p);
    await f.call("check", "check", p);
    f.invalidate();
    await expect(f.call("check", "check", p)).rejects.toMatchObject({ code: "port_rejected" });
    expect(f.checks()).toBe(2);
    await expect(f.call("check", "read", { ...p, path: "lib/value.ts" })).rejects.toMatchObject({
      code: "request_id_conflict"
    });
  });
});

test("replayed scope receipts do not expose a nested lease token", async () => {
  const dispatcher = createDispatcher({
    service: {
      forWorker: () => ({
        requestScope: async () => ({ kind: "replayed", receipt: { result: { kind: "granted", lease: lease() } } })
      }),
      close() {}
    },
    bindings
  });
  const reply = await dispatcher.dispatch("a", {
    protocolVersion: WIRE_VERSION,
    requestId: "repeat",
    method: "requestScope",
    params: { taskId: "change" }
  });
  expect(JSON.stringify(reply)).not.toContain("PRIVATE_LEASE_SENTINEL");
  expect(reply.capability).toBeDefined();
});

test("redaction preserves exact file-map keys named token or lease", () => {
  const value = {
    contentHashes: { token: "sha256:" + "2".repeat(64), lease: "sha256:" + "3".repeat(64) },
    text: "literal token text"
  };
  expect(publicResult(value)).toEqual(value);
});
