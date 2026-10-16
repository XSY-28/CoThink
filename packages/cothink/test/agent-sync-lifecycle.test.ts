import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { freezeAgentSyncProject } from "@onevcat/argue/agent-sync/project";
import { runCoThink } from "../src/index.js";
import type { ModelTransport } from "@onevcat/argue";
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cothink-sync-lifecycle-")));
  for (const name of ["source", "managed"]) await mkdir(join(dir, name));
  const hash = "sha256:" + "a".repeat(64);
  const project = freezeAgentSyncProject({
    projectVersion: "agent-sync-project-v1",
    projectKey: "test",
    memberIds: ["worker"],
    manifest: [{ path: "x.ts", access: "writable", contentHash: null }],
    tasks: [
      { taskId: "one", workerId: "worker", scope: { read: [], write: ["x.ts"] }, dependsOn: [], checkProfileId: "test" }
    ],
    profiles: [{ profileId: "test", checkIds: ["test"] }],
    finalProfileId: "test",
    checkConfigurationHash: hash
  });
  await writeFile(
    join(dir, "job.json"),
    JSON.stringify({
      options: { project, runId: "run", workspaceRoot: join(dir, "managed"), sourceRoot: join(dir, "source") },
      connections: { admin: { role: "host" }, worker: { workerId: "worker" } }
    })
  );
  await writeFile(
    join(dir, "integration.json"),
    JSON.stringify({
      integrationVersion: "cothink-agent-sync-v1",
      toolEntry: fileURLToPath(new URL("./fixtures/agent-sync-tool.mjs", import.meta.url)),
      jobFile: join(dir, "job.json"),
      members: { worker: "member-a" },
      instructions: { one: "Implement a file" },
      budget: {
        maxCalls: 2,
        maxOutputTokensPerCall: 128,
        maxAllocatedOutputTokens: 256,
        maxDurationMs: 30000,
        callTimeoutMs: 1000
      }
    })
  );
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      configVersion: 2,
      members: Object.fromEntries(
        ["a", "b"].map((x) => [
          "member-" + x,
          {
            protocol: "openai-compatible",
            baseUrl: "http://127.0.0.1:1/v1",
            modelId: x,
            apiKeyEnv: "TEST_KEY",
            outputMode: "json_object"
          }
        ])
      )
    })
  );
  const root = join(dir, "caller"),
    logs: string[] = [],
    errors: string[] = [];
  const transport: ModelTransport = {
    respond: async (call) => {
      const input = JSON.parse(call.messages[1]!.content);
      return {
        protocol: call.protocol,
        modelId: call.modelId,
        generationOptions: {},
        usage: {},
        finishReason: "stop",
        payload: {},
        rawContent: JSON.stringify({
          actionVersion: input.actionVersion,
          requestId: input.requestId,
          action: { kind: "finish" }
        })
      };
    }
  };
  const invoke = (args: string[], override: ModelTransport | undefined = transport) =>
    runCoThink(
      ["build", "sync", ...args],
      { log: (s) => logs.push(s), error: (s) => errors.push(s) },
      { env: {}, transport: override }
    );
  const start = [
    "start",
    "--integration",
    join(dir, "integration.json"),
    "--approve-plan",
    project.planHash,
    "--config",
    join(dir, "models.json"),
    "--root",
    root
  ];
  const result = async () => JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  return { dir, root, logs, errors, transport, invoke, start, result };
}
it("recovers with zero model calls and resumes with the original journal, profile and deadline", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const bad: ModelTransport = {
      respond: async (call) => {
        calls++;
        return { ...(await f.transport.respond(call, new AbortController().signal)), rawContent: "{}" };
      }
    };
    expect((await f.invoke(f.start, bad)).code).toBe(1);
    const before = await f.result();
    expect(before.usedCalls).toBe(1);
    expect(before.status).toBe("paused");
    expect((await f.invoke(["resume", "--root", f.root])).code).toBe(1);
    expect(f.errors).toContain("SYNC_RECOVERY_REQUIRED");
    const never: ModelTransport = {
      respond: async () => {
        calls++;
        throw Error("unexpected recovery model call");
      }
    };
    expect((await f.invoke(["recover", "--root", f.root], never)).code).toBe(0);
    expect(calls).toBe(1);
    const recovered = await f.result();
    expect(recovered.usedCalls).toBe(1);
    expect(recovered.replayedActions).toBe(0);
    expect((await f.invoke(["resume", "--root", f.root])).code).toBe(0);
    const after = await f.result();
    expect(after.status).toBe("completed");
    expect(after.usedCalls).toBe(2);
    expect(after.deadlineAt).toBe(before.deadlineAt);
    expect((await f.invoke(f.start)).code).toBe(1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
it("active cancel requests revoke through the owning tool before reporting acknowledgement", async () => {
  const f = await fixture();
  try {
    let arrived!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending: ModelTransport = {
      respond: async () => {
        arrived();
        return new Promise(() => {});
      }
    };
    const running = f.invoke(f.start, pending);
    await dispatch;
    expect((await f.invoke(["recover", "--root", f.root])).code).toBe(1);
    expect(f.errors).toContain("SYNC_CALLER_BUSY");
    expect((await f.invoke(["cancel", "--root", f.root])).code).toBe(0);
    expect(JSON.parse(f.logs.at(-1)!)).toMatchObject({ status: "cancel-requested", acknowledged: false });
    expect((await running).code).toBe(0);
    expect(await f.result()).toMatchObject({ status: "cancelled", writerReleased: true, usedCalls: 1 });
    const operations = await readFile(join(f.dir, "managed/fixture-operations.jsonl"), "utf8");
    expect(operations).toContain('"method":"cancel"');
    expect(operations).not.toContain('"method":"finish"');
    expect((await f.invoke(["resume", "--root", f.root])).code).toBe(1);
    expect(f.errors).toContain("SYNC_RUN_CANCELLED");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
