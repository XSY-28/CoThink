import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { createBuildState, type BuildLease } from "@onevcat/argue";
import { runInput } from "../../../argue/test/build/fixtures.js";
import { FileBuildStore } from "../../dist/build/file-store.js";
import { recoverBuild } from "../../dist/build/recovery.js";
import { Publisher } from "../../dist/build/publisher.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
        child.kill("SIGKILL");
        await exited;
      }
    })
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const logs = resolve("../../../work/construction-stage3");
const modules = {
  core: pathToFileURL(resolve("../argue/dist/index.js")).href,
  store: pathToFileURL(resolve("dist/build/file-store.js")).href,
  workspace: pathToFileURL(resolve("dist/build/workspace.js")).href,
  publisher: pathToFileURL(resolve("dist/build/publisher.js")).href
};
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-recovery-process-")));
  roots.push(root);
  const source = join(root, "input");
  const managed = join(root, "managed");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(managed);
  await writeFile(join(source, "SPEC.md"), "spec");
  await writeFile(join(source, "src/normalize.ts"), "v0");
  await writeFile(join(source, "src/report.ts"), "total");
  const input = runInput();
  const store = new FileBuildStore({ workspaceRoot: managed, projectKey: input.projectKey, clock: () => 1000 });
  const accepted = await store.withWriter(async (writer) => {
    await writer.gitFor(input.plan).initialize();
    const version = await writer.git.importSource(source);
    await writer.commit(-1, createBuildState({ ...input, acceptedVersion: version }));
    return version;
  });
  const childScript = join(root, "publisher-child.mjs");
  // The child runs shipped compiled modules. Its verifier is trusted test input
  // for crash/CAS behavior only; it performs no Docker validation or model call.
  await writeFile(
    childScript,
    `
import { FileBuildStore } from ${JSON.stringify(modules.store)};
import { Workspace } from ${JSON.stringify(modules.workspace)};
import { Publisher } from ${JSON.stringify(modules.publisher)};
import { reserveBuildScope, hashBuildValue } from ${JSON.stringify(modules.core)};
const [managed, boundary, exportTarget] = process.argv.slice(2);
const clock = () => 1000;
process.on("message", () => {}); // Keep IPC alive at the explicit fault boundary.
const notify = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
try {
  await new FileBuildStore({workspaceRoot:managed,projectKey:"todo-stats",clock}).withWriter(async writer => {
    const lease = await writer.transaction(async state => {
      const transition = reserveBuildScope(state, {taskId:"T-A",workerId:"member-a",requestId:"process-reserve-a",ownerEpoch:state.ownerEpoch},clock(),
        () => ({attemptId:"process-attempt-a",token:"process-token-a"}));
      if (transition.result.kind !== "granted") throw new Error("process task not granted");
      return {state:transition.state,value:transition.result.lease};
    });
    const gateway = new Workspace(writer,{clock});
    await gateway.freezeInput(lease,"process-freeze-a");
    const read = await gateway.inspect(lease,"process-inspect-a","src/normalize.ts");
    await gateway.edit(lease,"process-edit-a",[{path:"src/normalize.ts",text:"process accepted normalizer\\n",expectedContentHash:read.contentHash}]);
    const receipts = new WeakSet();
    let checks = 0;
    const verifier = {
      async describe(groups) { return {groups:[...groups],checksHash:hashBuildValue({groups,fixture:"process"}),
        toolchainHash:hashBuildValue("trusted process toolchain"),isolationHash:hashBuildValue("trusted process fixture only"),imageDigest:"fixture/process@sha256:"+"f".repeat(64)}; },
      ownsReceipt(receipt) { return receipts.has(receipt); },
      async check(candidate,definition) {
        checks++;
        const files = await writer.git.readFiles(candidate.version);
        const sourceHash = hashBuildValue(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,file])=>({path,contentHash:file.contentHash})));
        const receipt = {...candidate,...definition,checkVersion:"build-check-v1",receiptId:"process-check-a",sourceHashBefore:sourceHash,sourceHashAfter:sourceHash,exitCode:0,passed:true};
        receipts.add(receipt); return receipt;
      }
    };
    const atBoundary = async () => {
      const state = await writer.load();
      await notify({kind:"boundary",boundary,lease,acceptedVersion:state.acceptedVersion,publishReceipts:state.publishReceipts,checks});
      await new Promise(() => {});
    };
    await new Publisher(writer,verifier,{clock,[boundary]:atBoundary}).finish(lease,"process-finish-a",{exportTarget});
    throw new Error("fault boundary was not reached");
  });
} catch (error) {
  await notify({kind:"error",error:error instanceof Error ? error.message : String(error)});
  process.exitCode=1; process.disconnect();
}
`
  );
  return { root, source, managed, store, accepted, childScript, exportTarget: join(root, "export") };
}
function launch(script: string, args: string[]) {
  const child = fork(script, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolveExit({ code, signal });
    });
  });
  const boundary = new Promise<{
    boundary: string;
    lease: BuildLease;
    acceptedVersion: string;
    publishReceipts: unknown[];
    checks: number;
  }>((resolveBoundary, reject) => {
    const timer = setTimeout(() => reject(new Error("Publisher child did not reach its IPC boundary")), 180000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Publisher exited before boundary: ${code}/${signal}: ${stderr}`));
    });
    child.once("message", (value) => {
      clearTimeout(timer);
      const message = value as {
        kind: string;
        error?: string;
        boundary: string;
        lease: BuildLease;
        acceptedVersion: string;
        publishReceipts: unknown[];
        checks: number;
      };
      if (message.kind !== "boundary") reject(new Error(message.error ?? "Unexpected child IPC message"));
      else resolveBoundary(message);
    });
  });
  return { child, boundary, exit, output: () => ({ stdout, stderr }) };
}

describe("SIGKILL recovery using compiled modules and a trusted verifier fixture; no Docker evidence", () => {
  test.each(["beforeCAS", "afterCAS"] as const)(
    "interruption at %s preserves one complete authoritative version",
    async (boundary) => {
      const h = await setup();
      const running = launch(h.childScript, [h.managed, boundary, h.exportTarget]);
      const observed = await running.boundary;
      expect(observed.boundary).toBe(boundary);
      expect(observed.checks).toBe(1);
      expect(running.child.kill("SIGKILL")).toBe(true);
      const exit = await running.exit;
      expect(exit).toEqual({ code: null, signal: "SIGKILL" });
      await expect(lstat(h.exportTarget)).rejects.toMatchObject({ code: "ENOENT" });
      const recovered = await h.store.withWriter(async (writer) => {
        const before = await readFile(join(h.managed, ".cothink-build/state/todo-stats/session.json"));
        const result = await recoverBuild(writer);
        const state = await writer.load();
        expect(state.ownerEpoch).toBe(3);
        expect(state.coordination.locks).toEqual([]);
        expect(state.calls).toEqual([]);
        expect(result.modelCalls).toBe(0);
        expect(await readFile(join(h.managed, ".cothink-build/state/todo-stats/session.json"))).toEqual(before);
        if (boundary === "beforeCAS") {
          expect(result.acceptedVersion).toBe(h.accepted);
          expect(result.acceptedTasks).toEqual([]);
          expect(result.publishReceipts).toEqual([]);
          expect(state.attempts[0]!.status).toBe("paused");
          expect((await writer.git.readFile(result.acceptedVersion, "src/normalize.ts")).text).toBe("v0");
        } else {
          expect(result.acceptedVersion).not.toBe(h.accepted);
          expect(result.acceptedVersion).toBe(observed.acceptedVersion);
          expect(result.acceptedTasks).toEqual(["T-A"]);
          expect(result.publishReceipts).toHaveLength(1);
          expect(result.publishReceipts).toEqual(observed.publishReceipts);
          expect(state.attempts[0]!.status).toBe("completed");
          expect((await writer.git.readFile(result.acceptedVersion, "src/normalize.ts")).text).toBe(
            "process accepted normalizer\n"
          );
          expect((await writer.git.readFile(result.acceptedVersion, "src/report.ts")).text).toBe("total");
          let checks = 0;
          let exports = 0;
          const noWork = {
            async describe(): Promise<never> {
              throw new Error("Replay must not describe checks");
            },
            ownsReceipt() {
              return false;
            },
            async check(): Promise<never> {
              checks++;
              throw new Error("Replay must not check");
            }
          };
          const replay = await new Publisher(writer, noWork, {
            clock: () => 1000,
            exportVersion: async () => {
              exports++;
              throw new Error("Replay must not export");
            }
          }).finish(observed.lease, "process-finish-a", { exportTarget: h.exportTarget });
          expect(replay).toMatchObject({
            status: "accepted",
            receipt: result.publishReceipts[0],
            export: { status: "not_retried" }
          });
          expect(checks).toBe(0);
          expect(exports).toBe(0);
          expect(await readFile(join(h.managed, ".cothink-build/state/todo-stats/session.json"))).toEqual(before);
        }
        return result;
      });
      expect(await readFile(join(h.source, "src/normalize.ts"), "utf8")).toBe("v0");
      await mkdir(logs, { recursive: true });
      await writeFile(
        join(logs, `recovery-process-${boundary}.json`),
        JSON.stringify(
          {
            evidence: "real IPC-directed SIGKILL; trusted host verifier fixture only; no Docker/model/power-cut claim",
            boundary,
            childPid: running.child.pid,
            exit,
            initialAcceptedVersion: h.accepted,
            observed,
            recovered,
            output: running.output()
          },
          null,
          2
        ) + "\n"
      );
    },
    240000
  );
});
