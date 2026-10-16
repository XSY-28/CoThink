import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, mkdir, realpath, writeFile, symlink, link, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBuildState,
  reserveBuildScope,
  bindBuildInput,
  hashBuildValue,
  revokeBuildScope,
  parseBuildState,
  type BuildState
} from "@onevcat/argue";
import { runInput } from "../../../argue/test/build/fixtures.js";
import { createBuildSnapshotCodec, FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { FileSnapshotStore } from "../../src/storage/snapshot-store.js";
import { Workspace } from "../../src/build/workspace.js";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cothink-build-store-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("independent build snapshot codec on actual disk", () => {
  it.each(["runId", "startedAt", "deadlineAt", "ownerEpoch"] as const)(
    "rejects changed immutable %s without replacing authoritative bytes",
    async (key) => {
      const initial = createBuildState(runInput());
      const store = new FileSnapshotStore(root, createBuildSnapshotCodec(initial.projectKey));
      await store.withWriter(initial.projectKey, async (writer) => {
        await writer.commit(-1, initial);
        const before = await readFile(join(root, initial.projectKey, "session.json"), "utf8");
        const value =
          key === "runId"
            ? "forged-run"
            : key === "ownerEpoch"
              ? 2
              : key === "startedAt"
                ? 999
                : initial.deadlineAt - 1;
        await expect(writer.commit(0, { ...initial, revision: 1, [key]: value } as BuildState)).rejects.toThrow();
        expect(await readFile(join(root, initial.projectKey, "session.json"), "utf8")).toBe(before);
      });
    }
  );
});

function host(rootPath = root) {
  return new FileBuildStore({ workspaceRoot: rootPath, projectKey: "todo-stats", clock: () => 1000 });
}
function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
async function initialize(store = host()) {
  const source = join(root, "input");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "SPEC.md"), "spec");
  await writeFile(join(source, "src/normalize.ts"), "v0");
  await writeFile(join(source, "src/report.ts"), "total");
  await store.withWriter(async (writer) => {
    const run = runInput();
    const git = writer.gitFor(run.plan);
    await git.initialize();
    const version = await git.importSource(source);
    await writer.commit(-1, createBuildState({ ...run, acceptedVersion: version }));
  });
  return store;
}
const snapshotPath = () => join(root, ".cothink-build/state/todo-stats/session.json");

