import { afterEach, describe, expect, test } from "vitest";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUILD_CHECK_GROUPS,
  createBuildState,
  FrozenBuildPlanSchema,
  freezeBuildPlan,
  hashBuildValue,
  parseBuildState,
  reserveBuildScope,
  advanceBuildOwnerEpoch,
  type BuildCheckGroup,
  type BuildCheckReceipt
} from "@onevcat/argue";
import { FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { Workspace } from "../../src/build/workspace.js";
import type { BuildVerificationCandidate } from "../../src/build/validator.js";
import { Publisher } from "../../src/build/publisher.js";

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
const options = (h: Awaited<ReturnType<typeof setup>>) => ({ clock: h.clock });
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

describe("publication on real disk/Git; trusted verifier adapter only", () => {
  test(
    "fresh CAS keeps concurrent private edits and call allocations; completed replay does no work",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        const base = await h.initialize(w);
        const a = await frozen(h, w, "T-A", "member-a"),
          b = await frozen(h, w, "T-B1", "member-b");
        const observed = await a.gateway.inspect(a.lease, "read-a", "src/normalize.ts");
        await a.gateway.edit(a.lease, "edit-a", [
          {
            path: "src/normalize.ts",
            text: observed.text + "\n// host-prepared A fixture",
            expectedContentHash: observed.contentHash
          }
        ]);
        const checker = new ScriptedVerifier(w);
        checker.hook = async () => {
          const read = await b.gateway.inspect(b.lease, "read-b", "src/report.ts");
          await b.gateway.edit(b.lease, "edit-b", [
            {
              path: "src/report.ts",
              text: read.text + "\n// concurrent private B",
              expectedContentHash: read.contentHash
            }
          ]);
          await w.transaction(async (s) => ({
            state: parseBuildState({
              ...s,
              revision: s.revision + 1,
              calls: [
                ...s.calls,
                {
                  callId: "call-concurrent",
                  attemptId: b.lease.attemptId,
                  taskId: b.lease.taskId,
                  inputHash: s.attempts.find((x) => x.attemptId === b.lease.attemptId)!.inputHash!,
                  allocatedOutputTokens: 32,
                  reservedAt: h.clock(),
                  deadlineAt: h.clock() + 100,
                  status: "reserved"
                }
              ]
            }),
            value: null
          }));
        };
        const publisher = new Publisher(w, checker, options(h));
        const result = await publisher.finish(a.lease, "publish-a");
        const accepted = await w.load();
        expect(accepted.acceptedVersion).not.toBe(base);
        expect(accepted.acceptedTasks).toEqual(["T-A"]);
        expect(accepted.workspace?.staging.find((x) => x.attemptId === b.lease.attemptId)?.files[0]?.path).toBe(
          "src/report.ts"
        );
        expect(accepted.calls).toHaveLength(1);
        expect(accepted.workspace?.toolReceipts.some((x) => x.requestId === "edit-b")).toBe(true);
        expect(accepted.coordination.locks.some((x) => x.attemptId === a.lease.attemptId)).toBe(false);
        const revision = accepted.revision;
        expect(await publisher.finish(a.lease, "publish-a")).toEqual(result);
        expect(checker.checks).toBe(1);
        expect((await w.load()).revision).toBe(revision);
        await expect(publisher.finish({ ...a.lease, token: "forged" }, "publish-a")).rejects.toThrow("conflict");
        await expect(publisher.finish(a.lease, "new-id")).rejects.toThrow();
        expect(await readFile(join(h.source, "src/normalize.ts"), "utf8")).toBe(observed.text);
      });
    },
    timeout
  );
  test(
    "accepted regression groups and final combination require fresh checks on latest composition",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        await h.initialize(w);
        const a = await frozen(h, w, "T-A", "member-a"),
          b = await frozen(h, w, "T-B1", "member-b");
        const checker = new ScriptedVerifier(w);
        const publisher = new Publisher(w, checker, options(h));
        await Promise.all([publisher.finish(a.lease, "a"), new Publisher(w, checker, options(h)).finish(b.lease, "b")]);
        const b2 = await frozen(h, w, "T-B2", "member-b");
        await publisher.finish(b2.lease, "b2");
        const s = await w.load();
        expect(s.checkReceipts.map((x) => x.groups)).toEqual([
          ["common", "state-format"],
          ["common", "state-format", "report"],
          [...BUILD_CHECK_GROUPS]
        ]);
        expect(checker.checks).toBe(3);
        expect(s.acceptedTasks).toHaveLength(3);
        expect(s.publishReceipts[1]?.baseVersion).toBe(s.publishReceipts[0]?.acceptedVersion);
      });
    },
    timeout
  );
  test(
    "failed or mismatched receipts never accept; changing check basis and cutoff invalidate old evidence",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        const base = await h.initialize(w);
        const a = await frozen(h, w, "T-A", "member-a");
        const checker = new ScriptedVerifier(w);
        const publisher = new Publisher(w, checker, options(h));
        checker.passed = false;
        await expect(publisher.finish(a.lease, "fail")).rejects.toThrow();
        expect(checker.checks).toBe(1);
        checker.passed = true;
        for (const field of [
          "candidateHash",
          "checksHash",
          "toolchainHash",
          "isolationHash",
          "sourceHashAfter",
          "baseVersion",
          "planHash",
          "version",
          "imageDigest"
        ]) {
          checker.mutate = (r) => {
            r[field] =
              field.includes("Version") || field === "version"
                ? "f".repeat(40)
                : field === "imageDigest"
                  ? `other@sha256:${"b".repeat(64)}`
                  : hashBuildValue("wrong");
          };
          await expect(publisher.finish(a.lease, `bad-${field}`)).rejects.toThrow();
          expect((await w.load()).acceptedVersion).toBe(base);
        }
        checker.mutate = undefined;
        checker.hook = async () => {
          checker.checksSalt = "changed";
        };
        await expect(publisher.finish(a.lease, "stale-config")).rejects.toThrow();
        expect((await w.load()).publishReceipts).toEqual([]);
        checker.hook = async () => {
          h.setNow(901000);
        };
        await expect(publisher.finish(a.lease, "deadline")).rejects.toThrow();
        expect((await w.load()).acceptedVersion).toBe(base);
      });
    },
    timeout
  );
  test(
    "candidate/check/pre-CAS faults leave no acceptance; post-CAS and export errors preserve original receipt",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        const base = await h.initialize(w);
        const a = await frozen(h, w, "T-A", "member-a");
        const checker = new ScriptedVerifier(w);
        for (const boundary of ["afterCandidate", "afterCheck", "beforeCAS"]) {
          const publisher = new Publisher(w, checker, {
            ...options(h),
            [boundary]: async () => {
              throw new Error(`fault-${boundary}`);
            }
          });
          await expect(publisher.finish(a.lease, `fault-${boundary}`)).rejects.toThrow(`fault-${boundary}`);
          const s = await w.load();
          expect(s.acceptedVersion).toBe(base);
          expect(s.publishReceipts).toEqual([]);
        }
        const publisher = new Publisher(w, checker, {
          ...options(h),
          afterCAS: async () => {
            throw new Error("fault-afterCAS");
          }
        });
        await expect(publisher.finish(a.lease, "post-CAS")).rejects.toThrow("fault-afterCAS");
        const s = await w.load();
        expect(s.publishReceipts).toHaveLength(1);
        expect(s.acceptedTasks).toEqual(["T-A"]);
        const checks = checker.checks;
        await publisher.finish(a.lease, "post-CAS");
        expect(checker.checks).toBe(checks);
        const b = await frozen(h, w, "T-B1", "member-b");
        let exports = 0;
        const exporter = new Publisher(w, checker, {
          ...options(h),
          exportVersion: async () => {
            exports++;
            throw new Error("export-fault");
          }
        });
        const accepted = await exporter.finish(b.lease, "with-export", { exportTarget: join(h.root, "export") });
        expect(accepted).toMatchObject({ status: "accepted", export: { status: "failed", error: "export-fault" } });
        expect((await w.load()).acceptedTasks).toEqual(["T-A", "T-B1"]);
        await exporter.finish(b.lease, "with-export", { exportTarget: join(h.root, "export") });
        expect(exports).toBe(1);
      });
    },
    timeout
  );
  test(
    "deadline crossed during final evidence recheck rejects the CAS; copied receipts have no authority",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        const base = await h.initialize(w);
        const a = await frozen(h, w, "T-A", "member-a");
        const checker = new ScriptedVerifier(w);
        const original = checker.describe.bind(checker);
        checker.describe = async (groups) => {
          const descriptor = await original(groups);
          if (checker.descriptors === 3) h.setNow(901000);
          return descriptor;
        };
        await expect(new Publisher(w, checker, options(h)).finish(a.lease, "late-final")).rejects.toThrow("deadline");
        expect(checker.descriptors).toBe(3);
        expect((await w.load()).acceptedVersion).toBe(base);
        expect((await w.load()).publishReceipts).toEqual([]);
        h.setNow(1000);
        const produced = checker.check.bind(checker);
        checker.check = async (candidate, definition) => ({ ...(await produced(candidate, definition)) });
        await expect(new Publisher(w, checker, options(h)).finish(a.lease, "copied-receipt")).rejects.toThrow(
          "program produced"
        );
        expect((await w.load()).acceptedTasks).toEqual([]);
      });
    },
    timeout
  );
  test(
    "owner epoch or official baseline changing during check rejects stale proof",
    async () => {
      const h = await setup();
      await h.store.withWriter(async (w) => {
        const base = await h.initialize(w);
        const a = await frozen(h, w, "T-A", "member-a");
        const checker = new ScriptedVerifier(w);
        checker.hook = async () => {
          const blob = await w.git.writeBlob("// known host baseline fixture\n");
          const known = await w.git.createSnapshot(base, [{ path: "src/report.ts", ...blob }]);
          await w.transaction(async (s) => ({
            state: parseBuildState({ ...s, revision: s.revision + 1, acceptedVersion: known.version }),
            value: null
          }));
        };
        await expect(new Publisher(w, checker, options(h)).finish(a.lease, "baseline-change")).rejects.toThrow();
        expect(checker.checks).toBe(1);
        expect((await w.load()).acceptedTasks).toEqual([]);
        checker.hook = async () => {
          await w.transaction(async (s) => ({
            state: advanceBuildOwnerEpoch(s, { ownerEpoch: s.ownerEpoch }, "handoff", h.clock()).state,
            value: null
          }));
        };
        await expect(new Publisher(w, checker, options(h)).finish(a.lease, "epoch-change")).rejects.toThrow();
        expect((await w.load()).publishReceipts).toEqual([]);
      });
    },
    timeout
  );
});
