import { describe, expect, test } from "vitest";
import { BuildDriver, type BuildDriverEvent, type BuildModelProfile } from "../../src/build/driver.js";
import { reserveBuildCall } from "../../src/build/budget.js";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import { createBuildState } from "../../src/build/state.js";
import { reserveBuildScope } from "../../src/build/scope.js";
import {
  ModelTransportFailure,
  type ModelCall,
  type ModelReply,
  type ModelTransport
} from "../../src/transport/contracts.js";
import { MemoryBuildSync } from "./sync-port-fixture.js";
import { planInput, runInput } from "./fixtures.js";

function barrier<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Boundary barrier timed out")), 1500);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const models: Readonly<Record<string, BuildModelProfile>> = Object.fromEntries(
  ["member-a", "member-b"].map((id) => [
    id,
    {
      protocol: "controlled",
      baseUrl: "http://unused.invalid",
      modelId: id,
      apiKeyEnv: "UNUSED_KEY",
      outputMode: "json_object",
      generationOptions: {}
    }
  ])
);
function setup(limits: Record<string, number> = {}, clock = () => 1000) {
  const definition = planInput();
  definition.tasks = [definition.tasks[0]!];
  Object.assign(definition.budget, limits);
  const plan = freezeBuildPlan(definition);
  const h = new MemoryBuildSync(
    createBuildState({ ...runInput(), plan, deadlineAt: 1000 + plan.budget.runTimeoutMs }),
    { "SPEC.md": "spec", "src/normalize.ts": "v0", "src/report.ts": "total" },
    clock
  );
  let sequence = 0;
  return {
    h,
    writer: h.writer,
    ports: h.ports,
    models,
    clock,
    nextId: (kind: string) => `${kind}-${++sequence}`,
    allocateLease: () => ({ attemptId: `attempt-${++sequence}`, token: `host-token-${sequence}` })
  };
}
function request(call: ModelCall) {
  return JSON.parse(call.messages.find((m) => m.role === "user")!.content);
}
function response(call: ModelCall, action: unknown): ModelReply {
  const payload = { actionVersion: "build-action-v1", requestId: request(call).requestId, action };
  return {
    rawContent: JSON.stringify(payload),
    payload,
    modelId: call.modelId,
    protocol: call.protocol,
    generationOptions: {},
    usage: { outputTokens: 1 },
    finishReason: "stop"
  };
}
function edit(call: ModelCall) {
  const file = request(call).input.files.find((file: { path: string }) => file.path === "src/normalize.ts");
  return { kind: "edit", path: file.path, text: "late write", expectedContentHash: file.contentHash };
}
function noEffects(h: MemoryBuildSync) {
  expect(h.state.acceptedVersion).toBe("a".repeat(40));
  expect(h.state.acceptedTasks).toEqual([]);
  expect(h.state.publishReceipts).toEqual([]);
  expect(h.state.workspace?.staging ?? []).toEqual([]);
}
async function abandoned(t: ReturnType<typeof setup>) {
  const grant = reserveBuildScope(
    t.h.state,
    { ownerEpoch: 1, workerId: "member-a", taskId: "T-A", requestId: "old-grant" },
    1000,
    () => ({ attemptId: "old-attempt", token: "old-host-token" })
  );
  if (grant.result.kind !== "granted") throw new Error("Expected grant");
  t.h.save(grant.state);
  await t.ports.workspace.freezeInput(grant.result.lease, "old-freeze");
  t.h.save(reserveBuildCall(t.h.state, grant.result.lease, "old-call", 1000).state);
  return grant.result.lease;
}

