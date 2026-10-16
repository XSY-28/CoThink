import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DiscussionEngine,
  BuildDriver,
  currentDiscussionSegment,
  hashBuildValue,
  freezeBuildPlan,
  FrozenBuildPlanSchema,
  createBuildState,
  reserveBuildScope,
  type DiscussionRun,
  type ModelTransport,
  type BuildCheckReceipt,
  type BuildCheckGroup
} from "@onevcat/argue";
import { FileBuildStore } from "../../src/build/file-store.js";
import { Workspace } from "../../src/build/workspace.js";
import type { BuildVerificationCandidate } from "../../src/build/validator.js";
import { LocalBuildSyncAdapter } from "../../src/build/local-sync-adapter.js";
import { Publisher } from "../../src/build/publisher.js";
import { FileDiscussionStore } from "../../src/discussion/file-store.js";
import { openingTurn, exchangeTurn, reviewTurn } from "../../../argue/test/discussion/stage2-fixtures.js";
import {
  BuildDiscussionLink,
  parseBuildIntegrationRequest,
  validateBuildIntegrationRequest,
  projectDiscussionEvents,
  DiscussionEventCursor,
  discussionEventKey,
  discussionWakeObserver,
  createBuildIntegrationResult,
  prepareBuildResultSource,
  continueBuildResult
} from "../../src/build/discussion-link.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cothink-link-")));
  roots.push(path);
  return path;
}
async function request() {
  const frozenBuildPlan = JSON.parse(await readFile(resolve("../../examples/todo-stats/build-plan.json"), "utf8"));
  return {
    integrationVersion: "build-integration-v1" as const,
    requestId: "request-1",
    frozenBuildPlan,
    materialRefs: frozenBuildPlan.manifest.map(
      ({ path, contentHash }: { path: string; contentHash: string | null }) => ({ path, contentHash })
    )
  };
}
async function discussion(directory: string, onSaved?: ConstructorParameters<typeof DiscussionEngine>[2]) {
  const store = new FileDiscussionStore(join(directory, "discussions"));
  let calls = 0;
  const transport: ModelTransport = {
    async respond(call) {
      calls++;
      const protocol = currentDiscussionSegment(await store.load("bridge-session")).protocol;
      const payload =
        protocol.phase === "opening"
          ? openingTurn()
          : protocol.phase === "discussion"
            ? exchangeTurn(protocol, call.modelId)
            : reviewTurn(protocol, call.modelId);
      return {
        rawContent: JSON.stringify(payload),
        payload: { ignored: "transport payload is not protocol authority" },
        modelId: call.modelId,
        protocol: call.protocol,
        generationOptions: call.generationOptions,
        usage: { outputTokens: 1 },
        finishReason: "stop"
      };
    }
  };
  const config = (modelId: string) => ({
    protocol: "openai",
    baseUrl: "https://offline.invalid",
    modelId,
    apiKeyEnv: "UNSET",
    outputMode: "json_object" as const,
    generationOptions: {}
  });
  await store.withWriter("bridge-session", async (writer) => {
    await new DiscussionEngine(writer, transport, { now: () => 0, ...onSaved }).start({
      sessionId: "bridge-session",
      question: "Which proposal?",
      members: { a: config("a"), b: config("b") },
      policy: { effort: "standard" }
    });
  });
  return { store, transport, calls: () => calls, run: await store.load("bridge-session") };
}
function origin(run: DiscussionRun) {
  const segment = currentDiscussionSegment(run);
  return {
    sessionId: run.sessionId,
    segmentId: segment.segmentId,
    selectedAnswerVersionIds: [...segment.finalResult!.selectedAnswerVersionIds],
    finalResultHash: hashBuildValue(segment.finalResult)
  };
}

