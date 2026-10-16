import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freezeBuildPlan,
  hashBuildValue,
  parseBuildState,
  reserveBuildScope,
  type AgentSyncService,
  type AgentSyncWorkerClient,
  type BuildLease
} from "@onevcat/argue/agent-sync";
import { planInput } from "../../../argue/test/build/fixtures.js";
import { FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { LocalAgentSync } from "../../src/agent-sync/local.js";
import { initializeAgentSyncProject } from "../../src/agent-sync/initialize.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// Deliberately nonexistent: initialization, recovery, diff and export must never invoke Docker.
const image = `sha256:${"a".repeat(64)}`;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-local-sync-")));
  roots.push(root);
  const source = join(root, "input"),
    managed = join(root, "managed");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(managed);
  await writeFile(join(source, "SPEC.md"), "spec");
  await writeFile(join(source, "src/normalize.ts"), "v0");
  await writeFile(join(source, "src/report.ts"), "total");
  const plan = freezeBuildPlan(planInput());
  const options = { workspaceRoot: managed, sourceRoot: source, plan, runId: "local-test", image, clock: () => 1000 };
  const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock: options.clock });
  const bytes = () => readFile(join(managed, ".cothink-build/state/todo-stats/session.json"));
  return { root, source, managed, plan, options, store, bytes, host: new LocalAgentSync(options) };
}
async function grant(client: AgentSyncWorkerClient, task: string, id: string): Promise<BuildLease> {
  const result = await client.requestScope(task, id);
  if (result.kind !== "granted") throw new Error(`Expected grant, got ${result.kind}`);
  return result.lease;
}
// Trusted legacy history fixture only: real immutable Git objects and durable metadata,
// deliberately not a publication/verifier/isolation proof.
async function acceptFixture(writer: FileBuildWriter, taskId: "T-A" | "T-B1", text: string) {
  const current = await writer.load();
  const path = taskId === "T-A" ? "src/normalize.ts" : "src/report.ts";
  const blob = await writer.git.writeBlob(text);
  const candidate = await writer.git.createSnapshot(current.acceptedVersion, [{ path, ...blob }]);
  await writer.transaction(async (state) => {
    const result = reserveBuildScope(
      state,
      {
        ownerEpoch: state.ownerEpoch,
        taskId,
        workerId: taskId === "T-A" ? "member-a" : "member-b",
        requestId: `seed-${taskId}`
      },
      1000,
      () => ({ attemptId: `seed-attempt-${taskId}`, token: `seed-token-${taskId}` })
    );
    if (result.result.kind !== "granted") throw new Error("fixture grant failed");
    const attemptId = result.result.lease.attemptId,
      checksHash = hashBuildValue("trusted legacy fixture");
    return {
      state: parseBuildState({
        ...result.state,
        acceptedVersion: candidate.version,
        acceptedTasks: [...state.acceptedTasks, taskId],
        attempts: result.state.attempts.map((a) => (a.attemptId === attemptId ? { ...a, status: "completed" } : a)),
        coordination: {
          ...result.state.coordination,
          taskStates: { ...result.state.coordination.taskStates, [taskId]: "completed" },
          locks: result.state.coordination.locks.filter((l) => l.attemptId !== attemptId)
        },
        checkReceipts: [
          ...state.checkReceipts,
          {
            checkVersion: "build-check-v1",
            receiptId: `check-${taskId}`,
            attemptId,
            candidateHash: candidate.candidateHash,
            checksHash,
            groups: ["common"],
            toolchainHash: hashBuildValue("toolchain"),
            isolationHash: hashBuildValue("fixture only"),
            exitCode: 0,
            passed: true
          }
        ],
        publishReceipts: [
          ...state.publishReceipts,
          {
            publishVersion: "build-publish-v1",
            receiptId: `publish-${taskId}`,
            requestId: `publish-request-${taskId}`,
            attemptId,
            checkReceiptId: `check-${taskId}`,
            baseVersion: state.acceptedVersion,
            acceptedVersion: candidate.version,
            candidateHash: candidate.candidateHash,
            checksHash
          }
        ]
      }),
      value: undefined
    };
  });
  return candidate.version;
}

