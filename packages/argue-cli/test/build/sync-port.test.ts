import { afterEach, describe, expect, test } from "vitest";
import { LocalBuildSyncAdapter } from "../../src/build/local-sync-adapter.js";
import { exerciseSyncPortContract } from "../../../argue/test/build/sync-port-fixture.js";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createBuildState,
  FrozenBuildPlanSchema,
  freezeBuildPlan,
  hashBuildValue,
  reserveBuildScope,
  advanceBuildOwnerEpoch,
  type BuildCheckGroup,
  type BuildCheckReceipt
} from "@onevcat/argue";
import { FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { Workspace } from "../../src/build/workspace.js";
import type { BuildVerificationCandidate } from "../../src/build/validator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const timeout = 180000;
const H = hashBuildValue("fixed-test-toolchain");
const image = `test/fixture@sha256:${"a".repeat(64)}`;
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-publisher-")));
  roots.push(root);
  const source = join(root, "input"),
    managed = join(root, "managed");
  await mkdir(managed);
  await cp(resolve("../../examples/todo-stats"), source, { recursive: true });
  const { planHash: _old, ...raw } = FrozenBuildPlanSchema.parse(
    JSON.parse(await readFile(join(source, "build-plan.json"), "utf8"))
  );
  void _old;
  const paths = ["SPEC.md", "src/normalize.ts", "src/report.ts"];
  const plan = freezeBuildPlan({
    ...raw,
    manifest: raw.manifest.filter((f) => paths.includes(f.path)),
    tasks: raw.tasks.map((t) => ({
      ...t,
      scope: { read: t.scope.read.filter((p) => paths.includes(p)), write: t.scope.write }
    }))
  });
  let now = 1000,
    n = 0;
  const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock: () => now });
  const reserve = (w: FileBuildWriter, taskId: string, workerId: "member-a" | "member-b") =>
    w.transaction(async (s) => {
      const t = reserveBuildScope(
        s,
        { taskId, workerId, requestId: `reserve-${++n}`, ownerEpoch: s.ownerEpoch },
        now,
        () => ({ attemptId: `attempt-${n}`, token: `token-${n}` })
      );
      if (t.result.kind !== "granted") throw new Error("not granted");
      return { state: t.state, value: t.result.lease };
    });
  const initialize = async (w: FileBuildWriter) => {
    await w.gitFor(plan).initialize();
    const version = await w.git.importSource(source);
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
        runId: "publisher-test",
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
      })
    );
    return version;
  };
  return {
    root,
    source,
    managed,
    store,
    reserve,
    initialize,
    clock: () => now,
    setNow: (v: number) => {
      now = v;
    }
  };
}
/** Trusted test adapter for publication/CAS behavior only. This is never Docker/isolation evidence. */
class ScriptedVerifier {
  constructor(private readonly writer: FileBuildWriter) {}
  checks = 0;
  descriptors = 0;
  checksSalt = "fixed";
  passed = true;
  hook: (() => Promise<void>) | undefined;
  mutate: ((receipt: Record<string, unknown>) => void) | undefined;
  private receipts = new WeakSet<object>();
  async describe(groups: readonly BuildCheckGroup[]) {
    this.descriptors++;
    return {
      groups: [...groups],
      checksHash: hashBuildValue({ groups, salt: this.checksSalt }),
      toolchainHash: H,
      isolationHash: H,
      imageDigest: image
    };
  }
  ownsReceipt(r: object) {
    return this.receipts.has(r);
  }
  async check(candidate: BuildVerificationCandidate, definition: Awaited<ReturnType<ScriptedVerifier["describe"]>>) {
    this.checks++;
    await this.hook?.();
    const files = await this.writer.git.readFiles(candidate.version);
    const sourceHash = hashBuildValue(
      Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, file]) => ({ path, contentHash: file.contentHash }))
    );
    const receipt = {
      ...candidate,
      ...definition,
      checkVersion: "build-check-v1",
      receiptId: `check-${this.checks}`,
      sourceHashBefore: sourceHash,
      sourceHashAfter: sourceHash,
      exitCode: this.passed ? 0 : 1,
      passed: this.passed
    };
    this.mutate?.(receipt);
    this.receipts.add(receipt);
    return receipt as BuildCheckReceipt;
  }
}
async function frozen(
  h: Awaited<ReturnType<typeof setup>>,
  w: FileBuildWriter,
  task: string,
  worker: "member-a" | "member-b"
) {
  const lease = await h.reserve(w, task, worker);
  const gateway = new Workspace(w, { clock: h.clock });
  await gateway.freezeInput(lease, `freeze-${lease.attemptId}`);
  return { lease, gateway };
}

