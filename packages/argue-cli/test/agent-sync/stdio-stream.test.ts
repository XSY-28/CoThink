import { test, expect } from "vitest";
import { PassThrough } from "node:stream";
import { serve } from "../../../../tools/agent-sync/server.mjs";
import { WIRE_VERSION, readJsonLines } from "../../../../tools/agent-sync/protocol.mjs";
const deferred = () => {
  let resolve!: (v?: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test("line reader preserves split UTF8 and refuses malformed bytes", async () => {
  const input = new PassThrough(),
    messages: unknown[] = [],
    errors: { code: string }[] = [];
  const done = readJsonLines(
    input,
    (m: unknown) => messages.push(m),
    (e: { code: string }) => errors.push(e)
  );
  const bytes = Buffer.from('{"text":"金额"}\n');
  input.write(bytes.subarray(0, 11));
  input.write(bytes.subarray(11));
  input.write(Buffer.from([0xff, 10]));
  input.end();
  await done;
  expect(messages).toEqual([{ text: "金额" }]);
  expect(errors).toEqual([expect.objectContaining({ code: "wire_invalid_frame" })]);
});
test("busy check permits status/cancel and close ACK waits for writer release (transport double only)", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    entered = deferred(),
    release = deferred();
  const lease = {
    projectKey: "project",
    runId: "run",
    planHash: "sha256:" + "1".repeat(64),
    taskId: "task",
    workerId: "alice",
    attemptId: "attempt",
    ownerEpoch: 1,
    leaseEpoch: 1,
    token: "SECRET"
  };
  const worker = {
    requestScope: async () => ({ kind: "granted", lease }),
    seal: async () => ({ kind: "sealed" }),
    check: async () => {
      entered.resolve();
      await release.promise;
      return { receipt: { passed: true } };
    },
    cancel: async () => ({ kind: "cancelled" })
  };
  const service = { forWorker: () => worker, status: async () => ({ status: "active" }), close() {} };
  const server = serve({ service, bindings: { a: { workerId: "alice" }, admin: { role: "host" } }, input, output });
  type Frame = {
    routeId: string;
    ok: boolean;
    result: { kind?: string; writerReleased?: boolean };
    capability?: string;
    error?: { code: string };
    timing: { queueMs: number; toolMs: number };
  };
  const replies = new Map<string, (v: Frame) => void>();
  const reader = readJsonLines(
    output,
    (m: Frame) => {
      replies.get(m.routeId)?.(m);
    },
    () => {}
  );
  function call(routeId: string, method: string, params = {}, connectionId = "a") {
    const promise = new Promise<Frame>((r) => replies.set(routeId, r));
    input.write(
      JSON.stringify({
        routeId,
        connectionId,
        request: { protocolVersion: WIRE_VERSION, requestId: routeId, method, params }
      }) + "\n"
    );
    return promise;
  }
  const refused = await call("forbidden", "recover", {});
  expect(refused.error!.code).toBe("wire_forbidden");
  expect(refused.timing.queueMs).toBeGreaterThanOrEqual(0);
  expect(refused.timing.toolMs).toBeGreaterThanOrEqual(0);
  const grant = await call("scope", "requestScope", { taskId: "task" }),
    p = { taskId: "task", capability: grant.capability };
  await call("seal", "seal", p);
  const pending = call("checking", "check", p);
  await entered.promise;
  expect((await call("status", "status")).ok).toBe(true);
  expect((await call("cancel", "cancel", { taskId: "task" })).result.kind).toBe("cancelled");
  release.resolve();
  await pending;
  const close = call("closing", "close", {}, "admin");
  await server.closeRequested;
  let acknowledged = false;
  void close.then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  server.markWriterReleased();
  expect((await close).result.writerReleased).toBe(true);
  await server.drain();
  output.end();
  await reader;
});