describe("FileBuildStore managed real disk", { timeout: 30000 }, () => {
  it("fixes project identity and control directory and blocks a second project owner", async () => {
    const store = await initialize();
    const before = await readFile(snapshotPath(), "utf8");
    expect(
      () => new FileBuildStore({ workspaceRoot: root, projectKey: "todo-stats", controlDirectory: ".other" })
    ).toThrow(/fixed/);
    await expect(
      new FileBuildStore({ workspaceRoot: root, projectKey: "other" }).withWriter(async () => {})
    ).rejects.toThrow(/identity/);
    expect(await readFile(snapshotPath(), "utf8")).toBe(before);
    const copiedRoot = join(root, "copied-workspace");
    await mkdir(join(copiedRoot, ".cothink-build"), { recursive: true });
    await writeFile(
      join(copiedRoot, ".cothink-build/project.json"),
      await readFile(join(root, ".cothink-build/project.json"))
    );
    await expect(host(copiedRoot).withWriter(async () => {})).rejects.toThrow(/identity/);
    await store.withWriter(async (writer) => {
      await expect(host().withWriter(async () => {})).rejects.toThrow(/held/);
      const current = await writer.load();
      await expect(
        writer.commit(current.revision, { ...current, runId: "another-run", revision: current.revision + 1 })
      ).rejects.toThrow(/immutable/);
    });
    expect((await store.load()).runId).toBe("run-1");
  });
  it("rejects root aliases and ordinary source checkouts before control metadata exists", async () => {
    const target = join(root, "managed");
    await mkdir(target);
    const alias = join(root, "alias");
    await symlink(target, alias);
    await expect(host(alias).withWriter(async () => {})).rejects.toThrow(/real directory/);
    await mkdir(join(root, ".git"));
    await expect(host(target).withWriter(async () => {})).rejects.toThrow(/source Git checkout/);
    await expect(readdir(target)).resolves.toEqual([]);
  });
  it("CAS conflict preserves bytes, and complete transactions serialize read/mutate/commit", async () => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const initial = await writer.load();
      const firstRead = deferred();
      const releaseFirst = deferred();
      let secondEntered = false;
      const first = writer.transaction(async (current) => {
        firstRead.resolve();
        await releaseFirst.promise;
        return {
          state: {
            ...current,
            revision: current.revision + 1,
            coordination: { ...current.coordination, nextSequence: current.coordination.nextSequence + 1 }
          },
          value: "first"
        };
      });
      await firstRead.promise;
      const second = writer.transaction(async (current) => {
        secondEntered = true;
        return {
          state: {
            ...current,
            revision: current.revision + 1,
            coordination: { ...current.coordination, nextSequence: current.coordination.nextSequence + 1 }
          },
          value: "second"
        };
      });
      expect(secondEntered).toBe(false);
      releaseFirst.resolve();
      expect(await Promise.all([first, second])).toEqual(["first", "second"]);
      expect((await writer.load()).coordination.nextSequence).toBe(2);
      const before = await readFile(snapshotPath(), "utf8");
      await expect(writer.commit(initial.revision, { ...initial, revision: initial.revision + 1 })).rejects.toThrow(
        /revision conflict/
      );
      expect(await readFile(snapshotPath(), "utf8")).toBe(before);
    });
  });
  it("flushes unawaited queued operations before releasing the writer and denies escaped IO", async () => {
    const store = await initialize();
    let escaped!: FileBuildWriter;
    await store.withWriter(async (writer) => {
      escaped = writer;
      void writer.transaction(async (current) => ({
        state: {
          ...current,
          revision: current.revision + 1,
          coordination: { ...current.coordination, nextSequence: 7 }
        },
        value: undefined
      }));
    });
    expect((await store.load()).coordination.nextSequence).toBe(7);
    await expect(escaped.load()).rejects.toThrow(/ended/);
    await expect(escaped.assertOwner()).rejects.toThrow(/ended/);
    await expect(escaped.git.writeBlob("late")).rejects.toThrow(/ended/);
  });
  it("persists a bound baseline, invalidates old attempts before granting a new owner epoch", async () => {
    const store = await initialize();
    let oldAttemptId = "";
    await store.withWriter(async (writer) => {
      const state = await writer.load();
      const granted = reserveBuildScope(
        state,
        { requestId: "reserve-a", taskId: "T-A", workerId: "member-a", ownerEpoch: state.ownerEpoch },
        1000,
        () => ({ attemptId: "attempt-a", token: "a-token" })
      );
      expect(granted.result.kind).toBe("granted");
      if (granted.result.kind !== "granted") throw new Error("grant");
      const hashes = Object.fromEntries(
        await Promise.all(
          ["SPEC.md", "src/normalize.ts"].map(async (path) => [
            path,
            (await writer.git.readFile(state.acceptedVersion, path)).contentHash
          ])
        )
      );
      const bound = bindBuildInput(
        granted.state,
        granted.result.lease,
        "bind-a",
        {
          baseVersion: state.acceptedVersion,
          contentHashes: hashes,
          inputHash: hashBuildValue({
            planHash: state.plan.planHash,
            attemptId: granted.result.lease.attemptId,
            baseVersion: state.acceptedVersion,
            contentHashes: hashes
          })
        },
        1000
      );
      // Two pure reducers were prepared under the same writer; authoritative CAS advances once.
      await writer.commit(state.revision, { ...bound.state, revision: state.revision + 1 });
      oldAttemptId = "attempt-a";
    });
    const before = await store.load();
    await store.withWriter(async (writer) => {
      const recovered = await writer.load();
      expect(recovered.ownerEpoch).toBe(before.ownerEpoch + 1);
      expect(recovered.attempts.find((a) => a.attemptId === oldAttemptId)?.status).toBe("paused");
      expect(recovered.coordination.locks).toEqual([]);
      expect(recovered.calls).toEqual([]);
    });
  });
  it("fails closed on corrupt state, unknown Git versions and incomplete state writes", async () => {
    const store = await initialize();
    const initial = await readFile(snapshotPath(), "utf8");
    await writeFile(join(dirname(snapshotPath()), ".session-interrupted.tmp"), "{partial");
    expect((await store.load()).acceptedVersion).toBe(JSON.parse(initial).acceptedVersion);
    for (const corrupt of [
      "{partial",
      JSON.stringify({ ...JSON.parse(initial), acceptedVersion: "a".repeat(40) }),
      JSON.stringify({ ...JSON.parse(initial), projectKey: "forged" })
    ]) {
      await writeFile(snapshotPath(), corrupt);
      await expect(store.load()).rejects.toThrow();
      await expect(store.withWriter(async () => {})).rejects.toThrow();
      expect(await readFile(snapshotPath(), "utf8")).toBe(corrupt);
    }
    await writeFile(snapshotPath(), initial);
  });
  it("rejects metadata hard links, symlinks and changed lease nonce", async () => {
    const store = await initialize();
    const marker = join(root, ".cothink-build/project.json");
    const linked = join(root, "linked-marker");
    await link(marker, linked);
    await expect(store.load()).rejects.toThrow(/regular/);
    await unlink(linked);
    await store.withWriter(async (writer) => {
      const lock = join(dirname(snapshotPath()), ".writer.lock");
      const before = await readFile(lock, "utf8");
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: "00000000-0000-0000-0000-000000000000" }));
        await expect(writer.assertOwner()).rejects.toThrow(/lease was lost/);
        await expect(writer.git.writeBlob("forbidden")).rejects.toThrow(/lease was lost/);
      } finally {
        await writeFile(lock, before);
      }
    });
    const bytes = await readFile(snapshotPath(), "utf8");
    await unlink(snapshotPath());
    await writeFile(join(root, "external-state"), bytes);
    await symlink(join(root, "external-state"), snapshotPath());
    await expect(store.load()).rejects.toThrow();
  });
  it("preserves malformed or live unknown owners without stealing writer lock", async () => {
    const store = await initialize();
    const path = join(dirname(snapshotPath()), ".writer.lock");
    for (const lock of [
      "{unknown",
      JSON.stringify({ pid: process.pid, nonce: "00000000-0000-0000-0000-000000000000" })
    ]) {
      await writeFile(path, lock);
      const before = await readFile(snapshotPath(), "utf8");
      await expect(store.withWriter(async () => {})).rejects.toThrow(/Unknown|held/);
      expect(await readFile(path, "utf8")).toBe(lock);
      expect(await readFile(snapshotPath(), "utf8")).toBe(before);
    }
  });
  it("recovers a killed actual disk owner and refuses abandoned recovery locks", async () => {
    const store = await initialize();
    const sourceModule = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/storage/snapshot-store.ts")
    ).href;
    const script = `import { FileSnapshotStore } from ${JSON.stringify(sourceModule)};
const codec = { formatName: "build", parse: v => v, sessionId: s => s.projectKey, revision: s => s.revision, validateTransition: () => {} };
await new FileSnapshotStore(${JSON.stringify(join(root, ".cothink-build/state"))}, codec).withWriter("todo-stats", async () => {
process.stdout.write("LOCKED\\n"); setInterval(() => {}, 1000); await new Promise(() => {}); });`;
    const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", (chunk) =>
          chunk.toString().includes("LOCKED") ? resolve() : reject(new Error("lock barrier"))
        );
        child.once("exit", () => reject(new Error(`child exited before lock: ${stderr}`)));
      });
      await expect(store.withWriter(async () => {})).rejects.toThrow(/held/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    const before = await store.load();
    const recovery = join(dirname(snapshotPath()), ".recovery.lock");
    await writeFile(recovery, "unknown recovery");
    await expect(store.withWriter(async () => {})).rejects.toThrow(/recovery is locked/);
    expect(await readFile(recovery, "utf8")).toBe("unknown recovery");
    expect(await store.load()).toEqual(before);
    await unlink(recovery);
    await store.withWriter(async (writer) => {
      const recovered = await writer.load();
      expect(recovered.ownerEpoch).toBe(before.ownerEpoch + 1);
      expect(recovered.calls).toEqual([]);
    });
  });
});

