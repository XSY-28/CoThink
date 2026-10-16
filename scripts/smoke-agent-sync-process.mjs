import process from "node:process";
// Fixed acceptance caller. All production decisions remain in the independent tool service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
for (const key of Object.keys(process.env))
  if (/API|TOKEN|SECRET|MODEL|PROVIDER|OPENAI|ANTHROPIC|GOOGLE|NODE_OPTIONS|PROXY/i.test(key)) delete process.env[key];
let modelFetches = 0;
globalThis.fetch = async () => {
  modelFetches++;
  throw Error("NO_MODEL_API");
};
const repo = fileURLToPath(new URL("..", import.meta.url)),
  input = JSON.parse(await readFile(process.argv[2], "utf8")),
  output = process.argv[3];
if (!output) throw Error("EVIDENCE_REQUIRED");
const { ToolHost, safeChildEnvironment } = await import("../tools/agent-sync/client.mjs"),
  { createHandoff } = await import("../tools/agent-sync/handoff.mjs");
const { FileAgentSyncStore } = await import("@onevcat/argue-cli/agent-sync/project");
const report = {
  status: "running",
  kind: input.kind,
  clock: "Date.now/performance.now",
  events: [],
  timings: [],
  rejections: [],
  publications: [],
  modelFetches: 0,
  planHash: input.options.project.planHash,
  configurationHash: input.options.project.checkConfigurationHash,
  image: input.options.image
};
report.toolInputs = {};
for (const name of ["stdio.mjs", "server.mjs", "protocol.mjs", "diagnostics.mjs"])
  report.toolInputs[name] = createHash("sha256")
    .update(await readFile(join(repo, "tools/agent-sync/dist", name)))
    .digest("hex");
report.callerInputs = {};
for (const name of [
  "tools/agent-sync/client.mjs",
  "tools/agent-sync/handoff.mjs",
  "scripts/agent-sync-process-client.mjs",
  "scripts/smoke-agent-sync-process.mjs"
])
  report.callerInputs[name] = createHash("sha256")
    .update(await readFile(join(repo, name)))
    .digest("hex");
const tokens = [],
  descriptors = [],
  hosts = [],
  peers = [];