test("strict request requires independent version, exact material refs and external host approval", async () => {
  const req = await request();
  expect(parseBuildIntegrationRequest(req)).toEqual(req);
  await expect(
    validateBuildIntegrationRequest(req, { approvedPlanHash: req.frozenBuildPlan.planHash })
  ).resolves.toEqual(req);
  for (const bad of [
    { ...req, integrationVersion: "old" },
    { ...req, approved: true },
    { ...req, materialRefs: [] },
    { ...req, materialRefs: req.materialRefs.slice(1) },
    { ...req, materialRefs: [...req.materialRefs, req.materialRefs[0]] }
  ])
    expect(() => parseBuildIntegrationRequest(bad)).toThrow();
  await expect(validateBuildIntegrationRequest(req, { approvedPlanHash: hashBuildValue("wrong") })).rejects.toThrow();
});
test("origin binds persisted completed segment, selected answers and exact FinalResult bytes", async () => {
  const h = await discussion(await root()),
    req = { ...(await request()), origin: origin(h.run) };
  const options = { approvedPlanHash: req.frozenBuildPlan.planHash, loadDiscussion: (id: string) => h.store.load(id) };
  await expect(validateBuildIntegrationRequest(req, options)).resolves.toEqual(req);
  for (const bad of [
    { ...req.origin, segmentId: 99 },
    { ...req.origin, selectedAnswerVersionIds: ["unknown"] },
    { ...req.origin, finalResultHash: hashBuildValue("forged") }
  ])
    await expect(validateBuildIntegrationRequest({ ...req, origin: bad }, options)).rejects.toThrow();
  await expect(
    validateBuildIntegrationRequest(req, { approvedPlanHash: req.frozenBuildPlan.planHash })
  ).rejects.toThrow();
  expect(h.calls()).toBe(6);
});
test("disk reservation survives caller crash, is idempotent and rejects request ID payload substitution", async () => {
  const path = await root(),
    req = await request(),
    opts = { approvedPlanHash: req.frozenBuildPlan.planHash, sourceRoot: path };
  const first = await new BuildDiscussionLink(join(path, "catalogue")).reserve(req, opts);
  const reopened = new BuildDiscussionLink(join(path, "catalogue"));
  const second = await reopened.reserve(req, opts);
  expect(await reopened.get(first.runId)).toEqual(
    Object.fromEntries(Object.entries(first).filter(([key]) => key !== "created"))
  );
  await reopened.markRecoveryRequired(first.runId);
  expect((await new BuildDiscussionLink(join(path, "catalogue")).get(first.runId)).recoveryRequired).toBe(true);
  await reopened.markRecovered(first.runId);
  expect((await reopened.get(first.runId)).recoveryRequired).toBe(false);
  await reopened.requestCancel(first.runId);
  await reopened.requestCancel(first.runId);
  expect((await new BuildDiscussionLink(join(path, "catalogue")).get(first.runId)).cancelRequested).toBe(true);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(first.recoveryRequired).toBe(true);
  expect(second).toEqual({ ...first, created: false });
  await expect(reopened.reserve({ ...req, materialRefs: [...req.materialRefs].reverse() }, opts)).rejects.toThrow(
    "request ID conflict"
  );
  expect(first.runId).toBeTruthy();
  expect(first.workspaceRoot).toBeTruthy();
  await expect(
    new BuildDiscussionLink(join(path, "catalogue")).reserve({ ...req, materialRefs: req.materialRefs.slice(1) }, opts)
  ).rejects.toThrow();
  await expect(
    new BuildDiscussionLink(join(path, "catalogue")).reserve(
      {
        ...req,
        origin: { sessionId: "x", segmentId: 1, selectedAnswerVersionIds: ["x"], finalResultHash: hashBuildValue("x") }
      },
      opts
    )
  ).rejects.toThrow();
  expect(await readdir(join(path, "catalogue"))).not.toContain(".cothink-build");
});
test("event projection is persisted index plus segment, allowlisted and contains no raw reviews/outputs", async () => {
  const h = await discussion(await root());
  const events = projectDiscussionEvents(h.run);
  expect(events).toHaveLength(h.run.events.length);
  expect(events.map((e) => e.seq)).toEqual(h.run.events.map((_, i) => i + 1));
  expect(events.every((e) => e.segmentId === 1 && e.sessionId === h.run.sessionId && e.schemaVersion === 1)).toBe(true);
  expect(JSON.stringify(events)).not.toContain("Independent review");
  expect(JSON.stringify(events)).not.toContain("rawContent");
  expect(Object.keys(events[0]!).sort()).toEqual(
    ["schemaVersion", "sessionId", "segmentId", "seq", "type", "refIds", "data"].sort()
  );
});
test("durable cursor replays after lost wakes, requires ordered ack and idempotently replays an unacked side effect", async () => {
  const path = await root(),
    h = await discussion(path),
    cursorRoot = join(path, "cursors");
  const events = projectDiscussionEvents(h.run),
    cursor = new DiscussionEventCursor(cursorRoot, "consumer-a");
  expect(await cursor.read(h.run)).toEqual(events);
  await expect(cursor.ack(h.run, `${h.run.sessionId}/1/2`)).rejects.toThrow();
  const key = `${h.run.sessionId}/1/1`;
  await cursor.ack(h.run, key);
  await cursor.ack(h.run, key);
  const restarted = new DiscussionEventCursor(cursorRoot, "consumer-a");
  expect(await restarted.read(h.run)).toEqual(events.slice(1));
  // Callback effect before ACK crashes: replay carries the same key; consumer deduplicates it.
  expect((await new DiscussionEventCursor(cursorRoot, "consumer-a").read(h.run))[0]).toEqual(events[1]);
  expect(await new DiscussionEventCursor(cursorRoot, "consumer-b").read(h.run)).toEqual(events);
  expect(h.calls()).toBe(6);
});