describe("LocalAgentSync real disk/Git composition; no Docker proof", { timeout: 120000 }, () => {
  test("initializes once, reopens without source, and enforces frozen run/plan identity", async () => {
    const h = await fixture();
    const initial = await h.host.withSession(async (service) => {
      const status = await service.status();
      expect(await service.diff()).toEqual({
        fromVersion: status.acceptedVersion,
        toVersion: status.acceptedVersion,
        files: []
      });
      return status;
    });
    expect(await readFile(join(h.source, "src/normalize.ts"), "utf8")).toBe("v0");
    const state = await h.store.load();
    expect(state).toMatchObject({
      ownerEpoch: 1,
      revision: 0,
      startedAt: 1000,
      deadlineAt: 2701000,
      attempts: [],
      calls: []
    });
    await writeFile(join(h.source, "src/normalize.ts"), "source changed after import");
    const reopened = new LocalAgentSync({ ...h.options, sourceRoot: undefined });
    expect((await reopened.withSession((s) => s.status())).acceptedVersion).toBe(initial.acceptedVersion);
    expect(await readFile(join(h.source, "src/normalize.ts"), "utf8")).toBe("source changed after import");
    await expect(
      new LocalAgentSync({ ...h.options, runId: "different" }).withSession((s) => s.status())
    ).rejects.toThrow(/identity mismatch/);
    const raw = planInput();
    const changed = freezeBuildPlan({ ...raw, budget: { ...raw.budget, maxCalls: 35 } });
    await expect(new LocalAgentSync({ ...h.options, plan: changed }).withSession((s) => s.status())).rejects.toThrow(
      /identity mismatch/
    );
  });
  test("requires initial source and rejects mutable image references before filesystem side effects", async () => {
    const h = await fixture();
    expect(() => new LocalAgentSync({ ...h.options, image: "latest" })).toThrow("BUILD_IMAGE_DIGEST");
    await expect(readFile(join(h.managed, ".cothink-build/project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      new LocalAgentSync({ ...h.options, sourceRoot: undefined }).withSession((s) => s.status())
    ).rejects.toThrow("Build source is required for initial import");
  });
  test("holds one owner for independent clients, retains waiting, and closes escaped capabilities", async () => {
    const h = await fixture();
    let escaped: AgentSyncService | undefined, client: AgentSyncWorkerClient | undefined;
    await h.host.withSession(async (service) => {
      escaped = service;
      const a = service.forWorker("member-a"),
        b = service.forWorker("member-b");
      client = a;
      const lease = await grant(a, "T-A", "reserve-a");
      expect((await b.requestScope("T-B2", "wait-b")).kind).toBe("waiting");
      expect((await b.requestScope("T-B1", "independent-b")).kind).toBe("granted");
      const state = await h.store.load();
      expect(state.ownerEpoch).toBe(1);
      expect(state.coordination.locks.length).toBeGreaterThan(1);
      expect((await service.status()).waiting.map((t) => t.taskId)).toEqual(["T-B2"]);
      expect(await a.currentLease("T-A")).toEqual(lease);
      expect(await h.store.load()).toEqual(state);
    });
    const before = await h.bytes();
    await expect(escaped!.status()).rejects.toMatchObject({ code: "service_closed" });
    await expect(client!.requestScope("T-A", "escaped")).rejects.toMatchObject({ code: "service_closed" });
    expect(await h.bytes()).toEqual(before);
    await expect(
      h.host.withSession(async () => {
        throw new Error("callback failed");
      })
    ).rejects.toThrow("callback failed");
    await h.host.withSession((s) => s.status());
  });
  test("refuses concurrent sessions, independent second writers and canonical aliases without stealing ownership", async () => {
    const h = await fixture();
    await h.host.withSession(async (service) => {
      const before = await h.bytes();
      await expect(h.host.withSession((s) => s.status())).rejects.toThrow();
      await expect(new LocalAgentSync(h.options).withSession((s) => s.status())).rejects.toThrow(/writer lock/);
      const alias = join(h.root, "alias");
      await symlink(h.managed, alias);
      await expect(
        new LocalAgentSync({ ...h.options, workspaceRoot: alias }).withSession((s) => s.status())
      ).rejects.toThrow(/real directory|alias/);
      expect(await h.bytes()).toEqual(before);
      expect((await service.status()).status).toBe("active");
    });
  });
  test("explicit recovery revokes authority without tools/checks, preserves budget and needs a fresh request", async () => {
    const h = await fixture();
    await h.host.withSession(async (service) => {
      const client = service.forWorker("member-a"),
        old = await grant(client, "T-A", "old");
      await client.freezeInput(old, "freeze");
      const before = await h.store.load();
      const recovery = await service.recover("explicit-recover");
      expect(recovery).toMatchObject({ ownerEpoch: 2, replayedActions: 0, status: "paused" });
      const after = await h.store.load();
      expect(after.plan.budget).toEqual(before.plan.budget);
      expect(after.deadlineAt).toBe(before.deadlineAt);
      expect(after.calls).toEqual(before.calls);
      expect(after.workspace).toEqual(before.workspace);
      expect(after.checkReceipts).toEqual([]);
      expect(after.publishReceipts).toEqual([]);
      expect(await client.currentLease("T-A")).toBeNull();
      await expect(client.read(old, "old-read", "SPEC.md")).rejects.toThrow();
      const fresh = await grant(client, "T-A", "fresh");
      expect(fresh.ownerEpoch).toBe(2);
      expect(fresh.attemptId).not.toBe(old.attemptId);
    });
  });
  test("diff reads committed acceptance chain only, sorts changes, and exports complete snapshots without metadata writes", async () => {
    const h = await fixture();
    let base = "",
      first = "",
      second = "",
      retained = "";
    await h.store.withWriter(async (writer) => {
      await initializeAgentSyncProject(writer, h.options);
      base = (await writer.load()).acceptedVersion;
      first = await acceptFixture(writer, "T-A", "accepted normalizer");
      second = await acceptFixture(writer, "T-B1", "accepted report");
      const blob = await writer.git.writeBlob("retained unaccepted");
      retained = (await writer.git.createSnapshot(second, [{ path: "src/report.ts", ...blob }])).version;
    });
    await h.host.withSession(async (service) => {
      const before = await h.bytes();
      expect(await service.diff()).toEqual({
        fromVersion: base,
        toVersion: second,
        files: [
          {
            path: "src/normalize.ts",
            beforeHash: h.plan.manifest.find((f) => f.path === "src/normalize.ts")!.contentHash,
            afterHash: `sha256:32c0e0b71326418ec92883586228f8373d804abe0b8b5903f9055b064ef9940c`
          },
          {
            path: "src/report.ts",
            beforeHash: h.plan.manifest.find((f) => f.path === "src/report.ts")!.contentHash,
            afterHash: `sha256:99a2e8fcf6975033766271cedd7885a4f1bc1dcdd3b716873a446b54227b8a6b`
          }
        ]
      });
      expect((await service.diff({ fromVersion: first })).files.map((f) => f.path)).toEqual(["src/report.ts"]);
      await expect(service.diff({ toVersion: retained })).rejects.toMatchObject({ code: "version_not_accepted" });
      await expect(service.diff({ fromVersion: "0".repeat(40) })).rejects.toThrow();
      const target = join(h.root, "export");
      const exported = await service.exportVersion({ target });
      expect(exported).toEqual({ status: "exported", version: second, directory: target });
      expect(await service.exportVersion({ target })).toEqual(exported);
      expect(await readFile(join(target, "SPEC.md"), "utf8")).toBe("spec");
      expect(await readFile(join(target, "src/normalize.ts"), "utf8")).toBe("accepted normalizer");
      expect(await readFile(join(target, "src/report.ts"), "utf8")).toBe("accepted report");
      await expect(service.exportVersion({ target: join(h.root, "candidate"), version: retained })).rejects.toThrow();
      await expect(service.exportVersion({ target: join(h.managed, ".cothink-build/export") })).rejects.toThrow();
      expect(await h.bytes()).toEqual(before);
      const recovered = await service.recover("accepted-recover");
      expect(recovered.acceptedVersion).toBe(second);
      expect(recovered.tasks.filter((t) => t.status === "completed").map((t) => t.taskId)).toEqual(["T-A", "T-B1"]);
    });
  });
});