let sequence = 0;
const id = (prefix) => prefix + "-" + ++sequence;
const hash = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
const stateFile = join(
  input.options.workspaceRoot,
  ".agent-sync/state",
  input.options.project.projectKey,
  "session.json"
);
async function state() {
  const bytes = await readFile(stateFile),
    s = JSON.parse(bytes);
  for (const a of s.attempts) if (!tokens.includes(a.token)) tokens.push(a.token);
  return {
    hash: hash(bytes),
    acceptedVersion: s.acceptedVersion,
    owner: s.ownerEpoch,
    checks: s.checkReceipts.length,
    publications: s.publishReceipts.length,
    deadlineAt: s.deadlineAt,
    status: s.status
  };
}
async function save() {
  report.modelFetches = modelFetches;
  const text = JSON.stringify(report, null, 2);
  for (const token of tokens) assert(!text.includes(token));
  for (const d of descriptors) assert(!text.includes(d.capability));
  await writeFile(output, text + "\n", { mode: 0o600 });
}
async function step(operation, fn) {
  const start = performance.now();
  try {
    const value = await fn();
    report.events.push({ operation, result: "ok", durationMs: performance.now() - start });
    await save();
    console.log(JSON.stringify({ operation, durationMs: Math.round(performance.now() - start) }));
    return value;
  } catch (error) {
    report.events.push({
      operation,
      result: "rejected",
      code: error.code ?? "failed",
      durationMs: performance.now() - start
    });
    await save();
    throw error;
  }
}
async function refuses(operation, fn, code) {
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  assert(error, operation);
  if (code) assert.equal(error.code, code);
  report.rejections.push({ operation, code: error.code });
  await save();
}
const probeRoot = join(input.root, "probes");
await mkdir(probeRoot);
const bootstrap = join(input.root, "bootstrap.mjs");
await writeFile(
  bootstrap,
  `import{register}from'node:module';import{writeFileSync}from'node:fs';const root=${JSON.stringify(probeRoot)};const forbidden=Object.keys(process.env).filter(k=>/API|TOKEN|SECRET|MODEL|PROVIDER|OPENAI|ANTHROPIC|NODE_OPTIONS|PROXY/i.test(k));let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('MODEL_FETCH_FORBIDDEN')};register(${JSON.stringify(new URL("agent-sync-project-import-guard.mjs", import.meta.url).href)},{data:{trace:root+'/'+process.pid+'.imports.jsonl'}});process.once('exit',()=>writeFileSync(root+'/'+process.pid+'.json',JSON.stringify({pid:process.pid,node:process.version,forbiddenEnvNames:forbidden,modelFetches:fetches})+'\\n'));`
);
// Explicit sentinel only proves the whitelist. It is not a credential and is never passed to tool/clients.
process.env.STAGE8_SECRET_ENV_SENTINEL = "DO_NOT_CROSS_MODEL_BOUNDARY";
const diagnostics = [];
function startHost() {
  const host = new ToolHost({
    entry: join(repo, "tools/agent-sync/dist/stdio.mjs"),
    configFile: input.jobFile,
    cwd: input.root,
    trace: true,
    execArgv: ["--import", bootstrap],
    onDiagnostic: (d) => {
      diagnostics.push(d);
    }
  });
  hosts.push(host);
  return host;
}
function startPeer(host, connection) {
  const child = spawn(process.execPath, ["--import", bootstrap, join(repo, "scripts/agent-sync-process-client.mjs")], {
    cwd: input.root,
    env: safeChildEnvironment(),
    stdio: ["pipe", "pipe", "pipe", "ipc"]
  });
  const waiting = new Map();
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      for (const item of waiting.values())
        item.reject(Object.assign(Error("client_closed"), { code: "client_closed" }));
      waiting.clear();
      resolve({ code, signal });
    })
  );
  child.on("message", (message) => {
    if (message.event === "timing") {
      report.timings.push({ method: message.method, ...message.timing });
      return;
    }
    const item = waiting.get(message.commandId);
    if (!item) return;
    waiting.delete(message.commandId);
    message.ok ? item.resolve(message.result) : item.reject(Object.assign(Error(message.error.code), message.error));
  });
  child.stderr.on("data", () => {
    report.clientDiagnosticObserved = true;
  });
  void host.attachProcess(child, connection);
  const peer = {
    child,
    exited,
    rpc: (message) =>
      new Promise((resolve, reject) => {
        if (!child.connected) {
          reject(Object.assign(Error("client_closed"), { code: "client_closed" }));
          return;
        }
        const commandId = randomUUID();
        waiting.set(commandId, { resolve, reject });
        child.send({ commandId, ...message }, (error) => {
          if (error) {
            waiting.delete(commandId);
            reject(Object.assign(Error("client_closed"), { code: "client_closed" }));
          }
        });
      })
  };
  peers.push(peer);
  return peer;
}
const taskCall = (peer, context, method, args) =>
  peer.rpc({ mode: "task", contextId: context.contextId, method, args });