async function acceptedFixture(directory: string) {
  const source = join(directory, "input"),
    managed = join(directory, "managed");
  await cp(resolve("../../examples/todo-stats"), source, { recursive: true });
  await mkdir(managed);
  const { planHash: _old, ...raw } = FrozenBuildPlanSchema.parse((await request()).frozenBuildPlan);
  void _old;
  const plan = freezeBuildPlan({
    ...raw,
    manifest: raw.manifest.filter((f) => ["SPEC.md", "src/normalize.ts"].includes(f.path)),
    tasks: [{ ...raw.tasks[0]!, scope: { read: ["SPEC.md"], write: ["src/normalize.ts"] } }]
  });
  const req = {
    integrationVersion: "build-integration-v1",
    requestId: "accepted-request",
    frozenBuildPlan: plan,
    materialRefs: plan.manifest.map(({ path, contentHash }) => ({ path, contentHash }))
  };
  const binding = await new BuildDiscussionLink(join(directory, "catalogue")).reserve(req, {
    approvedPlanHash: plan.planHash,
    sourceRoot: source
  });
  const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey, clock: () => 1000 });
  await store.withWriter(async (w) => {
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
        runId: binding.runId,
        revision: 0,
        ownerEpoch: 1,
        plan,
        acceptedVersion: version,
        status: "active",
        startedAt: 1000,
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
    const lease = await w.transaction(async (state) => {
      const next = reserveBuildScope(
        state,
        { ownerEpoch: 1, taskId: plan.tasks[0]!.taskId, workerId: "member-a", requestId: "reserve" },
        1000,
        () => ({ attemptId: "attempt-1", token: "private-token-never-public" })
      );
      if (next.result.kind !== "granted") throw Error("not granted");
      return { state: next.state, value: next.result.lease };
    });
    const workspace = new Workspace(w, { clock: () => 1000 });
    await workspace.freezeInput(lease, "freeze");
    const hash = (await w.load()).attempts[0]!.contentHashes["src/normalize.ts"]!;
    await workspace.edit(lease, "edit", [
      { path: "src/normalize.ts", text: "export const accepted = true;\n", expectedContentHash: hash }
    ]);
    await workspace.seal(lease, "seal");
    const H = hashBuildValue("trusted-test-backend"),
      image = `sha256:${"a".repeat(64)}`;
    // Trusted deterministic verifier tests bridge binding only; this is not a Docker/program-check proof.
    const owned = new WeakSet<object>();
    const verifier = {
      async describe(groups: readonly BuildCheckGroup[]) {
        return { groups: [...groups], checksHash: H, toolchainHash: H, isolationHash: H, imageDigest: image };
      },
      ownsReceipt(receipt: object) {
        return owned.has(receipt);
      },
      async check(candidate: BuildVerificationCandidate, definition: Awaited<ReturnType<typeof this.describe>>) {
        const files = await w.git.readFiles(candidate.version);
        const sourceHash = hashBuildValue(
          Object.entries(files)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([path, file]) => ({ path, contentHash: file.contentHash }))
        );
        const receipt: BuildCheckReceipt = {
          checkVersion: "build-check-v1",
          receiptId: "check-1",
          ...candidate,
          ...definition,
          sourceHashBefore: sourceHash,
          sourceHashAfter: sourceHash,
          exitCode: 0,
          passed: true
        };
        owned.add(receipt);
        return receipt;
      }
    };
    await new Publisher(w, verifier, { clock: () => 1000 }).finish(lease, "finish");
    const profile = {
      protocol: "openai-compatible",
      baseUrl: "https://offline.invalid",
      modelId: "offline",
      apiKeyEnv: "UNSET",
      outputMode: "json_object" as const,
      generationOptions: {}
    };
    const driver = new BuildDriver({
      writer: w,
      ports: new LocalBuildSyncAdapter(w, verifier, { clock: () => 1000 }).ports,
      clock: () => 1000,
      models: { "member-a": profile, "member-b": profile },
      transport: {
        async respond() {
          throw Error("Accepted tasks must not dispatch again");
        }
      }
    });
    await driver.recover();
    expect((await driver.retry()).status).toBe("completed");
  });
  return { binding, state: await store.load() };
}

