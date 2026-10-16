// Deterministic checkout example, not a model runner or a strategy benchmark.
import process from "node:process";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { registerHooks } from "node:module";

// Remove ambient model settings before loading any workspace implementation.
const allowed = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "ComSpec"]);
for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key];
let fetchAttempts = 0;
globalThis.fetch = async () => {
  fetchAttempts++;
  throw new Error("EXAMPLE_NETWORK_FORBIDDEN");
};
const argv = process.argv.slice(2),
  args = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!["--image", "--output", "--docker-context"].includes(argv[i]) || !argv[i + 1] || args[argv[i]])
    throw new Error(
      "Usage: node examples/agent-sync/cart/run.mjs --image sha256:ID --output NEW_DIRECTORY [--docker-context NAME]"
    );
  args[argv[i]] = argv[i + 1];
}
if (!/^sha256:[a-f0-9]{64}$/.test(args["--image"] ?? "") || !args["--output"])
  throw new Error("EXAMPLE_REQUIRES_IMMUTABLE_IMAGE_AND_FRESH_OUTPUT");
if (args["--docker-context"] && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(args["--docker-context"]))
  throw new Error("EXAMPLE_DOCKER_CONTEXT");
if (typeof registerHooks !== "function") throw new Error("EXAMPLE_REQUIRES_NODE_REGISTER_HOOKS");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(args["--output"]);
// No reuse/overwrite of old evidence or managed projects, even after a failed run.
await mkdir(output, { mode: 0o700 });
assert.equal(await realpath(output), output, "output must be a canonical directory");
const report = { kind: "deterministic-cart-tool-smoke", status: "running", modelRequests: 0, steps: [], checks: {} };
const started = performance.now(),
  hosts = [],
  diagnostics = [];
const hash = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const save = () => writeFile(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let dockerContext;
const docker = (command) =>
  execFileSync("docker", ["--context", dockerContext, ...command], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env
  });
