import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, cp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  FrozenBuildPlanSchema,
  freezeBuildPlan,
  createBuildState,
  reserveBuildScope,
  revokeBuildScope,
  releaseBuildScope,
  scheduleBuildTasks,
  parseBuildState,
  type BuildLease,
  type BuildPlan
} from "@onevcat/argue";
import { FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { Workspace } from "../../src/build/workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
async function setup(twoWrites = false, fullSample = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-workspace-")));
  roots.push(root);
  const source = join(root, "input");
  const managed = join(root, "managed");
  await mkdir(managed);
  await cp(resolve("../../examples/todo-stats"), source, {
    recursive: true,
    filter: (path) => !path.includes("node_modules")
  });
  let plan: BuildPlan = FrozenBuildPlanSchema.parse(
    JSON.parse(await readFile(join(source, "build-plan.json"), "utf8"))
  );
  if (!fullSample) {
    const { planHash: _old, ...raw } = plan;
    void _old;
    const kept = ["SPEC.md", "src/normalize.ts", "src/report.ts"];
    plan = freezeBuildPlan({
      ...raw,
      manifest: raw.manifest.filter((f) => kept.includes(f.path)),
      tasks: raw.tasks.map((t) => ({
        ...t,
        scope: { read: t.scope.read.filter((p) => kept.includes(p)), write: t.scope.write }
      }))
    });
  }
  if (twoWrites) {
    const { planHash: _old, ...raw } = plan;
    void _old;
    plan = freezeBuildPlan({
      ...raw,
      tasks: raw.tasks.map((t) =>
        t.taskId === "T-A" ? { ...t, scope: { ...t.scope, write: ["src/normalize.ts", "src/report.ts"] } } : t
      )
    });
  }
  let now = 1000;
  let allocation = 0;
  const allocate = () => ({ attemptId: `attempt-${++allocation}`, token: `token-${allocation}` });
  const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock: () => now });
  const initial = (version: string) =>
    createBuildState({
      buildSchemaVersion: 1,
      planVersion: "build-plan-v1",
      actionVersion: "build-action-v1",
      budgetVersion: "build-budget-v1",
      checkVersion: "build-check-v1",
      publishVersion: "build-publish-v1",
      resultVersion: "build-result-v1",
      projectKey: plan.projectKey,
      runId: "workspace-test",
      revision: 0,
      ownerEpoch: 1,
      plan,
      acceptedVersion: version,
      status: "active",
      startedAt: now,
      deadlineAt: 2701000,
      acceptedTasks: [],
      waiting: [],
      attempts: [],
      calls: [],
      actionReceipts: [],
      checkReceipts: [],
      publishReceipts: []
    });
  const reserve = async (
    w: FileBuildWriter,
    taskId: string,
    workerId: "member-a" | "member-b",
    id = taskId
  ): Promise<BuildLease> =>
    w.transaction(async (s) => {
      const t = reserveBuildScope(
        s,
        { taskId, workerId, requestId: `reserve-${id}`, ownerEpoch: s.ownerEpoch },
        now,
        allocate
      );
      if (t.result.kind !== "granted") throw new Error(`not granted: ${t.result.kind}`);
      return { state: t.state, value: t.result.lease };
    });
  const bytes = () => readFile(join(managed, ".cothink-build/state", plan.projectKey, "session.json"), "utf8");
  const initialize = async (w: FileBuildWriter) => {
    const git = w.gitFor(plan);
    await git.initialize();
    const version = await git.importSource(source);
    await w.commit(-1, initial(version));
    return version;
  };
  return {
    root,
    source,
    managed,
    plan,
    store,
    clock: () => now,
    setNow: (value: number) => {
      now = value;
    },
    allocate,
    reserve,
    bytes,
    initialize
  };
}
const timeout = 120000;

