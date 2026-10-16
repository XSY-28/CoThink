import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { hashJson, type AgentSyncStatus } from "@onevcat/argue/agent-sync/project";
import type { ModelTransport } from "@onevcat/argue";
import { ToolHost } from "../../../../tools/agent-sync/client.mjs";
import {
  DEFAULT_PEER_CONFIG,
  DEFAULT_PEER_ENV,
  readPeerEnvironment
} from "../../../argue-cli/src/peer/local-config.js";
import { createApiModelTransport } from "../../../argue-cli/src/runtime/model-api.js";
import { bindings, integrationSchema, jobSchema, modelProfiles, parseSnapshot, type Snapshot } from "./config.js";
import { exists, lockCaller, readJson, recordEvent, saveJson } from "./files.js";
import { acquireTask } from "./scope-client.js";
import { runSyncCaller } from "./caller.js";
import type { ModelProfile, SyncHost, WorkerClient } from "./types.js";

type Io = Pick<Console, "log" | "error">;
export interface SyncDependencies {
  env?: Record<string, string | undefined>;
  transport?: ModelTransport;
}
const help = `cothink build sync start --integration FILE --approve-plan HASH --root NEW_DIR [--config FILE] [--env-file FILE] [--json]
cothink build sync show|cancel|recover|resume --root DIR [--json]
cothink build sync export --root DIR --output NEW_DIR [--json]
Start/resume use the frozen shared model budget. Recover makes zero model calls; resume is a separate explicit command.
The integration file binds an external agent-sync checkout/job, exact tasks and worker-to-member mapping. See docs/cothink/AGENT_SYNC.md.`;
const id = () => randomUUID();
const hashFile = async (path: string) =>
  "sha256:" +
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const statusSchema = z.object({
  projectKey: z.string(),
  runId: z.string(),
  planHash: z.string(),
  acceptedVersion: z.string(),
  status: z.string(),
  tasks: z.array(z.object({ taskId: z.string(), workerId: z.string(), status: z.string() })),
  waiting: z.array(z.object({ taskId: z.string(), sequence: z.number() })),
  serviceVersion: z.literal("agent-sync-project-service-v1")
});
function status(value: unknown, s: Snapshot): AgentSyncStatus {
  const result = statusSchema.parse(value);
  if (
    result.planHash !== s.job.options.project.planHash ||
    result.runId !== s.job.options.runId ||
    result.projectKey !== s.job.options.project.projectKey
  )
    throw Error("SYNC_TOOL_IDENTITY");
  return result as AgentSyncStatus;
}
function parse(argv: string[]) {
  const [command, ...args] = argv;
  if (!command || ["help", "--help"].includes(command)) return { command: "help", values: new Map<string, string>() };
  const allowed: Record<string, string[]> = {
    start: ["integration", "approve-plan", "root", "config", "env-file"],
    show: ["root"],
    cancel: ["root"],
    recover: ["root"],
    resume: ["root"],
    export: ["root", "output"]
  };
  if (!allowed[command]) throw Error("SYNC_ARGUMENT_INVALID");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !values.has("json")) {
      values.set("json", "true");
      continue;
    }
    const key = args[i]!.slice(2),
      value = args[++i];
    if (
      !args[i - 1]!.startsWith("--") ||
      !allowed[command]!.includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--")
    )
      throw Error("SYNC_ARGUMENT_INVALID");
    values.set(key, value);
  }
  const required =
    command === "start"
      ? ["integration", "approve-plan", "root"]
      : command === "export"
        ? ["root", "output"]
        : ["root"];
  if (required.some((k) => !values.has(k))) throw Error("SYNC_ARGUMENT_INVALID");
  return { command, values };
}
async function snapshotStart(values: Map<string, string>, root: string): Promise<Snapshot> {
  const integration = integrationSchema.parse(await readJson(resolve(values.get("integration")!)));
  const job = jobSchema.parse(await readJson(integration.jobFile));
  bindings(job, integration);
  if (job.options.project.planHash !== values.get("approve-plan")) throw Error("SYNC_PLAN_APPROVAL_REQUIRED");
  if (!job.options.sourceRoot) throw Error("SYNC_SOURCE_REQUIRED");
  // A new caller must never silently restart an already managed job or reset its budgets.
  if (
    await exists(join(job.options.workspaceRoot, ".agent-sync/state", job.options.project.projectKey, "session.json"))
  )
    throw Error("SYNC_EXISTING_PROJECT");
  for (const source of [job.options.workspaceRoot, job.options.sourceRoot, job.options.trustedRoot, job.options.home]) {
    if (typeof source === "string" && (root === source || root.startsWith(source + sep)))
      throw Error("SYNC_ROOT_OVERLAP");
  }
  const models = modelProfiles(
    await readJson(resolve(values.get("config") ?? DEFAULT_PEER_CONFIG)),
    job.options.project,
    integration
  );
  const envFile = values.has("env-file")
    ? resolve(values.get("env-file")!)
    : (await exists(resolve(DEFAULT_PEER_ENV)))
      ? resolve(DEFAULT_PEER_ENV)
      : undefined;
  const body = {
    version: "cothink-agent-sync-run-v1" as const,
    integration,
    job,
    models,
    deadlineAt: Date.now() + integration.budget.maxDurationMs,
    ...(envFile ? { envFile } : {}),
    toolHash: await hashFile(integration.toolEntry)
  };
  return parseSnapshot({ ...body, snapshotHash: hashJson(body) });
}
async function journal(root: string, snapshot: Snapshot) {
  const lines = (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (lines[0]?.event !== "created" || lines[0].snapshotHash !== snapshot.snapshotHash)
    throw Error("SYNC_JOURNAL_INVALID");
  const calls = lines.filter((e) => e.event === "call-reserved");
  if (
    new Set(calls.map((e) => e.requestId)).size !== calls.length ||
    calls.some((e) => e.allocatedOutputTokens !== snapshot.integration.budget.maxOutputTokensPerCall)
  )
    throw Error("SYNC_JOURNAL_INVALID");
  return calls.length;
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, error: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(error)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function makeHost(s: Snapshot, root: string, reopen: boolean) {
  if ((await hashFile(s.integration.toolEntry)) !== s.toolHash) throw Error("SYNC_TOOL_CHANGED");
  const job = structuredClone(s.job);
  if (
    reopen &&
    (await exists(join(job.options.workspaceRoot, ".agent-sync/state", job.options.project.projectKey, "session.json")))
  )
    delete job.options.sourceRoot;
  const configFile = join(root, "tool-job.json");
  await saveJson(configFile, job);
  const raw = new ToolHost({ entry: s.integration.toolEntry, configFile, cwd: root });
  // The typed facade exposes only the narrow worker client; no service implementation is imported.
  const host = raw as unknown as SyncHost;
  host.ready = bounded(host.ready, 120000, "SYNC_TOOL_START_TIMEOUT");
  // Bound all RPC traffic below the tool's 32-frame window, including large task sets.
  let inFlight = 0;
  const queue: Array<() => void> = [];
  const workerAbort = new AbortController();
  async function limited<T>(action: () => Promise<T>, work = false): Promise<T> {
    if (inFlight >= 8) await new Promise<void>((resolve) => queue.push(resolve));
    else inFlight++;
    try {
      if (work && workerAbort.signal.aborted) throw Error("SYNC_CANCELLED");
      return await bounded(action(), 150000, "SYNC_TOOL_OPERATION_TIMEOUT");
    } finally {
      const next = queue.shift();
      if (next) next();
      else inFlight--;
    }
  }
  const bound = bindings(s.job, s.integration),
    rawAdmin = raw.client(bound.admin);
  const admin = {
    ...rawAdmin,
    call: (...args: Parameters<typeof rawAdmin.call>) =>
      bounded(rawAdmin.call(...args), 150000, "SYNC_TOOL_OPERATION_TIMEOUT")
  };
  const clients: Record<string, WorkerClient> = Object.fromEntries(
    Object.entries(bound.workers).map(([worker, connection]) => {
      const client = raw.client(connection);
      return [
        worker,
        {
          call: (...args: Parameters<typeof client.call>) =>
            bounded(client.call(...args), 150000, "SYNC_TOOL_OPERATION_TIMEOUT"),
          async requestScope(taskId: string, requestId: string) {
            const granted = await limited(() => acquireTask(client, taskId, requestId), true);
            if (!granted.task) return granted;
            const task = granted.task;
            return {
              ...granted,
              task: {
                freezeInput: (request: string) => limited(() => task.freezeInput(request), true),
                read: (path: string, request: string) => limited(() => task.read(path, request), true),
                runAction: (action: unknown, request: string) => limited(() => task.runAction(action, request), true)
              }
            };
          }
        }
      ];
    })
  );
  return {
    host,
    admin,
    clients,
    abortWorkers: () => workerAbort.abort(),
    workStatus: () => limited(() => rawAdmin.call("status", {}, id()), true)
  };
}
async function closeHost(host: SyncHost, admin: ReturnType<ToolHost["client"]>) {
  try {
    if (!host.closed) {
      const closed = await bounded(admin.call("close", {}, id()), 150000, "SYNC_TOOL_CLOSE_TIMEOUT");
      if (!(closed.result as { writerReleased?: boolean }).writerReleased) throw Error("SYNC_WRITER_NOT_RELEASED");
    }
    const exit = await bounded(host.exited, 10000, "SYNC_TOOL_EXIT_TIMEOUT");
    if (exit.code !== 0) throw Error("SYNC_TOOL_EXIT_FAILED");
  } catch (error) {
    host.child.kill("SIGTERM");
    try {
      await bounded(host.exited, 10000, "SYNC_TOOL_EXIT_TIMEOUT");
    } catch {
      host.child.kill("SIGKILL");
      await bounded(host.exited, 5000, "SYNC_TOOL_EXIT_TIMEOUT");
    }
    throw error;
  }
}
async function transportFor(snapshot: Snapshot, deps: SyncDependencies): Promise<ModelTransport> {
  if (deps.transport) return deps.transport;
  else {
    const env = await readPeerEnvironment(snapshot.envFile, deps.env ?? process.env);
    const names = Object.values(snapshot.models).map((m) => m.apiKeyEnv);
    if (names.some((n) => !env[n]?.trim())) throw Error("SYNC_CREDENTIALS_REQUIRED");
    return createApiModelTransport(env, names);
  }
}
async function execute(command: string, root: string, snapshot: Snapshot, deps: SyncDependencies) {
  const usedCalls = await journal(root, snapshot);
  if (command === "resume") {
    const previous = (await readJson(join(root, "result.json"))) as { status?: string };
    if (previous.status !== "recovered") throw Error("SYNC_RECOVERY_REQUIRED");
  }
  let transport: ModelTransport | undefined;
  if (command === "start" || command === "resume") {
    if (Date.now() >= snapshot.deadlineAt) throw Error("SYNC_DEADLINE");
    if (
      usedCalls >= snapshot.integration.budget.maxCalls ||
      (usedCalls + 1) * snapshot.integration.budget.maxOutputTokensPerCall >
        snapshot.integration.budget.maxAllocatedOutputTokens
    )
      throw Error("SYNC_BUDGET_EXHAUSTED");
    transport = await transportFor(snapshot, deps);
  }
  const { host, admin, clients, abortWorkers, workStatus } = await makeHost(snapshot, root, command !== "start");
  const controller = new AbortController();
  let cancellation: Promise<void> | undefined, cancelError: unknown;
  const cancelPath = join(root, "cancel-request.json");
  const cancel = () => {
    controller.abort();
    abortWorkers();
    cancellation ??= bounded(
      (async () => {
        await host.ready;
        for (const task of snapshot.job.options.project.tasks)
          await clients[task.workerId]!.call("cancel", { taskId: task.taskId }, id());
        const cancelled = status((await admin.call("status", {}, id())).result, snapshot);
        if (cancelled.tasks.some((task) => !["completed", "cancelled"].includes(task.status)))
          throw Error("SYNC_CANCEL_UNCONFIRMED");
        recordEvent(root, { event: "cancel-acknowledged" });
      })(),
      150000,
      "SYNC_CANCEL_UNCONFIRMED"
    ).catch((e) => {
      cancelError = e;
    });
  };
  const onSignal = () => cancel();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let polling = false;
  const poll = setInterval(() => {
    if (polling || cancellation || command === "recover") return;
    polling = true;
    void exists(cancelPath)
      .then((present) => {
        if (present) cancel();
      })
      .catch(() => cancel())
      .finally(() => {
        polling = false;
      });
  }, 100);
  const deadline = setTimeout(() => controller.abort(), Math.max(1, snapshot.deadlineAt - Date.now()));
  let output: Record<string, unknown> = { status: "paused" };
  try {
    const ready = await bounded(
      host.ready,
      command === "start" || command === "resume" ? Math.max(1, snapshot.deadlineAt - Date.now()) : 120000,
      "SYNC_TOOL_START_TIMEOUT"
    );
    let actual = status(ready.status, snapshot);
    if (command === "cancel" || (command !== "recover" && (await exists(cancelPath)))) cancel();
    if (command === "recover") {
      const recovered = (await admin.call("recover", {}, id())).result as { replayedActions?: number };
      if (recovered.replayedActions !== 0) throw Error("SYNC_RECOVERY_REPLAY");
      output = { status: "recovered", toolStatus: status(recovered, snapshot), replayedActions: 0 };
      if (await exists(cancelPath)) {
        cancel();
        await cancellation;
        output.status = cancelError ? "paused" : "cancelled";
      }
    } else if (command === "cancel") {
      await cancellation;
      if (cancelError) throw cancelError;
      output = { status: "cancelled", toolStatus: status((await admin.call("status", {}, id())).result, snapshot) };
    } else {
      if (actual.status === "completed" || actual.status === "cancelled") throw Error("SYNC_RUN_INACTIVE");
      await saveJson(join(root, "result.json"), {
        status: "running",
        planHash: snapshot.job.options.project.planHash,
        deadlineAt: snapshot.deadlineAt,
        usedCalls
      });
      recordEvent(root, { event: command });
      await runSyncCaller({
        project: snapshot.job.options.project,
        clients,
        profiles: snapshot.models as Record<string, ModelProfile>,
        instructions: snapshot.integration.instructions,
        transport: transport!,
        budget: snapshot.integration.budget,
        usedCalls,
        deadlineAt: snapshot.deadlineAt,
        signal: controller.signal,
        record: (e) => recordEvent(root, e),
        status: async () => status((await workStatus()).result, snapshot)
      });
      actual = status((await admin.call("status", {}, id())).result, snapshot);
      if (actual.status !== "completed") throw Error("SYNC_ACCEPTANCE_INCOMPLETE");
      const diff = (await admin.call("diff", {}, id())).result;
      await saveJson(join(root, "diff.json"), diff);
      output = { status: "completed", toolStatus: actual, diffFile: join(root, "diff.json") };
    }
  } catch (e) {
    output = { status: cancellation ? "cancelled" : "paused", error: code(e) };
  } finally {
    abortWorkers();
    if (
      command !== "recover" &&
      (await exists(cancelPath).catch(() => {
        cancel();
        return false;
      }))
    )
      cancel();
    clearInterval(poll);
    clearTimeout(deadline);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cancellation;
    if (cancelError) output = { status: "paused", error: "SYNC_CANCEL_UNCONFIRMED" };
    else if (cancellation) output = { ...output, status: "cancelled" };
    try {
      await closeHost(host, admin);
      output.writerReleased = true;
    } catch {
      output = { ...output, status: "paused", error: "SYNC_TOOL_CLOSE_FAILED", writerReleased: false };
    }
    output = {
      ...output,
      usedCalls: await journal(root, snapshot),
      planHash: snapshot.job.options.project.planHash,
      deadlineAt: snapshot.deadlineAt
    };
    await saveJson(join(root, "result.json"), output);
  }
  return output;
}
function code(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^SYNC_[A-Z_]+$/.test(message) ? message : "SYNC_INPUT_OR_TOOL_FAILED";
}
export async function runSyncCommand(
  argv: string[],
  io: Io,
  deps: SyncDependencies = {}
): Promise<{ ok: boolean; code: number }> {
  try {
    const { command, values } = parse(argv);
    if (command === "help") {
      io.log(help);
      return { ok: true, code: 0 };
    }
    const root = resolve(values.get("root")!);
    let snapshot: Snapshot;
    if (command === "start") {
      if ((await realpath(dirname(root))) !== dirname(root)) throw Error("SYNC_PATH_ALIAS");
      snapshot = await snapshotStart(values, root);
      await transportFor(snapshot, deps);
      await mkdir(root, { mode: 0o700 });
      await saveJson(join(root, "snapshot.json"), snapshot);
      recordEvent(root, { event: "created", snapshotHash: snapshot.snapshotHash });
    } else {
      if ((await realpath(root)) !== root) throw Error("SYNC_PATH_ALIAS");
      snapshot = parseSnapshot(await readJson(join(root, "snapshot.json")));
    }
    if (command === "show") {
      const saved = (await readJson(join(root, "result.json"))) as Record<string, unknown>;
      io.log(JSON.stringify({ ...saved, usedCalls: await journal(root, snapshot) }, null, 2));
      return { ok: true, code: 0 };
    }
    if (command === "cancel" && (await exists(join(root, "caller.lock")))) {
      const owner = (await readJson(join(root, "caller.lock"))) as { operation?: string };
      if (!["start", "resume"].includes(owner.operation ?? "")) throw Error("SYNC_CONTROL_BUSY");
      // The active model caller owns the tool. It must revoke its original permissions itself.
      await writeFile(join(root, "cancel-request.json"), "{}\n", { flag: "wx", mode: 0o600 }).catch(async (e) => {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      });
      io.log(JSON.stringify({ status: "cancel-requested", acknowledged: false }));
      return { ok: true, code: 0 };
    }
    const unlock = await lockCaller(root, command === "recover", command);
    try {
      if (command === "resume" && (await exists(join(root, "cancel-request.json")))) throw Error("SYNC_RUN_CANCELLED");
      if (command === "export") {
        const { host, admin } = await makeHost(snapshot, root, true);
        try {
          status((await host.ready).status, snapshot);
          const exported = await admin.call("exportVersion", { target: resolve(values.get("output")!) }, id());
          io.log(JSON.stringify({ status: "exported", result: exported.result }));
        } finally {
          await closeHost(host, admin);
        }
        return { ok: true, code: 0 };
      }
      let result: Record<string, unknown>;
      try {
        result = await execute(command, root, snapshot, deps);
      } catch (e) {
        if (command !== "resume" || code(e) !== "SYNC_RECOVERY_REQUIRED")
          await saveJson(join(root, "result.json"), {
            status: "paused",
            error: code(e),
            usedCalls: await journal(root, snapshot),
            deadlineAt: snapshot.deadlineAt
          });
        throw e;
      }
      io.log(JSON.stringify(result, null, 2));
      const ok = ["completed", "recovered", "cancelled"].includes(String(result.status));
      return { ok, code: ok ? 0 : 1 };
    } finally {
      await unlock();
    }
  } catch (e) {
    io.error(code(e));
    return { ok: false, code: 1 };
  }
}