describe("local sync ports on real disk/Git; scripted verifier is not isolation evidence", () => {
  test(
    "same contract as the memory backend",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const lease = await h.reserve(w, "T-A", "member-a");
        const verifier = new ScriptedVerifier(w);
        const adapter = new LocalBuildSyncAdapter(w, verifier, { clock: h.clock });
        await exerciseSyncPortContract({ ports: adapter.ports, lease, load: () => w.load() });
        expect(verifier.checks).toBe(2); // standalone observation plus fresh publication check.
      });
    },
    timeout
  );
  test(
    "standalone checks reject unknown, old, changed and forged evidence without metadata writes",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const { lease, gateway } = await frozen(h, w, "T-A", "member-a");
        const candidate = await gateway.seal(lease, "seal-a");
        const verifier = new ScriptedVerifier(w);
        const ports = new LocalBuildSyncAdapter(w, verifier, { clock: h.clock }).ports;
        const before = await w.load();
        for (const candidateHash of [hashBuildValue("wrong")])
          await expect(
            ports.verifier.check({ requestId: "unknown", lease, candidate: { ...candidate, candidateHash } })
          ).rejects.toThrow();
        for (const field of ["candidateHash", "version", "baseVersion", "planHash", "sourceHashAfter", "checksHash"]) {
          verifier.mutate = (r) => {
            r[field] = field === "version" || field === "baseVersion" ? "f".repeat(40) : hashBuildValue("wrong");
          };
          await expect(ports.verifier.check({ requestId: `bad-${field}`, lease, candidate })).rejects.toThrow();
          expect(await w.load()).toEqual(before);
        }
        verifier.mutate = undefined;
        const produced = verifier.check.bind(verifier);
        verifier.check = async (c, d) => ({ ...(await produced(c, d)) });
        await expect(ports.verifier.check({ requestId: "copied", lease, candidate })).rejects.toThrow(
          "program produced"
        );
        expect(await w.load()).toEqual(before);
      });
    },
    timeout
  );
  test(
    "failed observations are honest, cached read-only and never become publication authority",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        const base = await h.initialize(w);
        const { lease, gateway } = await frozen(h, w, "T-A", "member-a");
        const candidate = await gateway.seal(lease, "seal-a");
        const verifier = new ScriptedVerifier(w);
        verifier.passed = false;
        const ports = new LocalBuildSyncAdapter(w, verifier, { clock: h.clock }).ports;
        const request = { requestId: "failed-observation", lease, candidate };
        const before = await w.load();
        const result = await ports.verifier.check(request);
        expect(result.receipt.passed).toBe(false);
        expect(await ports.verifier.check(request)).toEqual(result);
        expect(verifier.checks).toBe(1);
        expect(await w.load()).toEqual(before);
        await expect(ports.publisher.finish(lease, "failed-publication")).rejects.toThrow();
        expect((await w.load()).acceptedVersion).toBe(base);
        expect(verifier.checks).toBe(2);
        await expect(ports.publisher.finish(lease, request.requestId)).rejects.toThrow("conflict");
      });
    },
    timeout
  );
  test(
    "overlay, owner, deadline and descriptor changes during async checks invalidate proof",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const { lease, gateway } = await frozen(h, w, "T-A", "member-a");
        const candidate = await gateway.seal(lease, "seal-a");
        const verifier = new ScriptedVerifier(w);
        const ports = new LocalBuildSyncAdapter(w, verifier, { clock: h.clock }).ports;
        verifier.hook = async () => {
          verifier.checksSalt = "changed";
        };
        await expect(ports.verifier.check({ requestId: "descriptor-change", lease, candidate })).rejects.toThrow(
          "basis changed"
        );
        verifier.hook = async () => {
          h.setNow(901000);
        };
        await expect(ports.verifier.check({ requestId: "deadline-change", lease, candidate })).rejects.toThrow(
          "deadline"
        );
        h.setNow(1000);
        verifier.hook = async () => {
          const read = await gateway.inspect(lease, "inspect-after-seal", "src/normalize.ts");
          await gateway.edit(lease, "edit-after-seal", [
            { path: read.path, text: read.text + "\n// changed", expectedContentHash: read.contentHash }
          ]);
        };
        await expect(ports.verifier.check({ requestId: "overlay-change", lease, candidate })).rejects.toThrow("stale");
        const updated = await gateway.seal(lease, "seal-updated");
        verifier.hook = async () => {
          await w.transaction(async (s) => ({
            state: advanceBuildOwnerEpoch(s, { ownerEpoch: s.ownerEpoch }, "handoff", h.clock()).state,
            value: null
          }));
        };
        await expect(ports.verifier.check({ requestId: "owner-change", lease, candidate: updated })).rejects.toThrow();
        expect((await w.load()).publishReceipts).toEqual([]);
      });
    },
    timeout
  );
});