describe("real controlled workspace", () => {
  test(
    "imports read-only V0; independent private edits never change formal version or original input",
    async () => {
      const h = await setup(false, true);
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      const report = await readFile(join(h.source, "src/report.ts"), "utf8");
      const discussion = join(h.root, "existing-discussion.json");
      await writeFile(discussion, '{"schemaVersion":2,"immutable":"discussion-before"}\n');
      const discussionBefore = await readFile(discussion);
      await h.store.withWriter(async (w) => {
        const version = await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const b = await h.reserve(w, "T-B1", "member-b");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze-a");
        await gateway.freezeInput(b, "freeze-b");
        expect((await gateway.inspect(a, "inspect-a", "src/normalize.ts")).text).toBe(original);
        await Promise.all([
          gateway.edit(a, "edit-a", [
            { path: "src/normalize.ts", text: original + "\n// private A\n", expectedContentHash: sha(original) }
          ]),
          gateway.edit(b, "edit-b", [
            { path: "src/report.ts", text: report + "\n// private B\n", expectedContentHash: sha(report) }
          ])
        ]);
        expect((await gateway.inspect(a, "inspect-a2", "src/normalize.ts")).text).toBe(original + "\n// private A\n");
        expect((await gateway.inspect(b, "inspect-b", "src/report.ts")).text).toBe(report + "\n// private B\n");
        const state = await w.load();
        expect(state.acceptedVersion).toBe(version);
        expect(state.workspace?.staging).toHaveLength(2);
        expect(state.calls).toEqual([]);
        expect((await w.git.readFile(version, "src/normalize.ts")).text).toBe(original);
        expect((await w.git.readFile(version, "src/report.ts")).text).toBe(report);
        expect(await readFile(join(h.source, "src/normalize.ts"), "utf8")).toBe(original);
        expect(await readFile(discussion)).toEqual(discussionBefore);
      });
    },
    timeout
  );
  test(
    "only complete granted scopes freeze input; B1 cannot inspect normalizer",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const b = await h.reserve(w, "T-B1", "member-b");
        await w.transaction(async (s) => {
          const q = reserveBuildScope(
            s,
            { taskId: "T-B2", workerId: "member-b", requestId: "queue-b2", ownerEpoch: 1 },
            h.clock(),
            h.allocate
          );
          expect(q.result.kind).toBe("waiting");
          return { state: q.state, value: null };
        });
        const gateway = new Workspace(w, { clock: h.clock });
        const before = await h.bytes();
        await expect(
          gateway.freezeInput({ ...a, attemptId: "not-granted", taskId: "T-B2", workerId: "member-b" }, "bad-freeze")
        ).rejects.toThrow();
        expect(await h.bytes()).toBe(before);
        await gateway.freezeInput(b, "freeze-b");
        await expect(gateway.inspect(b, "wrong-read", "src/normalize.ts")).rejects.toThrow();
        expect((await w.load()).attempts.find((x) => x.taskId === "T-B2")).toBeUndefined();
      });
    },
    timeout
  );
  test(
    "bad identity, epoch, token, paths and read-only writes reject without altering snapshot",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze");
        const baseline = await h.bytes();
        for (const lease of [
          { ...a, token: "old" },
          { ...a, workerId: "member-b" as const },
          { ...a, leaseEpoch: a.leaseEpoch + 1 },
          { ...a, ownerEpoch: 2 },
          { ...a, taskId: "T-B1" }
        ]) {
          await expect(gateway.inspect(lease, "bad-identity", "src/normalize.ts")).rejects.toThrow();
          expect(await h.bytes()).toBe(baseline);
        }
        for (const path of [
          "/tmp/evil",
          "../src/normalize.ts",
          "src/../normalize.ts",
          "src/Normalize.ts",
          ".cothink-build/project.json",
          "src/report.ts"
        ]) {
          await expect(gateway.inspect(a, "bad-path", path)).rejects.toThrow();
          expect(await h.bytes()).toBe(baseline);
        }
        for (const path of ["SPEC.md", "fixtures/legacy.json", "package.json"]) {
          await expect(
            gateway.edit(a, "readonly", [{ path, text: "overwrite", expectedContentHash: null }])
          ).rejects.toThrow();
          expect(await h.bytes()).toBe(baseline);
        }
      });
    },
    timeout
  );
  test(
    "expected hash is checked against private current content; multi-file failure has no partial visible action",
    async () => {
      const h = await setup(true);
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      const report = await readFile(join(h.source, "src/report.ts"), "utf8");
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze");
        const before = await h.bytes();
        await expect(
          gateway.edit(a, "atomic-bad", [
            { path: "src/normalize.ts", text: "A", expectedContentHash: sha(original) },
            { path: "src/report.ts", text: "B", expectedContentHash: sha("wrong") }
          ])
        ).rejects.toThrow();
        expect(await h.bytes()).toBe(before);
        expect((await gateway.inspect(a, "still-old", "src/normalize.ts")).text).toBe(original);
        await gateway.edit(a, "atomic-good", [
          { path: "src/normalize.ts", text: "A", expectedContentHash: sha(original) },
          { path: "src/report.ts", text: "B", expectedContentHash: sha(report) }
        ]);
        const after = await h.bytes();
        await expect(
          gateway.edit(a, "stale", [
            { path: "src/normalize.ts", text: "old overwrite", expectedContentHash: sha(original) }
          ])
        ).rejects.toThrow();
        expect(await h.bytes()).toBe(after);
        expect((await gateway.inspect(a, "read-a", "src/normalize.ts")).text).toBe("A");
        expect((await gateway.inspect(a, "read-b", "src/report.ts")).text).toBe("B");
      });
    },
    timeout
  );
  test(
    "staging write interruption after first immutable blob leaves snapshot and visible content unchanged",
    async () => {
      const h = await setup(true);
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      const report = await readFile(join(h.source, "src/report.ts"), "utf8");
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const good = new Workspace(w, { clock: h.clock });
        await good.freezeInput(a, "freeze");
        const before = await h.bytes();
        let seen = 0;
        const faulted = new Workspace(w, {
          clock: h.clock,
          beforeBlobWrite: async () => {
            if (++seen === 2) throw new Error("injected staging interruption");
          }
        });
        await expect(
          faulted.edit(a, "interrupted", [
            { path: "src/normalize.ts", text: "unreferenced A", expectedContentHash: sha(original) },
            { path: "src/report.ts", text: "unreferenced B", expectedContentHash: sha(report) }
          ])
        ).rejects.toThrow("interruption");
        expect(seen).toBe(2);
        expect(await h.bytes()).toBe(before);
        expect((await good.inspect(a, "unmodified", "src/normalize.ts")).text).toBe(original);
        expect((await w.load()).workspace?.toolReceipts.some((x) => x.requestId === "interrupted")).toBe(false);
      });
    },
    timeout
  );
  test(
    "deadline advancing during real I/O refuses commit; successful replay never re-executes and changed payload rejects",
    async () => {
      const h = await setup();
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze");
        const request = [{ path: "src/normalize.ts", text: "private text", expectedContentHash: sha(original) }];
        const receipt = await gateway.edit(a, "once", request);
        const snapshot = await h.bytes();
        const replay = new Workspace(w, {
          clock: h.clock,
          beforeBlobWrite: async () => {
            throw new Error("replayed side effect");
          }
        });
        expect(await replay.edit(a, "once", request)).toEqual(receipt);
        expect(await h.bytes()).toBe(snapshot);
        await expect(gateway.edit(a, "once", [{ ...request[0]!, text: "different" }])).rejects.toThrow();
        expect(await h.bytes()).toBe(snapshot);
        const late = new Workspace(w, {
          clock: h.clock,
          beforeCommit: async () => {
            h.setNow(901000);
          }
        });
        await expect(
          late.edit(a, "late", [
            { path: "src/normalize.ts", text: "late overwrite", expectedContentHash: sha("private text") }
          ])
        ).rejects.toThrow();
        expect(await h.bytes()).toBe(snapshot);
      });
    },
    timeout
  );
  test(
    "seal retains immutable candidate only; revoked successful queries work but new requests reject",
    async () => {
      const h = await setup();
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      await h.store.withWriter(async (w) => {
        const version = await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze");
        await gateway.edit(a, "edit", [
          { path: "src/normalize.ts", text: original + "\n// candidate\n", expectedContentHash: sha(original) }
        ]);
        const seal = await gateway.seal(a, "seal");
        expect(seal.version).not.toBe(version);
        expect((await w.git.readFile(seal.version, "src/normalize.ts")).text).toBe(original + "\n// candidate\n");
        expect((await w.load()).acceptedVersion).toBe(version);
        const observed = await gateway.inspect(a, "inspect", "src/normalize.ts");
        await w.transaction(async (s) => {
          const ended = revokeBuildScope(s, a, "revoke", h.clock());
          return { state: ended.state, value: null };
        });
        const snapshot = await h.bytes();
        expect(await gateway.inspect(a, "inspect", "src/normalize.ts")).toEqual(observed);
        expect(await gateway.seal(a, "seal")).toEqual(seal);
        expect(await h.bytes()).toBe(snapshot);
        await expect(gateway.inspect(a, "new-inspect", "src/normalize.ts")).rejects.toThrow();
        await expect(
          gateway.edit(a, "new-edit", [
            { path: "src/normalize.ts", text: "old token", expectedContentHash: sha(original + "\n// candidate\n") }
          ])
        ).rejects.toThrow();
        expect(await h.bytes()).toBe(snapshot);
      });
    },
    timeout
  );
  test(
    "waiting B2 freezes latest known formal snapshot after grant (host fixture, no Publisher)",
    async () => {
      const h = await setup(false, true);
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze-a");
        await w.transaction(async (s) => {
          const wait = reserveBuildScope(
            s,
            { taskId: "T-B2", workerId: "member-b", requestId: "queue-b2", ownerEpoch: s.ownerEpoch },
            h.clock(),
            h.allocate
          );
          expect(wait.result.kind).toBe("waiting");
          return { state: wait.state, value: null };
        });
        const blob = await w.git.writeBlob(original + "\n// known host snapshot\n");
        const known = await w.git.createSnapshot((await w.load()).acceptedVersion, [
          { path: "src/normalize.ts", ...blob }
        ]);
        await w.transaction(async (s) => ({
          state: releaseBuildScope(s, a, "release-a", h.clock()).state,
          value: null
        }));
        // Test setup only: a known immutable commit + consistent host-supplied metadata. Not a publication protocol.
        await w.transaction(async (s) => ({
          state: parseBuildState({ ...s, acceptedVersion: known.version, revision: s.revision + 1 }),
          value: null
        }));
        const leases = await w.transaction(async (s) => {
          const next = scheduleBuildTasks(s, { ownerEpoch: s.ownerEpoch }, h.clock(), h.allocate);
          return { state: next.state, value: next.grants };
        });
        const b = leases[0]!;
        expect(b.taskId).toBe("T-B2");
        const input = await gateway.freezeInput(b, "freeze-b2");
        expect(input.baseVersion).toBe(known.version);
        expect(input.contentHashes["src/normalize.ts"]).toBe(blob.contentHash);
        expect((await gateway.inspect(b, "read-new", "src/normalize.ts")).text).toBe(
          original + "\n// known host snapshot\n"
        );
      });
    },
    timeout
  );
  test(
    "persisted staging survives owner handoff, old lease only queries completed results",
    async () => {
      const h = await setup();
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      let lease: BuildLease | undefined;
      let result: unknown;
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        lease = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(lease, "freeze");
        result = await gateway.edit(lease, "saved", [
          { path: "src/normalize.ts", text: "persisted", expectedContentHash: sha(original) }
        ]);
      });
      h.setNow(1001);
      await h.store.withWriter(async (w) => {
        const state = await w.load();
        expect(state.ownerEpoch).toBe(2);
        expect(state.workspace?.staging[0]?.files[0]?.contentHash).toBe(sha("persisted"));
        const gateway = new Workspace(w, { clock: h.clock });
        expect(
          await gateway.edit(lease!, "saved", [
            { path: "src/normalize.ts", text: "persisted", expectedContentHash: sha(original) }
          ])
        ).toEqual(result);
        await expect(gateway.inspect(lease!, "not-saved", "src/normalize.ts")).rejects.toThrow();
      });
    },
    timeout
  );
  test(
    "missing referenced staging object and corrupt receipt fail recovery rather than becoming success",
    async () => {
      const h = await setup();
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      let blobId = "";
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await h.reserve(w, "T-A", "member-a");
        const gateway = new Workspace(w, { clock: h.clock });
        await gateway.freezeInput(a, "freeze");
        await gateway.edit(a, "edit", [
          { path: "src/normalize.ts", text: "referenced private", expectedContentHash: sha(original) }
        ]);
        blobId = (await w.load()).workspace!.staging[0]!.files[0]!.blobId;
      });
      await rm(join(h.managed, ".cothink-build/git/objects", blobId.slice(0, 2), blobId.slice(2)));
      await expect(h.store.load()).rejects.toThrow();
      await expect(h.store.withWriter(async () => undefined)).rejects.toThrow();
    },
    timeout
  );
});

describe("final commit guard", () => {
  test(
    "deadline crossed during final real asset validation cannot commit an edit",
    async () => {
      const h = await setup();
      const original = await readFile(join(h.source, "src/normalize.ts"), "utf8");
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const lease = await h.reserve(w, "T-A", "member-a");
        const good = new Workspace(w, { clock: h.clock });
        await good.freezeInput(lease, "freeze");
        const before = await h.bytes();
        let finalValidation = false;
        let expired = false;
        const originalRead = w.git.readFiles.bind(w.git);
        w.git.readFiles = async (version) => {
          const view = await originalRead(version);
          if (finalValidation && !expired) {
            expired = true;
            h.setNow(901000);
          }
          return view;
        };
        const gateway = new Workspace(w, {
          clock: h.clock,
          beforeCommit: async () => {
            finalValidation = true;
          }
        });
        await expect(
          gateway.edit(lease, "crossed-during-assets", [
            { path: "src/normalize.ts", text: "must not become visible", expectedContentHash: sha(original) }
          ])
        ).rejects.toThrow();
        expect(expired).toBe(true);
        expect(await h.bytes()).toBe(before);
      });
    },
    timeout
  );
});
