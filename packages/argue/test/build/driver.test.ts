import { expect, test } from "vitest";
import type { ModelCall, ModelReply, ModelTransport } from "../../src/transport/contracts.js";
import { BuildDriver } from "../../src/build/driver.js";
import { createBuildState, parseBuildState, reserveBuildScope } from "../../src/build/index.js";
import { MemoryBuildSync } from "./sync-port-fixture.js";
import { runInput, planInput } from "./fixtures.js";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import type { BuildStateWriter } from "../../src/build/store.js";

const models = Object.fromEntries(
  ["member-a", "member-b"].map((id) => [
    id,
    {
      protocol: "controlled",
      baseUrl: "http://unused.invalid",
      modelId: id,
      apiKeyEnv: "UNUSED_KEY",
      outputMode: "json_object" as const,
      generationOptions: {}
    }
  ])
);
const files = { "SPEC.md": "spec", "src/normalize.ts": "v0", "src/report.ts": "total" };
function harness(single = false) {
  const plan = single ? freezeBuildPlan({ ...planInput(), tasks: [planInput().tasks[0]!] }) : runInput().plan;
  const h = new MemoryBuildSync(createBuildState({ ...runInput(), plan }), files);
  let chain = Promise.resolve();
  const writer: BuildStateWriter = {
    load: async () => h.load(),
    commit: async (rev, s) => {
      if (h.state.revision !== rev) throw Error("CAS");
      h.save(s);
    },
    transaction(fn) {
      const p = chain.then(async () => {
        const cur = await h.load();
        const r = await fn(cur);
        if (r.state) {
          await r.beforeCommit?.(await h.load());
          h.save(r.state);
        }
        return r.value;
      });
      chain = p.then(
        () => {},
        () => {}
      );
      return p;
    }
  };
  let ids = 0;
  const nextId = (kind: string) => `${kind}-${++ids}`;
  return { h, writer, nextId, models, clock: () => 1000 };
}
function payload(call: ModelCall) {
  return JSON.parse(call.messages.find((m) => m.role === "user")!.content);
}
function reply(call: ModelCall, action: unknown): ModelReply {
  const p = payload(call);
  const body = { actionVersion: "build-action-v1", requestId: p.requestId, action };
  return {
    rawContent: JSON.stringify(body),
    payload: body,
    modelId: call.modelId,
    protocol: call.protocol,
    generationOptions: {},
    usage: { outputTokens: 20 },
    finishReason: "stop"
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("driver keeps B2 waiting, overlaps actual controlled requests and finishes through replaceable memory ports", async () => {
  const t = harness();
  const gate = deferred();
  let active = 0,
    max = 0;
  const steps: Record<string, number> = {};
  const seen: unknown[] = [];
  const events: { type: string; taskId?: string }[] = [];
  const transport: ModelTransport = {
    async respond(call) {
      const p = payload(call);
      seen.push(p);
      expect(Object.isFrozen(call)).toBe(true);
      expect(JSON.stringify(p)).not.toContain("token-");
      const n = (steps[p.task.taskId] = (steps[p.task.taskId] ?? 0) + 1);
      if (n === 1 && p.task.taskId !== "T-B2") {
        active++;
        max = Math.max(max, active);
        if (active === 2) gate.resolve();
        await gate.promise;
        active--;
      }
      if (p.task.taskId === "T-B1")
        expect(p.input.files.map((f: { path: string }) => f.path)).not.toContain("src/normalize.ts");
      return reply(call, n === 1 ? { kind: "inspect", path: p.task.scope.write[0] } : { kind: "finish" });
    }
  };
  const driver = new BuildDriver({
    ...t,
    ports: t.h.ports,
    transport,
    onEvent: (e: { type: string; taskId?: string }) => {
      events.push(e);
    }
  });
  const result = await driver.run({ taskOrder: ["T-A", "T-B2", "T-B1"] });
  expect(result).toMatchObject({ status: "completed" });
  expect(max).toBe(2);
  expect(t.h.state.acceptedTasks).toHaveLength(3);
  expect(t.h.state.calls).toHaveLength(6);
  expect(events.filter((e) => ["scope_granted", "scope_waiting"].includes(e.type)).slice(0, 3)).toEqual(
    [
      { type: "scope_granted", taskId: "T-A" },
      { type: "scope_waiting", taskId: "T-B2" },
      { type: "scope_granted", taskId: "T-B1" }
    ].map((e) => expect.objectContaining(e))
  );
  expect(seen).toHaveLength(6);
}, 10000);

test("malformed model reply is charged, paused, never automatically retried and public result hides provider content", async () => {
  const t = harness(true);
  let calls = 0;
  const transport: ModelTransport = {
    async respond(call) {
      calls++;
      return { ...reply(call, { kind: "finish" }), rawContent: "not JSON SECRET-provider-body" };
    }
  };
  const d = new BuildDriver({ ...t, ports: t.h.ports, transport });
  const result = await d.run();
  expect(calls).toBe(1);
  expect(result).toMatchObject({ status: "incomplete" });
  expect(t.h.state.calls[0]?.status).toBe("failed");
  expect(t.h.state.calls[0]?.allocatedOutputTokens).toBe(4096);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(t.h.state.acceptedTasks).toEqual([]);
});

test("recover is zero-call and invalidates abandoned authority before an explicit retry", async () => {
  const t = harness(true);
  const s = t.h.state;
  const grant = reserveBuildScope(
    s,
    { taskId: "T-A", workerId: "member-a", ownerEpoch: 1, requestId: "reserve-old" },
    1000,
    () => ({ attemptId: "old", token: "old-token" })
  );
  t.h.save(grant.state);
  let calls = 0;
  const transport: ModelTransport = {
    async respond(call) {
      calls++;
      return reply(call, { kind: "finish" });
    }
  };
  const d = new BuildDriver({ ...t, ports: t.h.ports, transport });
  await d.recover();
  expect(calls).toBe(0);
  expect(t.h.state.ownerEpoch).toBe(2);
  expect(t.h.state.attempts[0]?.status).toBe("paused");
  await d.retry();
  expect(calls).toBeGreaterThan(0);
  expect(t.h.state.acceptedTasks).toEqual(["T-A"]);
});

test.each([
  ["older conflicting waiter with no returned grant", ["T-A", "T-B2", "T-B1"]],
  ["older same-worker waiter alongside a returned grant", ["T-B2", "T-B1", "T-A"]]
] as const)("explicit retry dispatches every recovered grant once: %s", async (_name, previousOrder) => {
  const t = harness();
  let oldId = 0;
  for (const taskId of previousOrder) {
    const task = t.h.state.plan.tasks.find((item) => item.taskId === taskId)!;
    t.h.save(
      reserveBuildScope(
        t.h.state,
        { taskId, workerId: task.workerId, ownerEpoch: 1, requestId: `old-reserve-${taskId}` },
        1000,
        () => ({ attemptId: `old-${++oldId}`, token: `old-token-${oldId}` })
      ).state
    );
  }
  expect(t.h.state.waiting.length).toBeGreaterThan(0);
  const dispatched: string[] = [];
  const attempts: string[] = [];
  const d = new BuildDriver({
    ...t,
    ports: t.h.ports,
    transport: {
      async respond(call) {
        const input = payload(call);
        dispatched.push(input.task.taskId);
        return reply(call, { kind: "finish" });
      }
    },
    onEvent(event) {
      if (event.type === "scope_granted") attempts.push(event.attemptId!);
    }
  });
  await d.recover();
  expect(dispatched).toEqual([]);
  expect(t.h.state.attempts.every((attempt) => attempt.status === "paused")).toBe(true);
  const result = await d.retry({ taskOrder: ["T-A", "T-B2", "T-B1"] });
  expect(result.status).toBe("completed");
  expect([...dispatched].sort()).toEqual(["T-A", "T-B1", "T-B2"]);
  expect(new Set(attempts).size).toBe(3);
  expect(attempts).toHaveLength(3);
  expect(t.h.state.calls).toHaveLength(3);
  expect(t.h.state.calls.every((call) => !call.attemptId.startsWith("old-"))).toBe(true);
  expect(t.h.state.acceptedTasks).toHaveLength(3);
  expect(t.h.state.coordination.locks).toEqual([]);
});

test("real cancellation timer gets execution between an immediate model reply and its edit", async () => {
  const t = harness(true);
  let calls = 0;
  let d: BuildDriver;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport: ModelTransport = {
    async respond(call) {
      calls++;
      const p = payload(call);
      const f = p.input.files.find((x: { path: string }) => x.path === "src/normalize.ts");
      return reply(call, { kind: "edit", path: f.path, text: "late", expectedContentHash: f.contentHash });
    }
  };
  d = new BuildDriver({
    ...t,
    ports: t.h.ports,
    transport,
    onEvent: (e: { type: string }) => {
      if (e.type === "model_finished")
        timer = setTimeout(() => {
          void d.cancel();
        }, 0);
    }
  });
  try {
    const r = await d.run();
    expect(r).toMatchObject({ status: "cancelled" });
    expect(calls).toBe(1);
    expect(t.h.state.workspace?.staging ?? []).toEqual([]);
    expect(parseBuildState(t.h.state).coordination.locks).toEqual([]);
  } finally {
    if (timer) clearTimeout(timer);
  }
});