describe("construction codec durable immutable history", () => {
  async function boundInitial() {
    const initial = createBuildState(runInput());
    const grant = reserveBuildScope(
      initial,
      { requestId: "grant", taskId: "T-A", workerId: "member-a", ownerEpoch: 1 },
      1000,
      () => ({ attemptId: "attempt-a", token: "token-a" })
    );
    if (grant.result.kind !== "granted") throw new Error("grant");
    const contentHashes = {
      "SPEC.md": initial.plan.manifest[0]!.contentHash,
      "src/normalize.ts": initial.plan.manifest[1]!.contentHash
    };
    const bound = bindBuildInput(
      grant.state,
      grant.result.lease,
      "bind",
      { baseVersion: initial.acceptedVersion, inputHash: hashBuildValue(contentHashes), contentHashes },
      1000
    );
    return { state: parseBuildState({ ...bound.state, revision: 0 }), lease: grant.result.lease };
  }
  it.each([
    "bound input",
    "attempt identity",
    "successful request",
    "reserved allocation",
    "owner jump",
    "epoch decrease"
  ] as const)("rejects historical rewrites of %s", async (variation) => {
    const { state, lease } = await boundInitial();
    const initial = parseBuildState({
      ...state,
      calls: [
        {
          callId: "call-a",
          attemptId: lease.attemptId,
          taskId: lease.taskId,
          inputHash: state.attempts[0]!.inputHash!,
          allocatedOutputTokens: 100,
          reservedAt: 1000,
          deadlineAt: 1001,
          status: "reserved"
        }
      ]
    });
    const next = structuredClone(initial) as unknown as {
      revision: number;
      ownerEpoch: number;
      attempts: { inputHash: string; token: string }[];
      coordination: { requests: { result: { lease?: { token: string } } }[]; taskEpochs: Record<string, number> };
      calls: { allocatedOutputTokens: number }[];
    };
    next.revision = 1;
    if (variation === "bound input") next.attempts[0]!.inputHash = `sha256:${"a".repeat(64)}`;
    if (variation === "attempt identity") {
      next.attempts[0]!.token = "different";
      next.coordination.requests[0]!.result.lease!.token = "different";
    }
    if (variation === "successful request") next.coordination.requests.splice(1, 1);
    if (variation === "reserved allocation") next.calls[0]!.allocatedOutputTokens = 99;
    if (variation === "owner jump") next.ownerEpoch = 3;
    if (variation === "epoch decrease") next.coordination.taskEpochs["T-B1"] = -1;
    const store = new FileSnapshotStore(root, createBuildSnapshotCodec(initial.projectKey));
    await store.withWriter(initial.projectKey, async (writer) => {
      await writer.commit(-1, initial);
      const before = await readFile(join(root, initial.projectKey, "session.json"), "utf8");
      await expect(writer.commit(0, next as unknown as BuildState)).rejects.toThrow();
      expect(await readFile(join(root, initial.projectKey, "session.json"), "utf8")).toBe(before);
    });
  });
  it("does not permit a revoked attempt to revive through a schema-valid historical grant", async () => {
    const { state, lease } = await boundInitial();
    const revoked = revokeBuildScope(state, lease, "revoke", 1000);
    const initial = parseBuildState({ ...revoked.state, revision: 0 });
    const store = new FileSnapshotStore(root, createBuildSnapshotCodec(initial.projectKey));
    await store.withWriter(initial.projectKey, async (writer) => {
      await writer.commit(-1, initial);
      // Restore old active shape while preserving monotonic request history; CAS codec must reject resurrection.
      const next = {
        ...state,
        revision: 1,
        coordination: { ...state.coordination, requests: initial.coordination.requests }
      };
      await expect(writer.commit(0, next)).rejects.toThrow();
      expect((await writer.load(initial.projectKey)).attempts[0]!.status).toBe("cancelled");
    });
  });
});

