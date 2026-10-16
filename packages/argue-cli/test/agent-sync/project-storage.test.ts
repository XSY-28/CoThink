import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, readdir, symlink, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentSyncState,
  reserveAgentSyncScope,
  validateAgentSyncLease,
  parseAgentSyncState,
  hashJson,
  freezeAgentSyncProject,
  type AgentSyncLease
} from "../../../argue/src/agent-sync/project/index.js";
import { projectState, allocate, control } from "../../../argue/test/agent-sync/project-fixture.js";
import {
  FileAgentSyncStore,
  createAgentSyncSnapshotCodec,
  type FileAgentSyncWriter
} from "../../src/agent-sync/project/storage.js";
import { FileBuildStore, createBuildSnapshotCodec } from "../../src/build/file-store.js";
import { createBuildState } from "../../../argue/src/build/state.js";
import { runInput } from "../../../argue/test/build/fixtures.js";
import { assetFixture, malformedPublication } from "./project-storage-fixture.js";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-storage-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const host = (extra = {}) =>
  new FileAgentSyncStore({ workspaceRoot: root, projectKey: "project", clock: () => 1001, ...extra });
const snapshot = () => join(root, ".agent-sync/state/project/session.json");
async function initialize(count = 3) {
  const store = host();
  const source = join(root, "input");
  await mkdir(source);
  const project = projectState(count).plan;
  await store.withWriter(async (writer) => {
    const git = writer.gitFor(project);
    await git.initialize();
    const acceptedVersion = await git.importSource(source);
    await writer.commit(-1, createAgentSyncState({ project, runId: "run", acceptedVersion, now: 1000 }));
  });
  return store;
}
describe("independent project managed disk and Git", { timeout: 30000 }, () => {
  it.each([1, 2, 3])("persists %i custom members and reopens without the source", async (count) => {
    const store = await initialize(count);
    await rm(join(root, "input"), { recursive: true });
    const initial = await store.load();
    expect(initial.stateVersion).toBe("agent-sync-state-v1");
    expect(initial.plan.memberIds).toHaveLength(count);
    expect(JSON.parse(await readFile(join(root, ".agent-sync/project.json"), "utf8"))).toMatchObject({
      identityVersion: "agent-sync-project-storage-v1",
      controlDirectory: ".agent-sync"
    });
    expect(JSON.parse(await readFile(join(root, ".agent-sync/git-identity.json"), "utf8"))).toMatchObject({
      version: "agent-sync-git-v1"
    });
    await host().withWriter(async (writer) => {
      const current = await writer.load();
      expect(current.ownerEpoch).toBe(2);
      expect(current.deadlineAt).toBe(initial.deadlineAt);
      expect((await writer.git.readFiles(current.acceptedVersion))["shared.ts"].text).toBeNull();
      expect((await writer.load()).ownerEpoch).toBe(2);
    });
    expect(await readdir(root)).toEqual([".agent-sync"]);
  });
  it("revokes prior leases once per reopening and releases writer ownership", async () => {
    await initialize();
    let oldLease: AgentSyncLease;
    let escaped: FileAgentSyncWriter;
    await host().withWriter(async (writer) => {
      escaped = writer;
      await expect(host().withWriter(async () => {})).rejects.toThrow(/held/);
      const current = await writer.load();
      const reserved = reserveAgentSyncScope(
        current,
        { ...control("reserve", 0), ownerEpoch: current.ownerEpoch },
        1001,
        allocate
      );
      if (reserved.result.kind !== "granted") throw new Error("fixture reserve");
      oldLease = reserved.result.lease;
      await writer.commit(current.revision, reserved.state);
    });
    await expect(escaped!.load()).rejects.toThrow(/ended/);
    await host().withWriter(async (writer) => {
      const current = await writer.load();
      expect(current.ownerEpoch).toBe(3);
      expect(validateAgentSyncLease(current, oldLease!, 1001).valid).toBe(false);
    });
  });
  it.each([{ expectedPlanHash: `sha256:${"f".repeat(64)}` }, { expectedRunId: "wrong" }])(
    "rejects expected binding %j before owner advancement",
    async (extra) => {
      await initialize();
      const before = await readFile(snapshot(), "utf8");
      await expect(
        host(extra).withWriter(async () => {
          throw new Error("callback must not run");
        })
      ).rejects.toThrow(/identity mismatch/);
      expect(await readFile(snapshot(), "utf8")).toBe(before);
    }
  );
  it("validates optional expected identity values at construction", () => {
    expect(() => host({ expectedPlanHash: "not-a-hash" })).toThrow();
    expect(() => host({ expectedRunId: "../run" })).toThrow();
  });
  it("keeps strict independent codecs and rejects immutable run/plan changes", async () => {
    const store = await initialize();
    expect(createAgentSyncSnapshotCodec("project").formatName).toBe("agent-sync-project");
    expect(() => createAgentSyncSnapshotCodec("project").parse(createBuildState(runInput()))).toThrow();
    expect(() => createBuildSnapshotCodec("project").parse(projectState())).toThrow();
    await store.withWriter(async (writer) => {
      const current = await writer.load();
      const before = await readFile(snapshot(), "utf8");
      await expect(
        writer.commit(current.revision, { ...current, revision: current.revision + 1, runId: "forged" })
      ).rejects.toThrow(/immutable/);
      expect(() => writer.gitFor(projectState(1).plan)).toThrow(/identity mismatch/);
      expect(await readFile(snapshot(), "utf8")).toBe(before);
    });
  });
  it.each([".cothink-build", ".COTHINK-BUILD", ".AGENT-SYNC"])(
    "refuses existing authority or alias %s before root creation",
    async (name) => {
      await writeFile(join(root, name), "untrusted");
      await expect(host().withWriter(async () => {})).rejects.toThrow(/control|authority|alias/);
      expect(await readdir(root)).toEqual([name]);
    }
  );
  it("refuses the new root from the legacy adapter without creating old metadata", async () => {
    await mkdir(join(root, ".agent-sync"));
    await expect(
      new FileBuildStore({ workspaceRoot: root, projectKey: "project" }).withWriter(async () => {})
    ).rejects.toThrow(/authority/);
    expect(await readdir(root)).toEqual([".agent-sync"]);
  });
  it("preserves the legacy byte-exact commit identity", async () => {
    const source = join(root, "golden-source");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "SPEC.md"), "spec");
    await writeFile(join(source, "src/normalize.ts"), "v0");
    await writeFile(join(source, "src/report.ts"), "total");
    const run = runInput();
    await new FileBuildStore({ workspaceRoot: root, projectKey: run.plan.projectKey }).withWriter(async (writer) => {
      const git = writer.gitFor(run.plan);
      await git.initialize();
      // Independently SHA-1-derived from the frozen legacy tree, author, timestamp and message bytes.
      expect(await git.importSource(source)).toBe("c57069cfec90d67d72dcf0fe8d353aeaf93eeca3");
    });
  });
  it("concurrent initial opens cannot establish two formal authorities", async () => {
    const source = join(root, "race-source");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "SPEC.md"), "spec");
    await writeFile(join(source, "src/normalize.ts"), "v0");
    await writeFile(join(source, "src/report.ts"), "total");
    const results = await Promise.allSettled([
      host().withWriter(async (writer) => {
        const project = projectState().plan;
        const git = writer.gitFor(project);
        await git.initialize();
        const acceptedVersion = await git.importSource(source);
        await writer.commit(-1, createAgentSyncState({ project, runId: "run", acceptedVersion, now: 1000 }));
      }),
      new FileBuildStore({ workspaceRoot: root, projectKey: "todo-stats" }).withWriter(async (writer) => {
        const run = runInput();
        const git = writer.gitFor(run.plan);
        await git.initialize();
        const acceptedVersion = await git.importSource(source);
        await writer.commit(-1, createBuildState({ ...run, acceptedVersion }));
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    const pointers = await Promise.allSettled([
      readFile(snapshot()),
      readFile(join(root, ".cothink-build/state/todo-stats/session.json"))
    ]);
    expect(pointers.filter((result) => result.status === "fulfilled").length).toBeLessThanOrEqual(1);
  });
  it("new project imports real text, enforces read-only paths and source-file safety", async () => {
    const source = join(root, "text-source");
    await mkdir(source);
    const base = projectState(1).plan;
    const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
    const { planHash, ...definition } = base;
    expect(planHash).toBeTruthy();
    const project = freezeAgentSyncProject({
      ...definition,
      manifest: [
        { path: "shared.ts", access: "writable", contentHash: hash("original") },
        { path: "SPEC.md", access: "read-only", contentHash: hash("fixed") }
      ]
    });
    await writeFile(join(source, "SPEC.md"), "fixed");
    await writeFile(join(source, "shared.ts"), "original");
    await host().withWriter(async (writer) => {
      const git = writer.gitFor(project);
      await git.initialize();
      await link(join(source, "shared.ts"), join(source, "extra-link"));
      await expect(git.importSource(source)).rejects.toThrow(/UNSAFE_FILE/);
      await unlink(join(source, "extra-link"));
      const acceptedVersion = await git.importSource(source);
      await writer.commit(-1, createAgentSyncState({ project, runId: "run", acceptedVersion, now: 1000 }));
      expect((await git.readFile(acceptedVersion, "SPEC.md")).text).toBe("fixed");
      const edit = await git.writeBlob("changed");
      await expect(git.createSnapshot(acceptedVersion, [{ path: "SPEC.md", ...edit }])).rejects.toThrow(/READ_ONLY/);
      await expect(git.readFile(acceptedVersion, "Shared.ts")).rejects.toThrow(/UNKNOWN_PATH/);
      await expect(git.writeBlob("bad\0bytes")).rejects.toThrow(/BINARY/);
      await expect(git.writeBlob("bad\ud800")).rejects.toThrow(/UTF8/);
    });
  });
  it("rejects linked control roots and hardlinked or replaced identity metadata", async () => {
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, ".agent-sync"));
    await expect(host().withWriter(async () => {})).rejects.toThrow(/directory|link/);
    await unlink(join(root, ".agent-sync"));
    const store = await initialize();
    const marker = join(root, ".agent-sync/project.json");
    await link(marker, join(root, "marker-link"));
    await expect(store.load()).rejects.toThrow(/single-link/);
    await unlink(join(root, "marker-link"));
    await writeFile(marker, "{}");
    await expect(store.load()).rejects.toThrow(/identity/);
  });
  it("does not accept missing Git objects or use a cached version view", async () => {
    const store = await initialize();
    const state = await store.load();
    const path = join(
      root,
      ".agent-sync/git/objects",
      state.acceptedVersion.slice(0, 2),
      state.acceptedVersion.slice(2)
    );
    await unlink(path);
    await expect(store.load()).rejects.toThrow();
  });
});