const id = (name) => "cart-example-" + name.replaceAll("/", "-").replaceAll(".", "-");
let jobFile;
async function step(name, fn) {
  const start = performance.now();
  const value = await fn();
  report.steps.push({ name, durationMs: performance.now() - start });
  await save();
  process.stderr.write(JSON.stringify({ step: name, completed: true }) + "\n");
  return value;
}
async function noWriterLock(workspace, projectKey) {
  await assert.rejects(lstat(join(workspace, ".agent-sync/state", projectKey, ".writer.lock")), { code: "ENOENT" });
}
try {
  dockerContext =
    args["--docker-context"] ??
    execFileSync("docker", ["context", "show"], { encoding: "utf8", timeout: 30000 }).trim();
  const core = await import("@onevcat/argue/agent-sync/project");
  const hostApi = await import("@onevcat/argue-cli/agent-sync/project");
  const { ToolHost } = await import("../../../tools/agent-sync/client.mjs");
  const { prepareCart } = await import("./project.mjs");
  const image = args["--image"];
  assert.equal(docker(["image", "inspect", image, "--format", "{{.Id}}"]).trim(), image);
  // Source-free metadata only. Real candidate checks still use the original verifier.
  const imageMetadata = JSON.parse(
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "65532:65532",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--cpus",
      "1",
      image,
      "/opt/validator/describe.mjs"
    ])
  );
  const sourceRoot = join(output, "source"),
    trustedRoot = join(output, "trusted");
  const workspaceRoot = join(output, "managed"),
    home = join(output, "home");
  for (const path of [sourceRoot, trustedRoot, workspaceRoot, home]) await mkdir(path, { mode: 0o700 });
  const prepared = await prepareCart({
    fixtureRoot: dirname(fileURLToPath(import.meta.url)),
    sourceRoot,
    trustedRoot,
    imageMetadata,
    variant: "one"
  });
  const config = hostApi.freezeTrustedCheckConfig(prepared.config);
  const project = core.freezeAgentSyncProject({
    ...prepared.project,
    checkConfigurationHash: hostApi.configurationHash(config)
  });
  const options = {
    sourceRoot,
    trustedRoot,
    workspaceRoot,
    home,
    project,
    config,
    image,
    dockerContext,
    runId: "cart-checkout-example",
    programRoot: join(repo, "tools")
  };
  jobFile = join(output, "job.json");
  await writeFile(
    jobFile,
    JSON.stringify({ options, connections: { admin: { role: "host" }, worker: { workerId: "cart-owner" } } }, null, 2) +
      "\n",
    { mode: 0o600 }
  );
  report.environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dockerContext,
    image,
    imageMetadata
  };
  report.identities = {
    planHash: project.planHash,
    configurationHash: project.checkConfigurationHash,
    resources: project.resources,
    sourceManifest: project.manifest
  };
  const statePath = join(workspaceRoot, ".agent-sync/state", project.projectKey, "session.json");
  const state = async () => JSON.parse(await readFile(statePath, "utf8"));
  const startHost = () => {
    const host = new ToolHost({
      entry: join(repo, "tools/agent-sync/dist/stdio.mjs"),
      configFile: jobFile,
      cwd: output,
      trace: true,
      onDiagnostic: (d) => diagnostics.push(d)
    });
    hosts.push(host);
    return host;
  };
  const close = async (host, name) => {
    const result = await host.client("admin").call("close", {}, id(name));
    assert.equal(result.result.writerReleased, true);
    assert.equal((await host.exited).code, 0);
    await noWriterLock(workspaceRoot, project.projectKey);
  };
  const host = startHost();
  const ready = await step("start", () => host.ready);
  const baseline = ready.status.acceptedVersion;
  const granted = await step("request-scope", () => host.client("worker").requestScope("complete-cart", id("scope")));
  assert.equal(granted.result.kind, "granted");
  const task = granted.task;
  const input = await step("freeze-input", () => task.freezeInput(id("freeze")));
  assert.equal(input.baseVersion, baseline);
  const texts = { "lib/amount.ts": prepared.texts["amount-guards"], "lib/receipt.ts": prepared.texts["receipt-lines"] };
  for (const [path, text] of Object.entries(texts)) {
    const current = await step("read-" + path, () => task.read(path, id("read-" + path.replaceAll("/", "-"))));
    assert.equal(current.contentHash, input.contentHashes[path]);
    await step("edit-" + path, () =>
      task.edit([{ path, expectedContentHash: current.contentHash, text }], id("edit-" + path.replaceAll("/", "-")))
    );
  }
  await step("seal", () => task.seal(id("seal")));
  const checked = await step("private-check", () => task.check(id("check")));
  assert.equal(checked.receipt.passed, true);
  const beforeFinish = await state();
  assert.equal(beforeFinish.acceptedVersion, baseline);
  assert.equal(beforeFinish.publishReceipts.length, 0);
  report.checks.privateCheckIsNotPublication = true;
  const published = await step("finish", () => task.finish(id("finish")));
  assert.equal(published.status, "accepted");
  const actual = await state();
  assert.equal(actual.status, "completed");
  assert.equal(actual.publishReceipts.length, 1);
  assert.equal(actual.acceptedVersion, published.receipt.acceptedVersion);
  const formal = actual.checkReceipts.find((r) => r.receiptId === published.receipt.checkReceiptId);
  assert.equal(formal.passed, true);
  assert.deepEqual([...formal.groups].sort(), ["invalid", "joint", "lines", "money"]);
  report.publication = {
    receiptId: published.receipt.receiptId,
    checkReceiptId: formal.receiptId,
    baselineVersion: baseline,
    acceptedVersion: actual.acceptedVersion,
    groups: formal.groups
  };
  const admin = host.client("admin");
  const diff = (await step("diff", () => admin.call("diff", {}, id("diff")))).result;
  assert.deepEqual(diff.files.map((f) => f.path).sort(), Object.keys(texts).sort());
  const exported = (
    await step("export", () => admin.call("exportVersion", { target: join(output, "export") }, id("export")))
  ).result;
  report.exportedFiles = [];
  for (const entry of project.manifest) {
    const bytes = await readFile(join(exported.directory, entry.path));
    const expected = Object.hasOwn(texts, entry.path)
      ? Buffer.from(texts[entry.path])
      : await readFile(join(sourceRoot, entry.path));
    assert.deepEqual(bytes, expected);
    report.exportedFiles.push({ path: entry.path, hash: hash(bytes) });
  }
  await step("close", () => close(host, "close"));
  const oracleBefore = diagnostics.filter((d) => d.event === "child-start" && d.subsystem === "oracle").length;
  const reopenOptions = { ...options };
  delete reopenOptions.sourceRoot;
  jobFile = join(output, "job-reopen.json");
  await writeFile(
    jobFile,
    JSON.stringify(
      { options: reopenOptions, connections: { admin: { role: "host" }, worker: { workerId: "cart-owner" } } },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  const reopened = startHost();
  const reopenedReady = await step("reopen-without-source", () => reopened.ready);
  assert.equal(reopenedReady.status.acceptedVersion, actual.acceptedVersion);
  const recovered = (await step("recover", () => reopened.client("admin").call("recover", {}, id("recover")))).result;
  assert.equal(recovered.replayedActions, 0);
  const afterRecovery = await state();
  assert.equal(afterRecovery.acceptedVersion, actual.acceptedVersion);
  assert.equal(afterRecovery.publishReceipts.length, actual.publishReceipts.length);
  assert.equal(afterRecovery.checkReceipts.length, actual.checkReceipts.length);
  assert.equal(afterRecovery.deadlineAt, actual.deadlineAt);
  assert(afterRecovery.ownerEpoch > actual.ownerEpoch);
  assert.equal(diagnostics.filter((d) => d.event === "child-start" && d.subsystem === "oracle").length, oracleBefore);
  report.checks.recoveryZeroReplayAndChecks = true;
  await step("close-reopened", () => close(reopened, "close-reopened"));
  report.checks.writerReleasedBothTimes = true;
  report.containerCleanup = [];
  for (const containerId of new Set(
    diagnostics.filter((d) => d.event === "container-created").map((d) => d.containerId)
  )) {
    let absent = false;
    try {
      docker(["inspect", containerId]);
    } catch (error) {
      absent = error.status === 1 && /No such (object|container)/i.test(String(error.stderr));
    }
    assert(absent, "this example's container must have been removed");
    report.containerCleanup.push({ containerId, absent });
  }
  assert.equal(fetchAttempts, 0);
  report.checks.exportMatchesEveryManifestFile = true;
  report.status = "verified";
} catch (error) {
  report.status = "failed";
  report.error = { code: error.code ?? error.name, message: String(error.message).slice(0, 200) };
  process.exitCode = 1;
} finally {
  // Only child tools created above are eligible for cleanup; never enumerate/kill peers.
  for (const host of hosts)
    if (!host.closed) {
      try {
        await host.client("admin").call("close", {}, id("failure-close"));
      } catch {
        host.child.kill("SIGTERM");
      }
      await host.exited;
    }
  report.fetchAttempts = fetchAttempts;
  report.elapsedMs = performance.now() - started;
  report.diagnostics = diagnostics;
  await save();
}
process.stdout.write(
  JSON.stringify({ status: report.status, output, elapsedMs: report.elapsedMs, modelRequests: 0 }) + "\n"
);