describe("candidate disk authorization", { timeout: 60000 }, () => {
  it("rejects a real Git candidate changing another task's file despite correct content hash", async () => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const state = await writer.load();
      const grant = reserveBuildScope(
        state,
        { requestId: "candidate-grant", taskId: "T-A", workerId: "member-a", ownerEpoch: state.ownerEpoch },
        1000,
        () => ({ attemptId: "candidate-a", token: "candidate-token" })
      );
      if (grant.result.kind !== "granted") throw new Error("grant");
      const alienBlob = await writer.git.writeBlob("another worker report");
      const candidate = await writer.git.createSnapshot(state.acceptedVersion, [
        { path: "src/report.ts", ...alienBlob }
      ]);
      const overlay = { attemptId: grant.result.lease.attemptId, baseVersion: state.acceptedVersion, files: [] };
      const forged = parseBuildState({
        ...grant.state,
        revision: state.revision + 1,
        workspace: {
          workspaceVersion: "build-workspace-v1",
          staging: [{ ...overlay, overlayHash: hashBuildValue(overlay) }],
          candidates: [
            {
              attemptId: overlay.attemptId,
              baseVersion: overlay.baseVersion,
              overlayHash: hashBuildValue(overlay),
              ...candidate
            }
          ],
          toolReceipts: []
        }
      });
      const before = await readFile(snapshotPath(), "utf8");
      await expect(writer.commit(state.revision, forged)).rejects.toThrow(/candidate/);
      expect(await readFile(snapshotPath(), "utf8")).toBe(before);
    });
  });
});

