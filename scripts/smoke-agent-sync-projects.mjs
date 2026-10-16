// Deterministic Stage7 worker: only neutral public entries and frozen host material.
import { readFile, writeFile, rm } from "node:fs/promises";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
for (const key of Object.keys(process.env))
  if (
    /API|TOKEN|SECRET|PASSWORD|PROVIDER|MODEL|OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|DEEPSEEK|GLM|ZHIPU|NODE_OPTIONS|PROXY/i.test(
      key
    )
  )
    delete process.env[key];
let modelFetches = 0;
globalThis.fetch = async () => {
  modelFetches++;
  throw Error("MODEL_FETCH_FORBIDDEN");
};
const core = await import("@onevcat/argue/agent-sync/project");
const host = await import("@onevcat/argue-cli/agent-sync/project");
const input = JSON.parse(await readFile(process.argv[2], "utf8")),
  output = process.argv[3];
if (!output) throw Error("EVIDENCE_OUTPUT_REQUIRED");
const config = host.freezeTrustedCheckConfig(input.config);
const project = core.freezeAgentSyncProject({
  ...input.project,
  checkConfigurationHash: host.configurationHash(config)
});
const options = { ...input, project, config };
const report = {
  kind: input.kind,
  status: "running",
  clock: "Date.now (real)",
  preparationMs: input.preparationMs,
  planHash: project.planHash,
  configurationHash: project.checkConfigurationHash,
  image: input.image,
  memberIds: project.memberIds,
  events: [],
  checks: [],
  publications: [],
  rejections: [],
  usage: [],
  modelFetches: 0
};
const tokens = [];
let sequence = 0;
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const id = (prefix) => `${prefix}-${++sequence}`;
const statePath = join(input.workspaceRoot, ".agent-sync/state", project.projectKey, "session.json");
async function state() {
  const bytes = await readFile(statePath);
  const s = JSON.parse(bytes);
  return {
    hash: sha(bytes),
    acceptedVersion: s.acceptedVersion,
    revision: s.revision,
    owner: s.ownerEpoch,
    publications: s.publishReceipts.length,
    checks: s.checkReceipts.length,
    acceptedTasks: s.acceptedTasks,
    deadlineAt: s.deadlineAt
  };
}
async function save() {
  const text = JSON.stringify(report, null, 2);
  for (const token of tokens) assert(!text.includes(token));
  await writeFile(output, text + "\n", { mode: 0o600 });
}
async function step(name, fn) {
  const start = performance.now();
  try {
    const value = await fn();
    report.events.push({ operation: name, durationMs: performance.now() - start, result: "ok" });
    await save();
    console.log(
      JSON.stringify({ kind: input.kind, operation: name, durationMs: Math.round(performance.now() - start) })
    );
    return value;
  } catch (error) {
    report.events.push({
      operation: name,
      durationMs: performance.now() - start,
      result: "error",
      code: String(error.code ?? error.message).slice(0, 100)
    });
    await save();
    throw error;
  }
}
async function refuse(name, fn, pattern) {
  let error, result;
  try {
    result = await fn();
  } catch (e) {
    error = e;
  }
  assert(error || result?.kind === "rejected", `${name} must reject`);
  if (pattern) assert.match(String(error?.cause?.message ?? error?.message ?? result?.code), pattern);
  report.rejections.push({ operation: name, code: error?.code ?? result?.code ?? "rejected" });
}
function checkSummary(r) {
  return {
    receiptId: r.receiptId,
    passed: r.passed,
    exitCode: r.exitCode,
    groups: r.groups,
    version: r.version,
    candidateHash: r.candidateHash,
    checksHash: r.checksHash,
    programsHash: r.programsHash,
    argumentsHash: r.argumentsHash,
    toolchainHash: r.toolchainHash,
    isolationHash: r.isolationHash,
    imageDigest: r.imageDigest
  };
}
async function check(worker, lease, request) {
  const candidate = await step("seal", () => worker.seal(lease, id("seal")));
  const response = await step("check", () => worker.check(lease, request ?? id("check"), candidate));
  report.checks.push(checkSummary(response.receipt));
  // Validate genuine backend output against its genuine active state before publication.
  // These are protocol counterexamples, not replacement checks or persisted receipts.
  const actualState = core.parseAgentSyncState(JSON.parse(await readFile(statePath, "utf8")));
  if (candidate.baseVersion === actualState.acceptedVersion) {
    const envelope = {
      requestVersion: core.AGENT_SYNC_REQUEST_VERSION,
      requestId: response.requestId,
      lease,
      candidate
    };
    core.validateAgentSyncVerifierPortResult(actualState, envelope, response);
    for (const field of ["version", "configurationHash"]) {
      const receipt = {
        ...response.receipt,
        [field]: field === "version" ? "0".repeat(40) : "sha256:" + "0".repeat(64)
      };
      assert.throws(
        () => core.validateAgentSyncVerifierPortResult(actualState, envelope, { ...response, receipt }),
        /mismatch/
      );
      report.rejections.push({ operation: "real-receipt-" + field, code: "protocol-mismatch" });
    }
  }
  return { candidate, response };
}
async function finish(worker, lease, request) {
  const response = await step("finish", () => worker.finish(lease, request ?? id("finish")));
  const r = response.receipt;
  report.publications.push({
    receiptId: r.receiptId,
    baseVersion: r.baseVersion,
    acceptedVersion: r.acceptedVersion,
    checkReceiptId: r.checkReceiptId,
    candidateHash: r.candidateHash
  });
  return response;
}
async function grant(worker, task, request = id("scope")) {
  const result = await step("request-scope", () => worker.requestScope(task.taskId, request));
  assert.equal(result.kind, "granted");
  tokens.push(result.lease.token);
  return result.lease;
}
async function edit(worker, lease, path, text, expected) {
  return step("edit", () => worker.edit(lease, id("edit"), [{ path, text, expectedContentHash: expected }]));
}
const local = new host.LocalAgentSync({
  ...options,
  onUsage: (usage) => {
    report.usage.push(usage);
  }
});
const start = performance.now();
try {
  await local.withSession(async (service) => {
    const original = await state();
    report.initial = original;
    const tasks = project.tasks;
    const first = tasks[0],
      workerA = service.forWorker(first.workerId),
      leaseA = await grant(workerA, first);
    const frozenA = await step("freeze-input", () => workerA.freezeInput(leaseA, id("freeze")));
    const fileA = first.scope.write[0];
    await refuse(
      "wrong-owner",
      () => workerA.read({ ...leaseA, ownerEpoch: leaseA.ownerEpoch + 1 }, id("wrong-owner"), fileA),
      /identity_mismatch/i
    );
    const beforeBad = await state();
    await refuse(
      "old-content-hash",
      () =>
        workerA.edit(leaseA, id("old-hash"), [
          { path: fileA, text: "must not be staged", expectedContentHash: "sha256:" + "0".repeat(64) }
        ]),
      /hash mismatch/i
    );
    assert.equal((await state()).hash, beforeBad.hash);
    if (input.kind === "cart-one") {
      for (const path of first.scope.write)
        await edit(
          workerA,
          leaseA,
          path,
          input.texts[path.endsWith("amount.ts") ? "amount-guards" : "receipt-lines"],
          frozenA.contentHashes[path]
        );
      const observed = await check(workerA, leaseA);
      assert.equal(observed.response.receipt.passed, true);
      await finish(workerA, leaseA);
    } else {
      const format = tasks[1],
        workerB = service.forWorker(format.workerId),
        conflict = tasks[2];
      let queuedId;
      if (conflict) {
        queuedId = id("queued");
        const wait = await step("conflict-wait", () =>
          service.forWorker(conflict.workerId).requestScope(conflict.taskId, queuedId)
        );
        assert.equal(wait.kind, "waiting");
        report.waitingObserved = true;
      }
      const leaseB = await grant(workerB, format),
        frozenB = await step("freeze-independent", () => workerB.freezeInput(leaseB, id("freeze")));
      await refuse("scope-denied", () => workerB.read(leaseB, id("outside"), fileA), /scope/i);
      const fileB = format.scope.write[0],
        textA = input.texts["amount-basic"],
        textB = input.texts[input.kind === "cart-negative" ? "receipt-faulty" : "receipt-lines"];
      await edit(workerA, leaseA, fileA, textA, frozenA.contentHashes[fileA]);
      await edit(workerB, leaseB, fileB, textB, frozenB.contentHashes[fileB]);
      assert.equal((await state()).acceptedVersion, original.acceptedVersion);
      report.privateEditsDoNotPublish = true;
      if (input.kind === "cart-negative") {
        assert.equal((await check(workerA, leaseA)).response.receipt.passed, true);
        assert.equal((await check(workerB, leaseB)).response.receipt.passed, true);
        const acceptedA = await finish(workerA, leaseA);
        const before = await state();
        await refuse(
          "combined-finish-rejected",
          () => workerB.finish(leaseB, id("bad-finish")),
          /isolated check evidence rejected/i
        );
        const after = await state();
        assert.equal(after.acceptedVersion, before.acceptedVersion);
        assert.equal(after.publications, before.publications);
        report.failedFinishDidNotPublish = true;
        await step("explicit-release", () => workerB.release(leaseB, id("release")));
        const next = await grant(workerB, format),
          frozen = await step("fresh-input", () => workerB.freezeInput(next, id("freeze")));
        assert.equal(frozen.baseVersion, acceptedA.receipt.acceptedVersion);
        await edit(workerB, next, fileB, textB, frozen.contentHashes[fileB]);
        const failed = await check(workerB, next);
        assert.equal(failed.response.receipt.passed, false);
        report.realCombinedFailure = checkSummary(failed.response.receipt);
        const beforeSecond = await state();
        await refuse(
          "fresh-combined-finish-rejected",
          () => workerB.finish(next, id("bad-finish")),
          /isolated check evidence rejected/i
        );
        assert.equal((await state()).acceptedVersion, beforeSecond.acceptedVersion);
        assert.equal((await state()).publications, 1);
        report.status = "verified-negative";
        return;
      }
      await finish(workerB, leaseB);
      const acceptedA = await finish(workerA, leaseA);
      const hashBeforeReplay = (await state()).hash;
      await step("finish-replay", () => workerA.finish(leaseA, acceptedA.receipt.requestId));
      assert.equal((await state()).hash, hashBeforeReplay);
      report.successfulReplayReadOnly = true;
      const workerC = service.forWorker(conflict.workerId);
      const beforeWaitReplay = await state();
      const waitReplay = await step("waiting-request-replay", () => workerC.requestScope(conflict.taskId, queuedId));
      assert.equal(waitReplay.kind, "replayed");
      assert.equal((await state()).hash, beforeWaitReplay.hash);
      report.waitingReplayReadOnly = true;
      const leaseC = await grant(workerC, conflict),
        frozenC = await step("latest-input", () => workerC.freezeInput(leaseC, id("freeze")));
      assert.equal(frozenC.baseVersion, acceptedA.receipt.acceptedVersion);
      const latest = await step("read-latest", () => workerC.read(leaseC, id("read"), fileA));
      assert.equal(latest.text, textA);
      report.latestInputVerified = true;
      await edit(workerC, leaseC, fileA, input.texts["amount-guards"], latest.contentHash);
      const observed = await check(workerC, leaseC);
      assert.equal(observed.response.receipt.passed, true);
      await finish(workerC, leaseC);
    }
    const done = await step("status", () => service.status());
    assert.equal(done.status, "completed");
    report.final = await state();
    assert.equal(report.final.acceptedTasks.length, tasks.length);
    const diff = await step("diff", () => service.diff());
    assert.equal(diff.files.length, 2);
    report.diff = diff;
    const exported = await step("export", () => service.exportVersion({ target: join(input.root, "export") }));
    assert.equal(exported.version, done.acceptedVersion);
    report.exportDirectory = exported.directory;
    const expectedAmount = input.texts["amount-guards"],
      expectedReport = input.texts["receipt-lines"];
    assert.equal(await readFile(join(exported.directory, project.tasks[0].scope.write[0]), "utf8"), expectedAmount);
    const reportPath = input.kind === "todo-two" ? "src/report.ts" : "lib/receipt.ts";
    assert.equal(await readFile(join(exported.directory, reportPath), "utf8"), expectedReport);
    for (const entry of project.manifest) {
      const bytes = await readFile(join(exported.directory, entry.path));
      for (const token of tokens) assert(!bytes.includes(token));
    }
    const before = await state(),
      usageBefore = report.usage.length;
    const recovered = await step("explicit-recover", () => service.recover(id("recover")));
    assert.equal(recovered.replayedActions, 0);
    const after = await state();
    assert(after.owner > before.owner);
    assert.equal(after.deadlineAt, before.deadlineAt);
    assert.equal(report.usage.length, usageBefore);
    report.recoveryNoAutomaticChecks = true;
    await refuse(
      "old-lease-after-recovery",
      () => workerA.read(leaseA, id("old-lease"), fileA),
      /attempt_invalidated/i
    );
    report.status = "verified";
  });
  if (report.status === "verified") {
    await rm(input.sourceRoot, { recursive: true });
    const usageBefore = report.usage.length;
    await new host.LocalAgentSync({
      ...options,
      sourceRoot: undefined,
      onUsage: (u) => report.usage.push(u)
    }).withSession(async (service) => {
      assert.equal((await service.status()).status, "completed");
      assert.equal((await service.recover(id("recover-reopen"))).replayedActions, 0);
      await service.exportVersion({ target: report.exportDirectory });
    });
    assert.equal(report.usage.length, usageBefore);
    report.sourceFreeReopenVerified = true;
  }
} catch (error) {
  report.status = "failed";
  report.failureCode = error.code ?? error.message;
  report.failureMessage = String(error.message).slice(0, 400);
  for (const token of tokens) report.failureMessage = report.failureMessage.replaceAll(token, "<lease>");
  report.causes = [];
  for (let e = error.cause; e; e = e.cause) report.causes.push(String(e.code ?? e.message).slice(0, 160));
  process.exitCode = 1;
}
report.elapsedMs = performance.now() - start;
report.modelFetches = modelFetches;
assert.equal(modelFetches, 0);
await save();
console.log(
  JSON.stringify({
    kind: input.kind,
    status: report.status,
    elapsedMs: Math.round(report.elapsedMs),
    checks: report.checks.length,
    publications: report.publications.length
  })
);
