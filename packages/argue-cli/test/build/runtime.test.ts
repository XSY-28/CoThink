import { fork, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test, expect } from "vitest";
import { mkdtemp, mkdir, cp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  FrozenBuildPlanSchema,
  freezeBuildPlan,
  createBuildState,
  reserveBuildScope,
  type ModelTransport
} from "@onevcat/argue";
import { FileBuildStore } from "../../src/build/file-store.js";
import { Workspace } from "../../src/build/workspace.js";
import { LocalBuildRuntime } from "../../src/build/runtime.js";

// Real disk/Git only; recovery and cancellation need no verifier invocation or model credentials.
test("host runtime's first explicit retry recovers without models, and cancel persists invalidation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-runtime-")));
  try {
    const source = join(root, "input"),
      managed = join(root, "managed");
    await mkdir(managed);
    await cp(resolve("../../examples/todo-stats"), source, { recursive: true });
    const { planHash: _hash, ...raw } = FrozenBuildPlanSchema.parse(
      JSON.parse(await readFile(join(source, "build-plan.json"), "utf8"))
    );
    void _hash;
    const kept = ["SPEC.md", "src/normalize.ts", "src/report.ts"];
    const plan = freezeBuildPlan({
      ...raw,
      manifest: raw.manifest.filter((f) => kept.includes(f.path)),
      tasks: raw.tasks.map((t) => ({
        ...t,
        scope: { read: t.scope.read.filter((p) => kept.includes(p)), write: t.scope.write }
      }))
    });
    const clock = () => 1000;
    const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock });
    let oldVersion = "";
    let oldToken = "";
    await store.withWriter(async (w) => {
      await w.gitFor(plan).initialize();
      oldVersion = await w.git.importSource(source);
      await w.commit(
        -1,
        createBuildState({
          buildSchemaVersion: 1,
          planVersion: "build-plan-v1",
          actionVersion: "build-action-v1",
          budgetVersion: "build-budget-v1",
          checkVersion: "build-check-v1",
          publishVersion: "build-publish-v1",
          resultVersion: "build-result-v1",
          projectKey: plan.projectKey,
          runId: "runtime-recovery",
          revision: 0,
          ownerEpoch: 1,
          plan,
          acceptedVersion: oldVersion,
          status: "active",
          startedAt: 1000,
          deadlineAt: 2701000,
          acceptedTasks: [],
          waiting: [],
          attempts: [],
          calls: [],
          actionReceipts: [],
          checkReceipts: [],
          publishReceipts: []
        })
      );
      const lease = await w.transaction(async (s) => {
        const r = reserveBuildScope(
          s,
          { ownerEpoch: s.ownerEpoch, taskId: "T-A", workerId: "member-a", requestId: "abandoned" },
          1000,
          () => ({ attemptId: "old-attempt", token: "old-token" })
        );
        if (r.result.kind !== "granted") throw Error("not granted");
        return { state: r.state, value: r.result.lease };
      });
      oldToken = lease.token;
      await new Workspace(w, { clock }).freezeInput(lease, "freeze-before-exit");
    });
    let modelCalls = 0;
    const transport: ModelTransport = {
      async respond() {
        modelCalls++;
        throw Error("Recovery must not call models");
      }
    };
    const runtime = new LocalBuildRuntime({
      workspaceRoot: managed,
      plan,
      runId: "runtime-recovery",
      image: `sha256:${"a".repeat(64)}`,
      sourceRoot: source,
      models: {},
      transport,
      clock
    });
    const recovered = await runtime.retry();
    expect(modelCalls).toBe(0);
    expect(recovered.status).toBe("incomplete");
    const state = await store.load();
    expect(state.acceptedVersion).toBe(oldVersion);
    expect(state.attempts[0]?.status).toBe("paused");
    expect(state.coordination.locks).toEqual([]);
    expect(state.ownerEpoch).toBeGreaterThan(1);
    expect(JSON.stringify(recovered)).not.toContain(oldToken);
    const cancelled = await runtime.cancel();
    expect(cancelled.status).toBe("cancelled");
    expect(modelCalls).toBe(0);
    const final = await store.load();
    expect(final.status).toBe("cancelled");
    expect(final.acceptedVersion).toBe(oldVersion);
    expect(final.acceptedTasks).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