describe("driver recovery and finite cost boundaries", () => {
  test("unknown transport is charged once and cannot automatically ask again", async () => {
    const t = setup();
    let calls = 0;
    const transport: ModelTransport = {
      async respond() {
        calls++;
        throw new ModelTransportFailure({ code: "network_error", message: "connection lost", retryable: true });
      }
    };
    const result = await bounded(new BuildDriver({ ...t, transport }).run());
    expect(calls).toBe(1);
    expect(result.status).toBe("incomplete");
    expect(result.budget).toMatchObject({ calls: 1, allocatedOutputTokens: 4096 });
    expect(t.h.state.calls.map((call) => call.status)).toEqual(["unknown"]);
    expect(t.h.state.attempts[0]!.status).toBe("paused");
    expect(t.h.state.coordination.locks).toEqual([]);
    noEffects(t.h);
  });
  test("first retry recovers an abandoned reserved call without invoking models or tools", async () => {
    const t = setup();
    await abandoned(t);
    const toolReceipts = t.h.state.workspace!.toolReceipts;
    let calls = 0;
    const transport: ModelTransport = {
      async respond(call) {
        calls++;
        return response(call, { kind: "finish" });
      }
    };
    const driver = new BuildDriver({ ...t, transport });
    const initial = await bounded(driver.retry());
    expect(initial.status).toBe("incomplete");
    expect(calls).toBe(0);
    expect(t.h.state.ownerEpoch).toBe(2);
    expect(t.h.state.calls[0]!.status).toBe("unknown");
    expect(t.h.state.calls[0]!.allocatedOutputTokens).toBe(4096);
    expect(t.h.state.attempts[0]!.status).toBe("paused");
    expect(t.h.state.workspace!.toolReceipts).toEqual(toolReceipts);
    expect(t.h.state.coordination.locks).toEqual([]);
    expect((await bounded(driver.retry())).status).toBe("completed");
    expect(calls).toBe(1);
    expect(t.h.state.calls.map((call) => call.status)).toEqual(["unknown", "succeeded"]);
  });
  test("run on host-exit history requests recovery and preserves the unobserved reservation", async () => {
    const t = setup();
    await abandoned(t);
    const before = t.h.state;
    let calls = 0;
    const transport: ModelTransport = {
      async respond(call) {
        calls++;
        return response(call, { kind: "finish" });
      }
    };
    const result = await bounded(new BuildDriver({ ...t, transport }).run());
    expect(calls).toBe(0);
    expect(t.h.state).toEqual(before);
    expect(result.tasks[0]!.reason).toBe("recovery_required");
    expect(t.h.state.calls[0]!.status).toBe("reserved");
  });
  test("recovering exhausted history cannot refund a call or dispatch on explicit retry", async () => {
    const t = setup({
      maxCalls: 1,
      maxCallsPerTask: 1,
      maxOutputTokensPerCall: 4,
      maxAllocatedOutputTokensPerTask: 4,
      maxAllocatedOutputTokens: 4
    });
    await abandoned(t);
    let calls = 0;
    const transport: ModelTransport = {
      async respond(call) {
        calls++;
        return response(call, { kind: "finish" });
      }
    };
    const driver = new BuildDriver({ ...t, transport });
    await bounded(driver.retry());
    const result = await bounded(driver.retry());
    expect(calls).toBe(0);
    expect(result.status).toBe("incomplete");
    expect(result.tasks[0]!.reason).toBe("budget_exhausted");
    expect(result.budget).toEqual({ calls: 1, allocatedOutputTokens: 4, maxCalls: 1, maxAllocatedOutputTokens: 4 });
    expect(t.h.state.calls.map((call) => call.status)).toEqual(["unknown"]);
    noEffects(t.h);
  });
});

describe("driver response authorization boundaries", () => {
  test.each(["wrong-request", "forged-identity", "out-of-scope", "forged-check"])(
    "%s reply cannot edit or publish",
    async (kind) => {
      const t = setup();
      let calls = 0;
      const transport: ModelTransport = {
        async respond(call) {
          calls++;
          const valid = response(
            call,
            kind === "out-of-scope"
              ? { ...edit(call), path: "src/report.ts" }
              : kind === "forged-check"
                ? { kind: "check", passed: true, receiptId: "invented" }
                : edit(call)
          );
          const body = JSON.parse(valid.rawContent);
          if (kind === "wrong-request") body.requestId = "another-request";
          if (kind === "forged-identity") {
            body.workerId = "member-b";
            body.token = "forged";
          }
          return { ...valid, rawContent: JSON.stringify(body) };
        }
      };
      const result = await bounded(new BuildDriver({ ...t, transport }).run());
      expect(calls).toBe(1);
      expect(result.status).toBe("incomplete");
      expect(t.h.state.calls[0]!.status).toBe("failed");
      expect(t.h.state.checkReceipts).toEqual([]);
      expect(t.h.state.coordination.locks).toEqual([]);
      noEffects(t.h);
    }
  );
  test("a plan replaced while a response is pending invalidates the old edit", async () => {
    const t = setup();
    const started = barrier<ModelCall>();
    const finish = barrier<ModelReply>();
    const transport: ModelTransport = {
      respond(call) {
        started.resolve(call);
        return finish.promise;
      }
    };
    const driver = new BuildDriver({ ...t, transport });
    const running = driver.run();
    const call = await bounded(started.promise);
    const replacement = planInput();
    replacement.tasks = [replacement.tasks[0]!];
    replacement.budget.maxCalls = 35;
    // A host-approved replacement has its own internally valid authority state.
    const replacementState = createBuildState({
      ...runInput(),
      plan: freezeBuildPlan(replacement),
      revision: t.h.state.revision + 1
    });
    t.h.save(replacementState);
    finish.resolve(response(call, edit(call)));
    await expect(bounded(running)).rejects.toThrow(/plan changed/i);
    noEffects(t.h);
    expect(t.h.state).toEqual(replacementState);
  });
});

