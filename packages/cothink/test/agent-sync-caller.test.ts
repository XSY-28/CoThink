import { expect, it } from "vitest";
import type { AgentSyncProject, AgentSyncStatus } from "@onevcat/argue/agent-sync/project";
import type { CallerOptions, TaskContext } from "../src/agent-sync/types.js";
import { runSyncCaller } from "../src/agent-sync/caller.js";
const project = {
  tasks: [
    { taskId: "a", workerId: "one", scope: { read: [], write: ["x.ts"] }, dependsOn: [], checkProfileId: "test" },
    { taskId: "b", workerId: "two", scope: { read: [], write: ["x.ts"] }, dependsOn: [], checkProfileId: "test" }
  ]
} as unknown as AgentSyncProject;
const profile = {
  protocol: "openai-compatible",
  baseUrl: "http://localhost",
  modelId: "local",
  apiKeyEnv: "KEY",
  outputMode: "json_object" as const,
  generationOptions: {},
  maxInputCharacters: 10000
};
function fixture(maxCalls = 2, waits = true) {
  const completed = new Set<string>(),
    events: Record<string, unknown>[] = [],
    observations: string[] = [];
  let reads = 0,
    calls = 0;
  const context = (id: string): TaskContext => ({
    freezeInput: async () => ({
      baseVersion: id === "b" ? "latest" : "base",
      inputHash: "hash",
      contentHashes: { "x.ts": null }
    }),
    read: async () => {
      reads++;
      return { path: "x.ts", text: null, contentHash: null, baseVersion: id === "b" ? "latest" : "base" };
    },
    runAction: async () => {
      completed.add(id);
      observations.push("accepted-" + id);
      return { status: "accepted", receipt: { acceptedVersion: "version-" + id, checkReceiptId: "check" } };
    }
  });
  const options: CallerOptions = {
    project,
    instructions: { a: "first", b: "second" },
    profiles: { one: profile, two: profile },
    clients: Object.fromEntries(
      ["one", "two"].map((worker, i) => [
        worker,
        {
          call: async () => ({ result: {} }),
          requestScope: async () => {
            const id = i ? "b" : "a";
            return waits && i && !completed.has("a")
              ? { result: { kind: "waiting" } }
              : { result: { kind: "granted" }, task: context(id) };
          }
        }
      ])
    ),
    transport: {
      respond: async (call) => {
        calls++;
        const input = JSON.parse(call.messages[1]!.content);
        observations.push("model-" + input.task.taskId);
        if (input.task.taskId === "b") expect(input.input.baseVersion).toBe("latest");
        return {
          modelId: "local",
          protocol: "openai-compatible",
          generationOptions: {},
          usage: {},
          finishReason: "stop",
          rawContent: JSON.stringify({
            actionVersion: "cothink-sync-action-v1",
            requestId: input.requestId,
            action: { kind: "finish" }
          }),
          payload: {}
        };
      }
    },
    budget: {
      maxCalls,
      maxOutputTokensPerCall: 64,
      maxAllocatedOutputTokens: 128,
      maxDurationMs: 1000,
      callTimeoutMs: 100
    },
    deadlineAt: Date.now() + 1000,
    usedCalls: 0,
    signal: new AbortController().signal,
    record: (e) => {
      events.push(e);
    },
    status: async () =>
      ({ tasks: [...completed].map((taskId) => ({ taskId, status: "completed" })) }) as AgentSyncStatus
  };
  return { options, events, observations, counts: () => ({ calls, reads }) };
}
it("waits with zero model calls and freezes the latest input after the conflicting task finishes", async () => {
  const f = fixture();
  await runSyncCaller(f.options);
  expect(f.observations).toEqual(["model-a", "accepted-a", "model-b", "accepted-b"]);
  expect(f.events.some((e) => e.event === "waiting")).toBe(true);
  expect(f.counts()).toEqual({ calls: 2, reads: 2 });
});
it("shares budget across tasks and keeps unknown prior dispatches charged", async () => {
  const f = fixture(1);
  f.options.usedCalls = 1;
  await expect(runSyncCaller(f.options)).rejects.toThrow("SYNC_BUDGET_EXHAUSTED");
  expect(f.counts().calls).toBe(0);
});
it("never applies late model output after cancellation, even if transport ignores abort", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.transport.respond = async () => {
    controller.abort();
    return {
      modelId: "local",
      protocol: "openai-compatible",
      generationOptions: {},
      usage: {},
      finishReason: "stop",
      rawContent: "{}",
      payload: {}
    };
  };
  await expect(runSyncCaller(f.options)).rejects.toThrow();
  expect(f.observations).toEqual([]);
});
it("stops before dispatch if the durable reservation cannot be saved", async () => {
  const f = fixture();
  f.options.record = (e) => {
    if (e.event === "call-reserved") throw Error("disk unavailable");
  };
  await expect(runSyncCaller(f.options)).rejects.toThrow("disk unavailable");
  expect(f.counts().calls).toBe(0);
});
it("bounds a transport which never settles", async () => {
  const f = fixture();
  f.options.budget.callTimeoutMs = 10;
  f.options.transport.respond = async () => new Promise(() => {});
  await expect(runSyncCaller(f.options)).rejects.toThrow("SYNC_MODEL_ABORTED");
  expect(f.observations).toEqual([]);
});
it("ends at the caller deadline even if a tool status RPC never responds", async () => {
  const f = fixture();
  f.options.status = async () => new Promise(() => {});
  f.options.deadlineAt = Date.now() + 10;
  const finished = runSyncCaller(f.options).then(
    () => true,
    () => true
  );
  expect(await Promise.race([finished, new Promise((resolve) => setTimeout(() => resolve(false), 80))])).toBe(true);
  expect(f.counts().calls).toBe(0);
});

it("reserves one shared budget atomically when independent tasks dispatch together", async () => {
  const f = fixture(1, false);
  await expect(runSyncCaller(f.options)).rejects.toThrow("SYNC_BUDGET_EXHAUSTED");
  expect(f.counts().calls).toBe(1);
  expect(f.events.filter((e) => e.event === "call-reserved")).toHaveLength(1);
});