describe("transaction final precommit guard", { timeout: 60000 }, () => {
  it("runs the trusted guard after real asset reads and leaves authoritative bytes unchanged on refusal", async () => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const originalReadFiles = writer.git.readFiles.bind(writer.git);
      let readSinceCallback = false;
      writer.git.readFiles = async (version) => {
        const result = await originalReadFiles(version);
        readSinceCallback = true;
        return result;
      };
      let guardCalled = false;
      const before = await readFile(snapshotPath(), "utf8");
      await expect(
        writer.transaction(async (current) => {
          readSinceCallback = false;
          return {
            state: {
              ...current,
              revision: current.revision + 1,
              coordination: { ...current.coordination, nextSequence: current.coordination.nextSequence + 1 }
            },
            value: undefined,
            beforeCommit: async (latest: BuildState) => {
              guardCalled = true;
              expect(readSinceCallback).toBe(true);
              expect(latest.revision).toBe(current.revision);
              throw new Error("late authorization refused");
            }
          };
        })
      ).rejects.toThrow(/late authorization refused/);
      expect(guardCalled).toBe(true);
      expect(await readFile(snapshotPath(), "utf8")).toBe(before);
    });
  });
});

describe("physical workspace receipt history", { timeout: 60000 }, () => {
  it("checks historical reads, edit preconditions and final staging against the chronological private overlay", async () => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const state = await writer.load();
      const grant = reserveBuildScope(
        state,
        { requestId: "history-grant", taskId: "T-A", workerId: "member-a", ownerEpoch: state.ownerEpoch },
        1000,
        () => ({ attemptId: "history-a", token: "history-token" })
      );
      if (grant.result.kind !== "granted") throw new Error("grant");
      await writer.commit(state.revision, grant.state);
      const workspace = new Workspace(writer, { clock: () => 1000 });
      await workspace.freezeInput(grant.result.lease, "history-freeze");
      const before = await workspace.inspect(grant.result.lease, "history-before", "src/normalize.ts");
      await workspace.edit(grant.result.lease, "history-edit", [
        { path: "src/normalize.ts", text: "private", expectedContentHash: before.contentHash }
      ]);
      expect((await workspace.inspect(grant.result.lease, "history-after", "src/normalize.ts")).text).toBe("private");
      await workspace.seal(grant.result.lease, "history-seal");
    });
    const original = await readFile(snapshotPath(), "utf8");
    expect((await store.load()).workspace!.toolReceipts).toHaveLength(5);
    for (const variation of ["historical inspect", "edit precondition", "missing final staging", "early seal"]) {
      const forged = JSON.parse(original);
      if (variation === "historical inspect") {
        const before = forged.workspace.toolReceipts.find(
          (r: { requestId: string }) => r.requestId === "history-before"
        );
        const after = forged.workspace.toolReceipts.find((r: { requestId: string }) => r.requestId === "history-after");
        before.result.text = after.result.text;
        before.result.contentHash = after.result.contentHash;
        before.outputHash = hashBuildValue(before.result);
      } else if (variation === "edit precondition") {
        const edit = forged.workspace.toolReceipts.find((r: { requestId: string }) => r.requestId === "history-edit");
        edit.request.edits[0].expectedContentHash = `sha256:${"a".repeat(64)}`;
        edit.requestHash = hashBuildValue({
          projectKey: forged.projectKey,
          runId: forged.runId,
          planHash: forged.plan.planHash,
          request: edit.request
        });
      } else if (variation === "missing final staging") forged.workspace.staging = [];
      else {
        const seal = forged.workspace.toolReceipts.pop();
        forged.workspace.toolReceipts.splice(1, 0, seal);
      }
      expect(() => parseBuildState(forged)).not.toThrow();
      await writeFile(snapshotPath(), JSON.stringify(forged));
      await expect(store.load()).rejects.toThrow(/historical|staging/);
      await writeFile(snapshotPath(), original);
    }
  });
});

describe("special metadata fails closed", () => {
  it("rejects a real FIFO project marker before acquiring any writer lock or entering the callback", async () => {
    const control = join(root, ".cothink-build");
    await mkdir(control);
    const marker = join(control, "project.json");
    await promisify(execFile)("mkfifo", [marker]);
    let entered = false;
    await expect(
      host().withWriter(async () => {
        entered = true;
      })
    ).rejects.toThrow(/regular file/);
    expect(entered).toBe(false);
    expect(await readdir(control)).toEqual(["project.json"]);
  });
});