describe("project history backed by immutable objects", { timeout: 60000 }, () => {
  it("roundtrips chronological edits, inspections, frozen input and actual candidate/check assets", async () => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const { current, state, candidate } = await assetFixture(writer);
      const check = state.checkReceipts[0]!;
      expect(() =>
        parseAgentSyncState({ ...state, checkReceipts: [{ ...check, checkVersion: "build-check-v1" }] })
      ).toThrow();
      const missingVersion = Object.fromEntries(Object.entries(check).filter(([key]) => key !== "version"));
      expect(() => parseAgentSyncState({ ...state, checkReceipts: [missingVersion] })).toThrow();
      await writer.commit(current.revision, state);
      expect(await writer.load()).toEqual(state);
      expect((await writer.git.readFile(candidate.version, "shared.ts")).text).toBe("first\n");
      expect((await writer.git.readFile(current.acceptedVersion, "shared.ts")).text).toBeNull();
      const before = await readFile(snapshot(), "utf8");
      const changed = {
        ...state,
        revision: state.revision + 1,
        workspace: { ...state.workspace!, toolReceipts: state.workspace!.toolReceipts.slice(0, 1) }
      };
      await expect(writer.commit(state.revision, changed)).rejects.toThrow(/immutable/);
      expect(await readFile(snapshot(), "utf8")).toBe(before);
    });
    expect((await store.load()).workspace!.toolReceipts).toHaveLength(2);
  });
  it.each([
    "inspect-before-edit",
    "stale-edit-precondition",
    "frozen-input",
    "candidate-scope",
    "check-source",
    "missing-blob"
  ] as const)("rejects physically inconsistent %s even when state parser accepts", async (mode) => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const fixture = await assetFixture(writer);
      const { current, state, blob, requests, receipt } = fixture;
      let forged = state;
      if (mode === "inspect-before-edit")
        forged = parseAgentSyncState({
          ...state,
          workspace: { ...state.workspace!, toolReceipts: [...state.workspace!.toolReceipts].reverse() }
        });
      if (mode === "stale-edit-precondition") {
        const edit = state.workspace!.toolReceipts[0]!;
        const badRequest = {
          ...requests.edit,
          edits: [{ ...requests.edit.edits[0]!, expectedContentHash: blob.contentHash }]
        };
        forged = parseAgentSyncState({
          ...state,
          workspace: {
            ...state.workspace!,
            toolReceipts: [receipt(badRequest, edit.result), state.workspace!.toolReceipts[1]!]
          }
        });
      }
      if (mode === "frozen-input") {
        const contentHashes = { "shared.ts": blob.contentHash };
        const inputHash = hashJson({
          planHash: state.plan.planHash,
          attemptId: state.attempts[0]!.attemptId,
          baseVersion: state.acceptedVersion,
          contentHashes
        });
        forged = parseAgentSyncState({ ...state, attempts: [{ ...state.attempts[0]!, contentHashes, inputHash }] });
      }
      if (mode === "candidate-scope") {
        const alien = await writer.git.writeBlob("alien");
        const candidate = await writer.git.createSnapshot(state.acceptedVersion, [{ path: "other.ts", ...alien }]);
        forged = parseAgentSyncState({
          ...state,
          checkReceipts: [],
          workspace: { ...state.workspace!, candidates: [{ ...state.workspace!.candidates[0]!, ...candidate }] }
        });
      }
      if (mode === "check-source")
        forged = parseAgentSyncState({
          ...state,
          checkReceipts: [
            { ...state.checkReceipts[0]!, sourceHashBefore: hashJson("wrong"), sourceHashAfter: hashJson("wrong") }
          ]
        });
      if (mode === "missing-blob")
        await unlink(join(root, ".agent-sync/git/objects", blob.blobId.slice(0, 2), blob.blobId.slice(2)));
      const before = await readFile(snapshot(), "utf8");
      await expect(writer.commit(current.revision, forged)).rejects.toThrow();
      expect(await readFile(snapshot(), "utf8")).toBe(before);
    });
  });
  it("rejects a malformed publication the strict state parser accepts", async () => {
    const store = await initialize();
    await store.withWriter(async (writer) => {
      const { current, state, lease } = await assetFixture(writer);
      const forged = malformedPublication(state, lease);
      expect(forged.attempts[0]!.status).toBe("running");
      const before = await readFile(snapshot(), "utf8");
      await expect(writer.commit(current.revision, forged)).rejects.toThrow(/accepted completed task/);
      expect(await readFile(snapshot(), "utf8")).toBe(before);
      // Fault injection tests load-time rejection too; this is not publication.
      await writeFile(snapshot(), JSON.stringify(forged));
      await expect(writer.load()).rejects.toThrow(/accepted completed task/);
    });
  });
});
