import { expect, test } from "vitest";
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_CHECK_GROUPS,
  BuildDriver,
  createBuildState,
  FrozenBuildPlanSchema,
  type BuildCheckReceipt,
  type BuildSyncPorts,
  type ModelCall,
  type ModelTransport
} from "@onevcat/argue";
import { FileBuildStore } from "../../src/build/file-store.js";
import { LocalBuildSyncAdapter } from "../../src/build/local-sync-adapter.js";
import { DockerVerifier } from "../../src/build/validator.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceRoot = resolve(repo, "../work/construction-stage4/current");
type TaskId = "T-A" | "T-B1" | "T-B2";
type ModelInput = {
  actionVersion: "build-action-v1";
  requestId: string;
  task: { taskId: TaskId; workerId: "member-a" | "member-b"; scope: { read: string[]; write: string[] }; goal: string };
  input: {
    baseVersion: string;
    inputHash: string;
    files: { path: string; text: string | null; contentHash: string | null }[];
  };
};
type CallTrace = {
  taskId: TaskId;
  requestId: string;
  start: number;
  startSequence: number;
  end?: number;
  endSequence?: number;
  paths: string[];
  baseVersion: string;
  normalizeHash: string | null;
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // The first publication may fail before the second worker reaches the barrier.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function waitForBoth(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  let aborted!: () => void;
  const abort = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason ?? new Error("Controlled model request aborted"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    await Promise.race([promise, abort]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
// CONTROLLED RESPONSES: these frozen host oracles exercise the mechanism, not
// model ability. Disk, immutable Git versions, Docker checks and publication are real.
async function oracle(source: string, name: "correct-state" | "correct-report" | "correct-final") {
  return (await readFile(join(source, `test/oracle/${name}.ts`), "utf8")).replaceAll(
    "../../src/types.js",
    "./types.js"
  );
}
const model = (modelId: string): Omit<ModelCall, "messages" | "maxOutputTokens"> => ({
  protocol: "controlled-offline",
  baseUrl: "https://controlled.invalid",
  modelId,
  apiKeyEnv: "COTHINK_CONTROLLED_NO_API_KEY",
  outputMode: "prompt_json",
  generationOptions: {}
});

for (const first of ["T-A", "T-B1"] as const) {
  test(`real local collaboration: ${first} publishes first with overlapping scoped model requests`, async () => {
    const image = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
    const order = first === "T-A" ? "a-first" : "b1-first";
    const stem = `collaboration-${order}${image ? "" : "-unavailable"}`;
    const evidence: Record<string, unknown> = {
      gate: "construction-stage4-real-collaboration",
      order,
      executedAt: new Date().toISOString(),
      status: "NOT VERIFIED",
      fixtureKind: "CONTROLLED RESPONSES from frozen test/oracle files; no real models",
      modelCalls: 0,
      calls: [] as CallTrace[],
      checks: [] as BuildCheckReceipt[],
      events: [] as unknown[]
    };
    await mkdir(evidenceRoot, { recursive: true });
    const save = () => writeFile(join(evidenceRoot, `${stem}.json`), JSON.stringify(evidence, null, 2) + "\n");
    const log = async (message: string) => {
      const line = JSON.stringify({ at: new Date().toISOString(), gate: evidence.gate, order, message });
      console.log(line);
      await appendFile(join(evidenceRoot, `${stem}.log`), line + "\n");
      await save();
    };
    if (!image) {
      evidence.reason = "COTHINK_BUILD_VALIDATOR_IMAGE not supplied; real collaboration NOT VERIFIED";
      await log(String(evidence.reason));
      return;
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), `cothink-collaboration-${order}-`)));
    const source = join(root, "source");
    const managed = join(root, "managed");
    const clock = () => 1000;
    try {
      const phase3 = JSON.parse(
        await readFile(resolve(repo, "../work/construction-stage3/docker-acceptance/image.json"), "utf8")
      ) as {
        imageId: string;
        repoDigests: string[];
      };
      expect([phase3.imageId, ...phase3.repoDigests]).toContain(image);
      evidence.requestedImage = image;
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
      const fixtures = {
        "T-A": await oracle(source, "correct-state"),
        "T-B1": await oracle(source, "correct-report"),
        "T-B2": await oracle(source, "correct-final")
      };
      evidence.planHash = plan.planHash;
      evidence.manifestFiles = plan.manifest.map(({ path }) => path);
      const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock });
      await store.withWriter(async (writer) => {
        // Only this fresh managed fixture receives Git objects; every frozen
        // source file above is preserved, and the development checkout is untouched.
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
            runId: `collaboration-${order}`,
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
        const verifier = new DockerVerifier(writer, { image, repoRoot: repo });
        const actualCheck = verifier.check.bind(verifier);
        verifier.check = async (...args) => {
          const receipt = await actualCheck(...args);
          (evidence.checks as BuildCheckReceipt[]).push(receipt);
          await save();
          return receipt;
        };
        const adapter = new LocalBuildSyncAdapter(writer, verifier, { clock });
        const firstPublished = deferred();
        const bothStarted = deferred();
        const starts = new Set<TaskId>();
        const count: Record<TaskId, number> = { "T-A": 0, "T-B1": 0, "T-B2": 0 };
        const calls = evidence.calls as CallTrace[];
        const publicationOrder: string[] = [];
        const frozen: { taskId: string; baseVersion: string; sequence: number }[] = [];
        let sequence = 0;
        let ids = 0;
        let leases = 0;
        let aPublishedHash: string | null | undefined;
        const ports: BuildSyncPorts = {
          ...adapter.ports,
          workspace: {
            ...adapter.ports.workspace,
            freezeInput: async (lease, requestId) => {
              const result = await adapter.ports.workspace.freezeInput(lease, requestId);
              frozen.push({ taskId: lease.taskId, baseVersion: result.baseVersion, sequence: ++sequence });
              return result;
            },
            inspect: (...args) => adapter.ports.workspace.inspect(...args),
            edit: (...args) => adapter.ports.workspace.edit(...args),
            seal: (...args) => adapter.ports.workspace.seal(...args)
          },
          publisher: {
            finish: async (lease, requestId) => {
              // Sequence only host finish admission. Both workers' actual model
              // calls have already overlapped; no model waits on a Docker check.
              if (lease.taskId !== first && lease.taskId !== "T-B2") await firstPublished.promise;
              try {
                const result = await adapter.ports.publisher.finish(lease, requestId);
                publicationOrder.push(lease.taskId);
                if (lease.taskId === "T-A")
                  aPublishedHash = (await git.readFile(result.receipt.acceptedVersion, "src/normalize.ts")).contentHash;
                if (lease.taskId === first) firstPublished.resolve();
                await log(`actual Docker-backed publication accepted ${lease.taskId}`);
                return result;
              } catch (error) {
                firstPublished.reject(error);
                throw error;
              }
            }
          }
        };
        const transport: ModelTransport = {
          async respond(call, signal) {
            const user = call.messages.find((message) => message.role === "user");
            expect(user).toBeDefined();
            const input = JSON.parse(user!.content) as ModelInput;
            const taskId = input.task.taskId;
            const task = plan.tasks.find((item) => item.taskId === taskId)!;
            expect(input.task.workerId).toBe(task.workerId);
            expect(input.task.scope).toEqual(task.scope);
            const paths = input.input.files.map(({ path }) => path);
            expect([...paths].sort()).toEqual([...task.scope.read, ...task.scope.write].sort());
            expect(new Set(paths).size).toBe(paths.length);
            expect(Object.keys(input).sort()).toEqual(
              count[taskId] === 0
                ? ["actionVersion", "input", "requestId", "task"]
                : ["actionVersion", "input", "previousToolResult", "requestId", "task"]
            );
            const serialized = JSON.stringify(call.messages);
            expect(JSON.stringify(input)).not.toMatch(/"(?:token|leaseEpoch|ownerEpoch|attemptId)"/);
            expect(Object.keys(input.task).sort()).toEqual(["goal", "scope", "taskId", "workerId"]);
            expect(Object.keys(input.input).sort()).toEqual(["baseVersion", "files", "inputHash"]);
            for (const file of input.input.files)
              expect(Object.keys(file).sort()).toEqual(["contentHash", "path", "text"]);
            for (let number = 1; number <= leases; number++)
              expect(serialized).not.toContain(`private-lease-token-${number}`);
            if (taskId === "T-B1") expect(paths).not.toContain("src/normalize.ts");
            const step = count[taskId]++;
            expect(step).toBeLessThan(2);
            expect(call.maxOutputTokens).toBe(plan.budget.maxOutputTokensPerCall);
            const normalizeHash =
              input.input.files.find(({ path }) => path === "src/normalize.ts")?.contentHash ?? null;
            if (taskId === "T-B2" && step === 0) {
              expect(publicationOrder).toContain("T-A");
              expect(normalizeHash).toBe(aPublishedHash);
              expect(input.input.files.find(({ path }) => path === "src/normalize.ts")?.text).toBe(fixtures["T-A"]);
              evidence.b2FirstNormalizeHash = normalizeHash;
              evidence.aPublishedNormalizeHash = aPublishedHash;
            }
            const observed: CallTrace = {
              taskId,
              requestId: input.requestId,
              start: Date.now(),
              startSequence: ++sequence,
              paths,
              baseVersion: input.input.baseVersion,
              normalizeHash
            };
            calls.push(observed);
            evidence.modelCalls = calls.length;
            if (step === 0 && taskId !== "T-B2") {
              starts.add(taskId);
              if (starts.has("T-A") && starts.has("T-B1")) bothStarted.resolve();
              await waitForBoth(bothStarted.promise, signal);
            }
            const path = task.scope.write[0]!;
            const action =
              step === 0
                ? {
                    kind: "edit",
                    path,
                    text: fixtures[taskId],
                    expectedContentHash: input.input.files.find((file) => file.path === path)!.contentHash
                  }
                : { kind: "finish" };
            const payload = { actionVersion: input.actionVersion, requestId: input.requestId, action };
            observed.end = Date.now();
            observed.endSequence = ++sequence;
            await save();
            return {
              rawContent: JSON.stringify(payload),
              payload,
              modelId: call.modelId,
              protocol: call.protocol,
              generationOptions: call.generationOptions,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "stop"
            };
          }
        };
        const driver = new BuildDriver({
          writer,
          ports,
          transport,
          models: { "member-a": model("controlled-a"), "member-b": model("controlled-b") },
          clock,
          allocateLease: () => ({
            attemptId: `collaboration-attempt-${++leases}`,
            token: `private-lease-token-${leases}`
          }),
          nextId: (kind) => `collaboration-${kind}-${++ids}`,
          onEvent: (event) => {
            (evidence.events as unknown[]).push(event);
          }
        });
        const result = await driver.run({ taskOrder: ["T-A", "T-B2", "T-B1"] });
        const final = await writer.load();
        expect(result.status).toBe("completed");
        expect(final.status).toBe("completed");
        const initialReservations = final.coordination.requests
          .filter((request) => request.operation === "reserve")
          .slice(0, 3)
          .map((request) => request.result);
        expect(initialReservations).toMatchObject([
          { kind: "granted", lease: { taskId: "T-A" } },
          {
            kind: "waiting",
            taskId: "T-B2",
            reasons: [{ kind: "lock", paths: ["src/normalize.ts"] }]
          },
          { kind: "granted", lease: { taskId: "T-B1" } }
        ]);
        expect(publicationOrder).toEqual(first === "T-A" ? ["T-A", "T-B1", "T-B2"] : ["T-B1", "T-A", "T-B2"]);
        expect(frozen.map(({ taskId }) => taskId)).toEqual(["T-A", "T-B1", "T-B2"]);
        expect(frozen[0]!.baseVersion).toBe(v0);
        expect(frozen[1]!.baseVersion).toBe(v0);
        const a = calls.find((call) => call.taskId === "T-A")!;
        const b1 = calls.find((call) => call.taskId === "T-B1")!;
        expect(a.startSequence).toBeLessThan(b1.endSequence!);
        expect(b1.startSequence).toBeLessThan(a.endSequence!);
        expect(a.start).toBeLessThanOrEqual(b1.end!);
        expect(b1.start).toBeLessThanOrEqual(a.end!);
        expect(count).toEqual({ "T-A": 2, "T-B1": 2, "T-B2": 2 });
        expect(final.calls).toHaveLength(6);
        expect(final.calls.every((call) => call.status === "succeeded")).toBe(true);
        expect(final.calls.reduce((sum, call) => sum + call.allocatedOutputTokens, 0)).toBe(
          6 * plan.budget.maxOutputTokensPerCall
        );
        expect(final.attempts).toHaveLength(3);
        expect(final.attempts.map((attempt) => attempt.taskId)).toEqual(["T-A", "T-B1", "T-B2"]);
        expect(final.checkReceipts).toHaveLength(3);
        expect(final.checkReceipts.at(-1)!.groups).toEqual([...BUILD_CHECK_GROUPS]);
        expect(
          final.checkReceipts.every((check) => check.passed && check.sourceHashBefore === check.sourceHashAfter)
        ).toBe(true);
        expect((await git.readFile(final.acceptedVersion, "src/normalize.ts")).text).toBe(fixtures["T-B2"]);
        expect((await git.readFile(final.acceptedVersion, "src/report.ts")).text).toBe(fixtures["T-B1"]);
        // Every published version, including the second disjoint merge, retains
        // all prior task edits; the final version is more than a terminal flag.
        const second = final.publishReceipts[1]!;
        expect((await git.readFile(second.acceptedVersion, "src/normalize.ts")).text).toBe(fixtures["T-A"]);
        expect((await git.readFile(second.acceptedVersion, "src/report.ts")).text).toBe(fixtures["T-B1"]);
        const beforeRecovery = calls.length;
        const beforeChecks = (evidence.checks as BuildCheckReceipt[]).length;
        const recovered = await driver.recover();
        expect(recovered.acceptedVersion).toBe(final.acceptedVersion);
        expect(calls).toHaveLength(beforeRecovery);
        expect(evidence.checks).toHaveLength(beforeChecks);
        for (const [path, text] of original) expect(await readFile(join(source, path), "utf8")).toBe(text);
        evidence.result = result;
        evidence.publicationOrder = publicationOrder;
        evidence.initialReservations = initialReservations.map((reservation) =>
          reservation?.kind === "granted" ? { kind: reservation.kind, taskId: reservation.lease.taskId } : reservation
        );
        evidence.frozenInputs = frozen;
        evidence.publishReceipts = final.publishReceipts;
        evidence.acceptedCheckReceipts = final.checkReceipts;
        evidence.durableCalls = final.calls;
        evidence.modelRequestsOverlap = true;
        evidence.recoveryAdditionalCalls = calls.length - beforeRecovery;
        evidence.finalCliOracle = {
          expectedStdout: "total: 4\npending: 1\ndone: 2\ncancelled: 1\n",
          evidence:
            "actual passing final-group receipt from frozen final.test.ts via Docker data bridge; not separately captured stdout"
        };
        evidence.status = "VERIFIED";
        await log(
          "both initial scoped model requests overlapped; all real Docker groups passed; zero-call recovery preserved acceptance"
        );
      });
    } catch (error) {
      evidence.status = "FAILED";
      evidence.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
      await log("real collaboration failed");
      throw error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 2700000);
}
