import { expect, test } from "vitest";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_CHECK_GROUPS,
  createBuildState,
  FrozenBuildPlanSchema,
  reserveBuildScope,
  type BuildCheckReceipt,
  type BuildLease
} from "@onevcat/argue";
import { FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { Publisher } from "../../src/build/publisher.js";
import { exportAcceptedVersion, recoverBuild } from "../../src/build/recovery.js";
import { DockerVerifier } from "../../src/build/validator.js";
import { Workspace } from "../../src/build/workspace.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceRoot = resolve(repo, "../work/construction-stage3/docker-acceptance");

// No model or verifier double participates in this test. These are explicitly
// host-prepared oracle fixtures, not an Agent construction/performance result.
async function oracleFixture(source: string, name: "correct-state" | "correct-report" | "correct-final") {
  return (await readFile(join(source, `test/oracle/${name}.ts`), "utf8")).replaceAll(
    "../../src/types.js",
    "./types.js"
  );
}

test("real Docker Publisher gate: rejection, atomic faults, full publication and replay", async () => {
  const image = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
  const evidence: Record<string, unknown> = {
    gate: "construction-stage3-real-publisher",
    executedAt: new Date().toISOString(),
    status: "NOT VERIFIED",
    modelCalls: 0,
    fixtureKind: "host-prepared test/oracle/correct-state.ts, correct-report.ts, correct-final.ts",
    checks: [] as BuildCheckReceipt[],
    events: [] as string[]
  };
  const save = async () => {
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, image ? "real-publisher.json" : "real-publisher-unavailable.json"),
      JSON.stringify(evidence, null, 2) + "\n"
    );
  };
  const record = async (event: string) => {
    (evidence.events as string[]).push(event);
    console.log(JSON.stringify({ gate: evidence.gate, event }));
    await save();
  };
  if (!image) {
    evidence.reason = "COTHINK_BUILD_VALIDATOR_IMAGE not supplied; real Publisher acceptance NOT VERIFIED";
    await save();
    console.warn(JSON.stringify(evidence));
    return;
  }
  // A supplied immutable image requires the real gate to pass. Missing Docker,
  // image/toolchain mismatch or any failed oracle is a test failure, never a skip.
  evidence.requestedImage = image;
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-real-publisher-")));
  const source = join(root, "source");
  const managed = join(root, "managed");
  const clock = () => 1000; // No wall-clock sleeps or accidental lease expiration.
  try {
    await cp(join(repo, "examples/todo-stats"), source, {
      recursive: true,
      filter: (path) => !path.includes("node_modules")
    });
    await mkdir(managed);
    const plan = FrozenBuildPlanSchema.parse(JSON.parse(await readFile(join(source, "build-plan.json"), "utf8")));
    expect(plan.manifest).toHaveLength(11);
    const original = await Promise.all(
      plan.manifest.map(async ({ path }) => [path, await readFile(join(source, path), "utf8")] as const)
    );
    evidence.planHash = plan.planHash;
    evidence.manifestFiles = plan.manifest.map(({ path }) => path);
    const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock });
    await store.withWriter(async (writer) => {
      // Git objects are written only inside this fresh managed temporary fixture.
      // The full frozen input above has been inspected; the source checkout is
      // neither initialized nor staged. Immutable Git objects preserve each view.
      const git = writer.gitFor(plan);
      await git.initialize();
      const v0 = await git.importSource(source);
      await writer.commit(
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
          runId: "real-publisher-oracle",
          revision: 0,
          ownerEpoch: 1,
          plan,
          acceptedVersion: v0,
          status: "active",
          startedAt: clock(),
          deadlineAt: clock() + plan.budget.runTimeoutMs,
          acceptedTasks: [],
          waiting: [],
          attempts: [],
          calls: [],
          actionReceipts: [],
          checkReceipts: [],
          publishReceipts: []
        })
      );
      const workspace = new Workspace(writer, { clock });
      let reservations = 0;
      const reserve = async (taskId: string, workerId: "member-a" | "member-b") => {
        const number = ++reservations;
        const lease = await writer.transaction(async (state) => {
          const transition = reserveBuildScope(
            state,
            { taskId, workerId, requestId: `real-reserve-${number}`, ownerEpoch: state.ownerEpoch },
            clock(),
            () => ({ attemptId: `real-attempt-${number}`, token: `real-token-${number}` })
          );
          if (transition.result.kind !== "granted") throw new Error("Host fixture scope was not granted");
          return { state: transition.state, value: transition.result.lease };
        });
        await workspace.freezeInput(lease, `real-freeze-${number}`);
        return lease;
      };
      const prepare = async (lease: BuildLease, path: string, fixture: Parameters<typeof oracleFixture>[1]) => {
        const observed = await workspace.inspect(lease, `read-${fixture}`, path);
        const text = await oracleFixture(source, fixture);
        await workspace.edit(lease, `edit-${fixture}`, [{ path, text, expectedContentHash: observed.contentHash }]);
        return { observed, text };
      };
      const verifier = new DockerVerifier(writer, { image, repoRoot: repo });
      const actualCheck = verifier.check.bind(verifier);
      let checkCount = 0;
      let afterActualCheck: (() => Promise<void>) | undefined;
      // Instrument this instance, always delegate to the real Docker implementation
      // and return its exact receipt object (preserving ownsReceipt authority).
      verifier.check = async (...args) => {
        checkCount++;
        const receipt = await actualCheck(...args);
        (evidence.checks as BuildCheckReceipt[]).push(receipt);
        await save();
        await afterActualCheck?.();
        return receipt;
      };
      const publisher = new Publisher(writer, verifier, { clock });
      const a = await reserve("T-A", "member-a");
      const b1 = await reserve("T-B1", "member-b");
      const unchanged = async (w: FileBuildWriter) => {
        const state = await w.load();
        expect(state.acceptedVersion).toBe(v0);
        expect(state.acceptedTasks).toEqual([]);
        expect(state.checkReceipts).toEqual([]);
        expect(state.publishReceipts).toEqual([]);
      };
      await expect(publisher.finish(a, "real-v0-rejected")).rejects.toThrow("evidence rejected");
      expect((evidence.checks as BuildCheckReceipt[]).at(-1)?.passed).toBe(false);
      await unchanged(writer);
      await record("V0 T-A failed the actual state-format oracle; no acceptance");

      const preparedA = await prepare(a, "src/normalize.ts", "correct-state");
      const preparedB1 = await prepare(b1, "src/report.ts", "correct-report");
      expect((await writer.load()).attempts.find((attempt) => attempt.attemptId === b1.attemptId)?.baseVersion).toBe(
        v0
      );
      await record("T-A and T-B1 independently frozen/prepared against V0 using host oracle fixtures");
      for (const boundary of ["afterCheck", "beforeCAS"] as const) {
        const before = checkCount;
        const faulted = new Publisher(writer, verifier, {
          clock,
          [boundary]: async () => {
            throw new Error(`real-fault-${boundary}`);
          }
        });
        await expect(faulted.finish(a, `real-fault-${boundary}`)).rejects.toThrow(`real-fault-${boundary}`);
        expect(checkCount).toBe(before + 1);
        expect((evidence.checks as BuildCheckReceipt[]).at(-1)?.passed).toBe(true);
        await unchanged(writer);
        await record(`${boundary}: actual passing Docker check followed by fault; no acceptance`);
      }
      afterActualCheck = async () => {
        afterActualCheck = undefined;
        const currentB1 = await workspace.inspect(b1, "read-concurrent-b1", "src/report.ts");
        preparedB1.text += "\n// Host-prepared private edit during T-A publication validation.\n";
        await workspace.edit(b1, "edit-concurrent-b1", [
          { path: "src/report.ts", text: preparedB1.text, expectedContentHash: currentB1.contentHash }
        ]);
      };
      const acceptedA = await publisher.finish(a, "real-accept-a");
      expect((await workspace.inspect(b1, "read-preserved-b1", "src/report.ts")).text).toBe(preparedB1.text);
      const afterA = await writer.load();
      expect(afterA.acceptedTasks).toEqual(["T-A"]);
      expect(afterA.checkReceipts[0]?.groups).toEqual(["common", "state-format"]);
      expect((await git.readFile(afterA.acceptedVersion, "src/normalize.ts")).text).toBe(preparedA.text);
      expect(afterA.workspace?.staging.find((overlay) => overlay.attemptId === b1.attemptId)?.files[0]?.path).toBe(
        "src/report.ts"
      );
      expect(afterA.workspace?.toolReceipts.some((receipt) => receipt.requestId === "edit-concurrent-b1")).toBe(true);
      const beforeReplay = checkCount;
      const replayA = await publisher.finish(a, "real-accept-a");
      expect(replayA).toEqual(acceptedA);
      expect(checkCount).toBe(beforeReplay);
      expect((await writer.load()).revision).toBe(afterA.revision);
      await record(
        "T-A accepted preserving concurrent private B1 edit/history; completed replay performs zero additional Docker checks or metadata commits"
      );

      const target = join(root, "export");
      let exportCalls = 0;
      const exporter = new Publisher(writer, verifier, {
        clock,
        exportVersion: async (w, input) => {
          exportCalls++;
          return exportAcceptedVersion(w, input, {
            beforeParentSync: async () => {
              throw new Error("real-export-parent-sync-fault");
            }
          });
        }
      });
      const acceptedB1 = await exporter.finish(b1, "real-accept-b1", { exportTarget: target });
      expect(acceptedB1.export).toEqual({ status: "failed", error: "real-export-parent-sync-fault" });
      const afterB1 = await writer.load();
      expect(afterB1.acceptedTasks).toEqual(["T-A", "T-B1"]);
      expect(afterB1.checkReceipts[1]?.groups).toEqual(["common", "state-format", "report"]);
      expect(acceptedB1.receipt.baseVersion).toBe(acceptedA.receipt.acceptedVersion);
      expect((await git.readFile(afterB1.acceptedVersion, "src/normalize.ts")).text).toBe(preparedA.text);
      expect((await git.readFile(afterB1.acceptedVersion, "src/report.ts")).text).toBe(preparedB1.text);
      const beforeExportReplay = checkCount;
      expect((await exporter.finish(b1, "real-accept-b1", { exportTarget: target })).receipt).toEqual(
        acceptedB1.receipt
      );
      expect(exportCalls).toBe(1);
      expect(checkCount).toBe(beforeExportReplay);
      expect(await exportAcceptedVersion(writer, { version: afterB1.acceptedVersion, target })).toMatchObject({
        status: "exported",
        version: afterB1.acceptedVersion,
        directory: target
      });
      for (const { path } of plan.manifest)
        expect(await readFile(join(target, path), "utf8")).toBe(
          (await git.readFile(afterB1.acceptedVersion, path)).text
        );
      expect((await writer.load()).revision).toBe(afterB1.revision);
      await record(
        "T-B1 passed accepted T-A regressions; export after-rename fault preserved acceptance and same-target recovery"
      );

      const b2 = await reserve("T-B2", "member-b");
      const preparedB2 = await prepare(b2, "src/normalize.ts", "correct-final");
      expect(preparedB2.observed.text).toBe(preparedA.text);
      const acceptedFinal = await publisher.finish(b2, "real-accept-b2");
      const final = await writer.load();
      expect(final.acceptedTasks).toEqual(["T-A", "T-B1", "T-B2"]);
      expect(final.checkReceipts[2]?.groups).toEqual([...BUILD_CHECK_GROUPS]);
      expect(
        final.checkReceipts.every((check) => check.passed && check.sourceHashBefore === check.sourceHashAfter)
      ).toBe(true);
      expect(acceptedFinal.receipt.baseVersion).toBe(afterB1.acceptedVersion);
      expect((await git.readFile(final.acceptedVersion, "src/normalize.ts")).text).toBe(preparedB2.text);
      expect((await git.readFile(final.acceptedVersion, "src/report.ts")).text).toBe(preparedB1.text);
      expect(final.calls).toEqual([]);
      const beforeRecovery = checkCount;
      const recovered = await recoverBuild(writer);
      expect(recovered.acceptedVersion).toBe(final.acceptedVersion);
      expect(recovered.publishReceipts).toEqual(final.publishReceipts);
      expect(recovered.modelCalls).toBe(0);
      expect(checkCount).toBe(beforeRecovery);
      for (const [path, text] of original) expect(await readFile(join(source, path), "utf8")).toBe(text);
      evidence.imageDigest = final.checkReceipts[2]!.imageDigest;
      evidence.acceptedTasks = final.acceptedTasks;
      evidence.publishReceipts = final.publishReceipts;
      evidence.acceptedCheckReceipts = final.checkReceipts;
      evidence.checkCount = checkCount;
      evidence.finalCliOracle = {
        source: "examples/todo-stats/test/final.test.ts: joint CLI produces 4/1/2/1 with trimmed normalized titles",
        expectedStdout: "total: 4\npending: 1\ndone: 2\ncancelled: 1\n",
        evidence: "actual passing final-group receipt; frozen host oracle asserts CLI output via Docker data bridge"
      };
      evidence.status = "VERIFIED";
      await record(
        "T-B2 consumed latest normalize; all 5 real Docker groups passed including final CLI 4/1/2/1; zero-call recovery preserved receipts"
      );
    });
  } catch (error) {
    evidence.status = "FAILED";
    evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    await save();
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 1200000);