test("accepted result references are exact; missing, old, foreign and initial-only returns are refused", async () => {
  const { binding, state } = await acceptedFixture(await root());
  for (const status of ["paused", "cancelled", "active"] as const)
    expect(() => createBuildIntegrationResult(binding, { ...state, status })).toThrow();
  const result = createBuildIntegrationResult(binding, state);
  const source = prepareBuildResultSource(binding, result, state);
  expect(
    await new BuildDiscussionLink(resolve(binding.workspaceRoot, "../..")).prepareResult(binding.runId, result, state)
  ).toEqual(source);
  expect(source.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(source.content).toContain(state.acceptedVersion);
  expect(source.content).not.toContain("private-token-never-public");
  for (const bad of [
    { ...result, requestId: "foreign" },
    { ...result, runId: "foreign" },
    { ...result, planHash: hashBuildValue("other") },
    { ...result, acceptedVersion: "f".repeat(40) },
    { ...result, publishReceiptIds: [] },
    { ...result, checkReceiptIds: ["missing"] },
    { ...result, candidateRefs: [] }
  ])
    expect(() => prepareBuildResultSource(binding, bad, state)).toThrow();
  expect(() => createBuildIntegrationResult(binding, { ...state, publishReceipts: [], checkReceipts: [] })).toThrow();
}, 120000);
test("prepare is zero-call; only explicit continuation makes a new segment and preserves every frozen old byte", async () => {
  const directory = await root(),
    h = await discussion(directory),
    { binding, state } = await acceptedFixture(directory);
  const result = createBuildIntegrationResult(binding, state),
    source = prepareBuildResultSource(binding, result, state);
  const oldSegment = JSON.stringify(h.run.segments[0]),
    oldEvents = JSON.stringify(h.run.events),
    oldInput = JSON.stringify(h.run.initial);
  expect(h.calls()).toBe(6);
  await h.store.withWriter(h.run.sessionId, async (writer) => {
    const engine = new DiscussionEngine(writer, h.transport, { now: () => 0 });
    await expect(continueBuildResult(engine, h.run.sessionId, source, { authorized: false })).rejects.toThrow();
    expect(h.calls()).toBe(6);
    const continued = await continueBuildResult(engine, h.run.sessionId, source, { authorized: true });
    expect(continued.currentSegmentId).toBe(2);
    expect(h.calls()).toBe(12);
    expect(JSON.stringify(continued.segments[0])).toBe(oldSegment);
    expect(JSON.stringify(continued.events.slice(0, h.run.events.length))).toBe(oldEvents);
    expect(JSON.stringify(continued.initial)).toBe(oldInput);
    expect(currentDiscussionSegment(continued).protocol.sources.find((s) => s.sourceId === source.sourceId)).toEqual(
      source
    );
    expect(currentDiscussionSegment(continued).constraintChecks ?? []).toEqual([]);
    expect(
      projectDiscussionEvents(continued)
        .slice(h.run.events.length)
        .every((e) => e.segmentId === 2)
    ).toBe(true);
  });
}, 120000);
test("created and duplicated/throwing wake observers cannot dispatch; missed notifications replay from disk", async () => {
  const wakes: string[] = [],
    wake = discussionWakeObserver((event) => {
      wakes.push(event.kind);
      throw Error("observer failed");
    });
  const path = await root(),
    h = await discussion(path, { onSaved: wake });
  expect(h.run.status).toBe("completed");
  expect(wakes[0]).toBe("created");
  expect(h.calls()).toBe(6);
  wake(h.run, { type: "created" });
  wake(h.run, h.run.events.at(-1)!);
  wake(h.run, h.run.events.at(-1)!);
  const cursor = new DiscussionEventCursor(join(path, "cursor"), "consumer");
  const events = await cursor.read(h.run);
  for (const event of events) await cursor.ack(h.run, discussionEventKey(event));
  expect(await new DiscussionEventCursor(join(path, "cursor"), "consumer").read(h.run)).toEqual([]);
  expect(h.calls()).toBe(6);
});

test("host recovery context is atomic with reservation, immutable on replay and rejects non-JSON capabilities", async () => {
  const path = await root(),
    req = await request(),
    link = new BuildDiscussionLink(join(path, "catalogue"));
  const context = {
    contextVersion: "build-cli-host-v1",
    image: `sha256:${"a".repeat(64)}`,
    configPath: join(path, "config.json"),
    models: { "member-a": { modelId: "offline" } }
  };
  const options = { approvedPlanHash: req.frozenBuildPlan.planHash, sourceRoot: path, hostContext: context };
  const binding = await link.reserve(req, options);
  expect((await new BuildDiscussionLink(join(path, "catalogue")).get(binding.runId)).hostContext).toEqual(context);
  expect(
    (await link.reserve(req, { approvedPlanHash: options.approvedPlanHash, sourceRoot: path })).hostContext
  ).toEqual(context);
  await expect(
    link.reserve(req, { ...options, hostContext: { ...context, image: `sha256:${"b".repeat(64)}` } })
  ).rejects.toThrow();
  await expect(
    link.reserve(
      { ...req, requestId: "bad-host" },
      { ...options, hostContext: { contextVersion: "build-cli-host-v1", capability: () => "execute" } }
    )
  ).rejects.toThrow();
  await expect(
    link.reserve({ ...req, requestId: "class-host" }, { ...options, hostContext: new Date() })
  ).rejects.toThrow();
  await expect(
    link.reserve(
      { ...req, requestId: "large-host" },
      { ...options, hostContext: { contextVersion: "build-cli-host-v1", data: "x".repeat(100000) } }
    )
  ).rejects.toThrow();
});