describe("real timer and late response boundaries", () => {
  test("real call timeout returns without waiting for an ignoring transport, and its late edit has no effects", async () => {
    const t = setup({ callTimeoutMs: 10 });
    const started = barrier<ModelCall>();
    const finish = barrier<ModelReply>();
    const late = barrier();
    let calls = 0;
    const transport: ModelTransport = {
      respond(call) {
        calls++;
        started.resolve(call);
        return finish.promise;
      }
    };
    const driver = new BuildDriver({
      ...t,
      transport,
      onEvent(event: BuildDriverEvent) {
        if (event.type === "model_late") late.resolve();
      }
    });
    const running = driver.run();
    const call = await bounded(started.promise);
    const result = await bounded(running);
    expect(result.status).toBe("incomplete");
    expect(calls).toBe(1);
    expect(t.h.state.calls[0]!.status).toBe("unknown");
    noEffects(t.h);
    const beforeLate = t.h.state;
    finish.resolve(response(call, edit(call)));
    await bounded(late.promise);
    expect(t.h.state).toEqual(beforeLate);
    noEffects(t.h);
  });
  test("cancellation while transport ignores abort prevents a late edit and preserves its allocation", async () => {
    const t = setup();
    const started = barrier<ModelCall>();
    const finish = barrier<ModelReply>();
    const late = barrier();
    const transport: ModelTransport = {
      respond(call) {
        started.resolve(call);
        return finish.promise;
      }
    };
    const driver = new BuildDriver({
      ...t,
      transport,
      onEvent(event: BuildDriverEvent) {
        if (event.type === "model_late") late.resolve();
      }
    });
    const running = driver.run();
    const call = await bounded(started.promise);
    expect((await bounded(driver.cancel())).status).toBe("cancelled");
    expect((await bounded(running)).status).toBe("cancelled");
    expect(t.h.state.calls[0]!.allocatedOutputTokens).toBe(4096);
    expect(t.h.state.calls[0]!.status).toBe("unknown");
    const beforeLate = t.h.state;
    finish.resolve(response(call, edit(call)));
    await bounded(late.promise);
    expect(t.h.state).toEqual(beforeLate);
    expect(t.h.state.coordination.locks).toEqual([]);
    noEffects(t.h);
  });
  test("a reply at its call deadline cannot execute when the timeout callback has not run yet", async () => {
    let now = 1000;
    const t = setup({ callTimeoutMs: 10 }, () => now);
    let calls = 0;
    const transport: ModelTransport = {
      async respond(call) {
        calls++;
        // A fulfilled provider promise can win a race before a due timer receives a turn.
        // The injected clock makes the exact deadline boundary deterministic.
        now = t.h.state.calls[t.h.state.calls.length - 1]!.deadlineAt;
        return response(call, edit(call));
      }
    };
    const result = await bounded(new BuildDriver({ ...t, transport }).run());
    expect(calls).toBe(1);
    expect(result.status).toBe("incomplete");
    expect(t.h.state.calls[0]!.status).toBe("unknown");
    noEffects(t.h);
  });
  test("an immediate reply yields to a real deadline event before its edit can execute", async () => {
    let now = 1000;
    const t = setup({}, () => now);
    const fired = barrier();
    let calls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transport: ModelTransport = {
      async respond(call) {
        calls++;
        return response(call, edit(call));
      }
    };
    const driver = new BuildDriver({
      ...t,
      transport,
      onEvent(event: BuildDriverEvent) {
        if (event.type === "model_finished")
          timer = setTimeout(() => {
            now = t.h.state.attempts[0]!.deadlineAt;
            fired.resolve();
          }, 0);
      }
    });
    try {
      const result = await bounded(driver.run());
      await bounded(fired.promise);
      expect(calls).toBe(1);
      expect(result.status).toBe("incomplete");
      expect(t.h.state.attempts[0]!.status).toBe("paused");
      expect(t.h.state.coordination.locks).toEqual([]);
      noEffects(t.h);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
});

test("external owner replacement aborts sibling requests without touching replacement authority", async () => {
  const definition = planInput();
  definition.tasks = definition.tasks.slice(0, 2);
  const plan = freezeBuildPlan(definition);
  const h = new MemoryBuildSync(createBuildState({ ...runInput(), plan }), {
    "SPEC.md": "spec",
    "src/normalize.ts": "v0",
    "src/report.ts": "total"
  });
  const both = barrier(),
    late = barrier();
  const finish = barrier<ModelReply>();
  let entered = 0;
  let sibling: AbortSignal | undefined;
  const transport: ModelTransport = {
    async respond(call, signal) {
      if (++entered === 2) both.resolve();
      await both.promise;
      if (request(call).task.taskId === "T-A") {
        const { advanceBuildOwnerEpoch } = await import("../../src/build/state.js");
        await h.writer.transaction(async (state) => ({
          state: advanceBuildOwnerEpoch(state, { ownerEpoch: state.ownerEpoch }, "replacement-owner", 1000).state,
          value: undefined
        }));
        return response(call, { kind: "finish" });
      }
      sibling = signal;
      return finish.promise;
    }
  };
  const driver = new BuildDriver({
    writer: h.writer,
    ports: h.ports,
    models,
    clock: () => 1000,
    transport,
    onEvent: (e) => {
      if (e.type === "model_late") late.resolve();
    }
  });
  try {
    await expect(bounded(driver.run())).rejects.toThrow(/owner changed/i);
    const replacement = h.state;
    expect(sibling?.aborted).toBe(true);
    expect(h.state).toBe(replacement);
    expect(h.state.acceptedTasks).toEqual([]);
  } finally {
    finish.resolve({
      rawContent: "{}",
      payload: null,
      modelId: "member-b",
      protocol: "controlled",
      generationOptions: {},
      usage: {},
      finishReason: "stop"
    });
    if (sibling?.aborted) await bounded(late.promise);
  }
});