test("local runtime initializes real Git V0 and requires a second explicit retry after zero-call recovery", async () => {
  const image = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
  if (!image) {
    console.log(
      "NOT VERIFIED: runtime initial Docker capability gate requires COTHINK_BUILD_VALIDATOR_IMAGE; no host fallback"
    );
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-runtime-start-")));
  try {
    const source = join(root, "input"),
      managed = join(root, "managed");
    await mkdir(managed);
    await cp(resolve("../../examples/todo-stats"), source, { recursive: true });
    const { planHash: _hash, ...raw } = FrozenBuildPlanSchema.parse(
      JSON.parse(await readFile(join(source, "build-plan.json"), "utf8"))
    );
    void _hash;
    const kept = ["SPEC.md", "src/normalize.ts", "src/report.ts"];
    const plan = freezeBuildPlan({
      ...raw,
      manifest: raw.manifest.filter((f) => kept.includes(f.path)),
      tasks: [{ ...raw.tasks[0]!, scope: { read: ["SPEC.md"], write: ["src/normalize.ts"] } }]
    });
    const before = await readFile(join(source, "src/normalize.ts"));
    let calls = 0;
    const transport: ModelTransport = {
      async respond(call) {
        calls++;
        const input = JSON.parse(call.messages.find((m) => m.role === "user")!.content);
        const body = {
          actionVersion: "build-action-v1",
          requestId: input.requestId,
          action: { kind: "abort", reason: "controlled runtime boundary" }
        };
        return {
          rawContent: JSON.stringify(body),
          payload: body,
          modelId: call.modelId,
          protocol: call.protocol,
          generationOptions: {},
          usage: { outputTokens: 1 },
          finishReason: "stop"
        };
      }
    };
    const runtime = new LocalBuildRuntime({
      workspaceRoot: managed,
      sourceRoot: source,
      plan,
      runId: "runtime-initial",
      image,
      transport,
      models: {
        "member-a": {
          protocol: "controlled",
          baseUrl: "https://controlled.invalid",
          modelId: "a",
          apiKeyEnv: "UNUSED_CONTROLLED_KEY",
          outputMode: "json_object",
          generationOptions: {}
        },
        "member-b": {
          protocol: "controlled",
          baseUrl: "https://controlled.invalid",
          modelId: "b",
          apiKeyEnv: "UNUSED_CONTROLLED_KEY",
          outputMode: "json_object",
          generationOptions: {}
        }
      },
      clock: () => 1000
    });
    const result = await runtime.run();
    expect(result.status).toBe("incomplete");
    expect(calls).toBe(1);
    const version = result.acceptedVersion;
    const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock: () => 1000 });
    let state = await store.load();
    expect(state.calls[0]?.status).toBe("succeeded");
    expect(state.acceptedTasks).toEqual([]);
    expect(state.publishReceipts).toEqual([]);
    const first = await runtime.retry();
    expect(first.acceptedVersion).toBe(version);
    expect(calls).toBe(1);
    await runtime.retry();
    expect(calls).toBe(2);
    state = await store.load();
    expect(state.calls).toHaveLength(2);
    expect(state.attempts).toHaveLength(2);
    expect(state.acceptedVersion).toBe(version);
    expect(state.coordination.locks).toEqual([]);
    expect(state.calls.every((c) => c.status === "succeeded")).toBe(true);
    expect(await readFile(join(source, "src/normalize.ts"))).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

test("a killed actual driver host recovers a reserved request as unknown with zero redispatch", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-driver-killed-")));
  let child: ChildProcess | undefined;
  try {
    const source = join(root, "input"),
      managed = join(root, "managed");
    await mkdir(managed);
    await cp(resolve("../../examples/todo-stats"), source, { recursive: true });
    const { planHash: _hash, ...raw } = FrozenBuildPlanSchema.parse(
      JSON.parse(await readFile(join(source, "build-plan.json"), "utf8"))
    );
    void _hash;
    const kept = ["SPEC.md", "src/normalize.ts", "src/report.ts"];
    const plan = freezeBuildPlan({
      ...raw,
      manifest: raw.manifest.filter((f) => kept.includes(f.path)),
      tasks: [{ ...raw.tasks[0]!, scope: { read: ["SPEC.md"], write: ["src/normalize.ts"] } }]
    });
    const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock: () => 1000 });
    let version = "";
    await store.withWriter(async (w) => {
      await w.gitFor(plan).initialize();
      version = await w.git.importSource(source);
      await w.commit(
        -1,
        createBuildState({
          buildSchemaVersion: 1,
          planVersion: "build-plan-v1",
          actionVersion: "build-action-v1",
          budgetVersion: "build-budget-v1",
          checkVersion: "build-check-v1",
          publishVersion: "build-publish-v1",
          resultVersion: "build-result-v1",
          projectKey: plan.projectKey,
          runId: "killed-driver",
          revision: 0,
          ownerEpoch: 1,
          plan,
          acceptedVersion: version,
          status: "active",
          startedAt: 1000,
          deadlineAt: 2701000,
          acceptedTasks: [],
          waiting: [],
          attempts: [],
          calls: [],
          actionReceipts: [],
          checkReceipts: [],
          publishReceipts: []
        })
      );
    });
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ managed, plan }));
    const script = join(root, "host.mjs");
    const fileUrl = (file: string) => JSON.stringify(pathToFileURL(resolve(file)).href);
    await writeFile(
      script,
      `
import {readFile} from "node:fs/promises";
import {BuildDriver} from ${fileUrl("../argue/dist/index.js")};
import {FileBuildStore} from ${fileUrl("dist/build/file-store.js")};
import {LocalBuildSyncAdapter} from ${fileUrl("dist/build/local-sync-adapter.js")};
import {DockerVerifier} from ${fileUrl("dist/build/validator.js")};
const {managed,plan}=JSON.parse(await readFile(process.argv[2],"utf8"));
const models=Object.fromEntries(["member-a","member-b"].map(id=>[id,{protocol:"controlled",baseUrl:"https://controlled.invalid",modelId:id,apiKeyEnv:"UNUSED",outputMode:"json_object",generationOptions:{}}]));
await new FileBuildStore({workspaceRoot:managed,projectKey:plan.projectKey,clock:()=>1000}).withWriter(async writer=>{
 const verifier=new DockerVerifier(writer,{image:"sha256:${"a".repeat(64)}"});
 const ports=new LocalBuildSyncAdapter(writer,verifier,{clock:()=>1000}).ports;
 const driver=new BuildDriver({writer,ports,models,clock:()=>1000,transport:{async respond(){process.send?.({kind:"request_entered"});return new Promise(()=>{});}}});
 await driver.run();
});
`
    );
    child = fork(script, [config], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let diagnostic = "";
    child.stderr?.on("data", (chunk) => {
      diagnostic += String(chunk).slice(0, 4096);
    });
    const processExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
      child!.once("exit", (code, signal) => resolveExit({ code, signal }))
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((ready, reject) => {
          child!.on("message", (m) => {
            if (typeof m === "object" && m !== null && "kind" in m && m.kind === "request_entered") ready();
          });
          child!.once("error", reject);
          child!.once("exit", () => reject(Error("host exited before request: " + diagnostic)));
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("IPC request barrier timed out: " + diagnostic)), 90000);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const reserved = await store.load();
    expect(reserved.calls.map((c) => c.status)).toEqual(["reserved"]);
    expect(reserved.coordination.locks.length).toBeGreaterThan(0);
    child.kill("SIGKILL");
    expect((await processExit).signal).toBe("SIGKILL");
    let modelCalls = 0;
    const transport: ModelTransport = {
      async respond() {
        modelCalls++;
        throw Error("recover must not redispatch");
      }
    };
    const runtime = new LocalBuildRuntime({
      workspaceRoot: managed,
      plan,
      runId: "killed-driver",
      image: `sha256:${"a".repeat(64)}`,
      models: {},
      transport,
      clock: () => 1000
    });
    const result = await runtime.recover();
    const recovered = await store.load();
    expect(modelCalls).toBe(0);
    expect(result.status).toBe("incomplete");
    expect(recovered.calls.map((c) => c.status)).toEqual(["unknown"]);
    expect(result.budget.allocatedOutputTokens).toBe(4096);
    expect(recovered.ownerEpoch).toBeGreaterThan(reserved.ownerEpoch);
    expect(recovered.attempts[0]?.status).toBe("paused");
    expect(recovered.coordination.locks).toEqual([]);
    expect(recovered.acceptedVersion).toBe(version);
    expect(recovered.publishReceipts).toEqual([]);
    console.log(
      "VERIFIED actual driver SIGKILL: reserved->unknown, allocation4096, recoveryModelCalls0, acceptedVersion preserved"
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child!.once("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
