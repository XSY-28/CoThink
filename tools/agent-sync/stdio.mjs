import process from "node:process";
// Bootstrap deliberately has no static neutral imports: clear ambient model configuration first.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const allowedEnv = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "ComSpec"]);
export async function main(argv = process.argv.slice(2)) {
  for (const key of Object.keys(process.env)) if (!allowedEnv.has(key)) delete process.env[key];
  let path,
    trace = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && !path) path = argv[++i];
    else if (argv[i] === "--trace") trace = true;
    else throw Error("wire_configuration");
  }
  if (!path || !isAbsolute(path)) throw Error("wire_configuration");
  let diagnostics;
  if (trace) diagnostics = (await import("./diagnostics.mjs")).installDiagnostics();
  const job = JSON.parse(await readFile(path, "utf8"));
  if (!job || Object.keys(job).sort().join() !== "connections,options") throw Error("wire_configuration");
  const keys = new Set([
    "workspaceRoot",
    "runId",
    "sourceRoot",
    "project",
    "config",
    "trustedRoot",
    "programRoot",
    "image",
    "home",
    "dockerEndpoint",
    "dockerContext",
    "timeoutMs"
  ]);
  if (!job.options || Object.keys(job.options).some((k) => !keys.has(k))) throw Error("wire_configuration");
  const { LocalAgentSync, FileAgentSyncStore } = await import("@onevcat/argue-cli/agent-sync/project");
  const { serve } = await import("./server.mjs");
  const { WIRE_VERSION, writeJsonLine, captureBindings } = await import("./protocol.mjs");
  const options = job.options,
    local = new LocalAgentSync(options);
  const connections = captureBindings(job.connections, options.project.memberIds);
  const store = new FileAgentSyncStore({
    workspaceRoot: options.workspaceRoot,
    projectKey: options.project.projectKey,
    expectedPlanHash: options.project.planHash,
    expectedRunId: options.runId
  });
  let server,
    stopRequested = false;
  const stop = () => {
    stopRequested = true;
    server?.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await local.withSession(async (service) => {
      if (stopRequested) {
        service.close();
        return;
      }
      const status = await service.status();
      if (stopRequested) {
        service.close();
        return;
      }
      server = serve({ service, bindings: connections, loadState: () => store.load(), diagnostics });
      await writeJsonLine(process.stdout, { protocolVersion: WIRE_VERSION, event: "ready", status });
      await server.closeRequested;
    });
    // Existing writer finalizers have now drained their current transaction and released authority.
    if (server) {
      server.markWriterReleased();
      await server.drain();
    } else if (stopRequested) {
      process.stdin.destroy();
      await writeJsonLine(process.stdout, { protocolVersion: WIRE_VERSION, event: "stopped", writerReleased: true });
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('{"error":{"code":"wire_startup_failed"}}\n');
    process.exitCode = 1;
  });
}