async function scope(peer, task, requestId = id("scope")) {
  const result = await step("requestScope", () => peer.rpc({ mode: "scope", taskId: task.taskId, requestId }));
  if (result.descriptor) descriptors.push(result.descriptor);
  return result;
}
async function finish(peer, context, requestId = id("finish")) {
  const response = await step("finish", () => taskCall(peer, context, "finish", [requestId]));
  const r = response.receipt;
  report.publications.push({
    receiptId: r.receiptId,
    checkReceiptId: r.checkReceiptId,
    baseVersion: r.baseVersion,
    acceptedVersion: r.acceptedVersion,
    candidateHash: r.candidateHash
  });
  return response;
}
const started = performance.now();
let host, admin;
try {
  host = startHost();
  const ready = await host.ready;
  const baseline = ready.status.acceptedVersion;
  report.baselineVersion = baseline;
  const a = startPeer(host, "a"),
    b = startPeer(host, "b");
  report.processIds = { tool: host.child.pid, a: a.child.pid, b: b.child.pid };
  assert.notEqual(a.child.pid, b.child.pid);
  admin = host.client("admin");
  const [ta, tb, tc] = input.options.project.tasks;
  const beforeWrong = await state();
  await refuses(
    "cross-worker-request",
    () => b.rpc({ mode: "raw", method: "requestScope", params: { taskId: ta.taskId }, requestId: id("wrong-worker") }),
    "worker_task_mismatch"
  );
  assert.equal((await state()).hash, beforeWrong.hash);
  const ca = await scope(a, ta);
  assert.equal(ca.result.kind, "granted");
  const fa = await step("freezeA", () => taskCall(a, ca, "freezeInput", [id("freeze")]));
  const waitingAt = performance.now(),
    waiting = await scope(b, tc, id("wait"));
  assert.equal(waiting.result.kind, "waiting");
  assert.equal(waiting.contextId, undefined);
  report.conflictWaiting = true;
  const cb = await scope(b, tb);
  assert.equal(cb.result.kind, "granted");
  const fb = await step("freezeB", () => taskCall(b, cb, "freezeInput", [id("freeze")]));
  await refuses(
    "scope-read-denied",
    () => taskCall(b, cb, "read", [ta.scope.write[0], id("outside")]),
    "scope_violation"
  );
  const fileA = ta.scope.write[0],
    fileB = tb.scope.write[0],
    editA = [{ path: fileA, text: input.texts["amount-basic"], expectedContentHash: fa.contentHashes[fileA] }],
    editId = id("edit-a");
  await step("editA", () => taskCall(a, ca, "edit", [editA, editId]));
  const beforeReplay = await state();
  await step("edit-replay", () => taskCall(a, ca, "edit", [editA, editId]));
  assert.equal((await state()).hash, beforeReplay.hash);
  await refuses(
    "changed-edit-context",
    () => taskCall(a, ca, "edit", [[{ ...editA[0], text: "must not be applied" }], editId]),
    "request_id_conflict"
  );
  await step("editB", () =>
    taskCall(b, cb, "edit", [
      [{ path: fileB, text: input.texts["receipt-lines"], expectedContentHash: fb.contentHashes[fileB] }],
      id("edit-b")
    ])
  );
  assert.equal((await state()).acceptedVersion, baseline);
  report.privateEditsDoNotPublish = true;
  await finish(b, cb);
  const aFinishId = id("publish-a"),
    acceptedA = await finish(a, ca, aFinishId);
  const beforePubReplay = await state();
  await step("finish-replay", () => taskCall(a, ca, "finish", [aFinishId]));
  assert.equal((await state()).hash, beforePubReplay.hash);
  report.successfulReplayReadOnly = true;
  const cc = await scope(b, tc);
  assert.equal(cc.result.kind, "granted");
  report.lockWaitMs = performance.now() - waitingAt;
  const fc = await step("latest-input", () => taskCall(b, cc, "freezeInput", [id("freeze")]));
  assert.equal(fc.baseVersion, acceptedA.receipt.acceptedVersion);
  const latest = await step("read-latest", () => taskCall(b, cc, "read", [fileA, id("read")]));
  assert.equal(latest.text, input.texts["amount-basic"]);
  report.latestInputVerified = true;
  await step("edit-final", () =>
    taskCall(b, cc, "runAction", [
      { kind: "edit", path: fileA, text: input.texts["amount-guards"], expectedContentHash: latest.contentHash },
      id("edit-final")
    ])
  );
  const checked = await step("private-check", () => taskCall(b, cc, "runAction", [{ kind: "check" }, id("check")]));
  assert.equal(checked.receipt.passed, true);
  report.privateCheck = {
    passed: checked.receipt.passed,
    groups: checked.receipt.groups,
    version: checked.receipt.version,
    checksHash: checked.receipt.checksHash
  };
  await finish(b, cc);
  const status = (await step("status", () => admin.call("status", {}, id("status")))).result;
  assert.equal(status.status, "completed");
  report.acceptedVersion = status.acceptedVersion;
  const diff = (await step("diff", () => admin.call("diff", {}, id("diff")))).result;
  assert.equal(diff.files.length, 2);
  const exported = (
    await step("export", () => admin.call("exportVersion", { target: join(input.root, "export") }, id("export")))
  ).result;
  assert.equal(exported.version, status.acceptedVersion);
  assert.equal(await readFile(join(exported.directory, fileA), "utf8"), input.texts["amount-guards"]);
  assert.equal(await readFile(join(exported.directory, fileB), "utf8"), input.texts["receipt-lines"]);
  // A client process closes/reopens on the same fixed route; explicit old success replay only.
  const descriptor = ca.descriptor;
  await a.rpc({ mode: "shutdown" });
  assert.equal((await a.exited).code, 0);
  const anew = startPeer(host, "a");
  const restored = await anew.rpc({ mode: "restore", descriptor });
  const beforeClientReplay = await state();
  await step("client-reopen-replay", () => taskCall(anew, restored, "finish", [aFinishId]));
  assert.equal((await state()).hash, beforeClientReplay.hash);
  const beforeClose = await state();
  const close = await step("close-tool", () => admin.call("close", {}, id("close")));
  assert.equal(close.result.writerReleased, true);
  assert.equal((await host.exited).code, 0);
  await assert.rejects(lstat(join(dirname(stateFile), ".writer.lock")), { code: "ENOENT" });
  await refuses("late-action-closed-tool", () => taskCall(anew, restored, "read", [fileA, id("late")]), "tool_closed");
  await b.rpc({ mode: "shutdown" });
  await anew.rpc({ mode: "shutdown" });
  assert.equal((await b.exited).code, 0);
  assert.equal((await anew.exited).code, 0);
  // New explicit process/open: existing core advances owner; no request/check is replayed automatically.
  const oracleBefore = diagnostics.filter((d) => d.event === "child-start" && d.subsystem === "oracle").length;
  host = startHost();
  await host.ready;
  admin = host.client("admin");
  const reopened = await state();
  assert(reopened.owner > beforeClose.owner);
  assert.equal(reopened.acceptedVersion, beforeClose.acceptedVersion);
  assert.equal(reopened.publications, 3);
  assert.equal(reopened.deadlineAt, beforeClose.deadlineAt);
  const recovering = (await step("first-explicit-recovery", () => admin.call("recover", {}, id("recover")))).result;
  assert.equal(recovering.replayedActions, 0);
  const ar = startPeer(host, "a"),
    replayed = await ar.rpc({ mode: "restore", descriptor });
  const preDurable = await state();
  await step("tool-reopen-durable-success", () => taskCall(ar, replayed, "finish", [aFinishId]));
  assert.equal((await state()).hash, preDurable.hash);
  assert.equal(diagnostics.filter((d) => d.event === "child-start" && d.subsystem === "oracle").length, oracleBefore);
  report.firstRecoveryZeroChecks = true;
  const actual = await new FileAgentSyncStore({
    workspaceRoot: input.options.workspaceRoot,
    projectKey: input.options.project.projectKey
  }).load();
  assert.equal(actual.publishReceipts.length, 3);
  assert(actual.checkReceipts.every((r) => r.passed));
  // No direct source-repository overwrite is attempted. Guard observations are recorded separately.
  report.handoff = await createHandoff({
    sourceRoot: input.options.sourceRoot,
    exportDirectory: exported.directory,
    project: input.options.project,
    baselineVersion: baseline,
    diff,
    validation: {
      source: "validated current FileAgentSyncStore authority",
      acceptedVersion: actual.acceptedVersion,
      publications: actual.publishReceipts.map((r) => ({
        receiptId: r.receiptId,
        checkReceiptId: r.checkReceiptId,
        acceptedVersion: r.acceptedVersion
      })),
      checks: actual.checkReceipts.map((r) => ({
        receiptId: r.receiptId,
        passed: r.passed,
        groups: r.groups,
        configurationHash: r.configurationHash,
        programsHash: r.programsHash,
        argumentsHash: r.argumentsHash,
        toolchainHash: r.toolchainHash,
        isolationHash: r.isolationHash,
        imageDigest: r.imageDigest
      }))
    },
    target: join(input.root, "handoff"),
    repository: input.repository
  });
  await ar.rpc({ mode: "shutdown" });
  await ar.exited;
  await admin.call("close", {}, id("close-final"));
  assert.equal((await host.exited).code, 0);
  report.status = "verified";
  report.final = await state();
  report.exportDirectory = exported.directory;
} catch (error) {
  report.status = "failed";
  report.failureCode = error.code ?? error.name;
  report.failureMessage = String(error.message).slice(0, 180);
  process.exitCode = 1;
  for (const peer of peers) if (peer.child.connected) await peer.rpc({ mode: "shutdown" }).catch(() => {});
  for (const item of hosts)
    if (!item.closed) {
      await item.ready.then(() => item.client("admin").call("close", {}, id("cleanup"))).catch(() => {});
      await item.exited;
    }
}
report.elapsedMs = performance.now() - started;
report.diagnostics = diagnostics;
report.modelFetches = modelFetches;
assert.equal(modelFetches, 0);
const probes = [];
for (const name of await readdir(probeRoot))
  if (name.endsWith(".json")) {
    const probe = JSON.parse(await readFile(join(probeRoot, name), "utf8"));
    assert.equal(probe.modelFetches, 0);
    assert.deepEqual(probe.forbiddenEnvNames, []);
    probes.push(probe);
  }
report.environmentProbes = probes;
for (const name of await readdir(probeRoot))
  if (name.endsWith(".imports.jsonl"))
    for (const line of (await readFile(join(probeRoot, name), "utf8")).trim().split("\n"))
      if (line) assert.equal(JSON.parse(line).decision, "allowed");
await save();
console.log(
  JSON.stringify({
    status: report.status,
    kind: input.kind,
    elapsedMs: report.elapsedMs,
    publications: report.publications.length
  })
);
