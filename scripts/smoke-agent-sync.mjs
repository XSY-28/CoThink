import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), "..");
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
/** Keep actionable backend reasons without serializing arbitrary error/value objects. */
export function safeFailure(error, secrets) {
  const scrub = (input, limit) => {
    let text = typeof input === "string" ? input : "";
    for (const secret of secrets)
      if (typeof secret === "string" && secret.length) text = text.replaceAll(secret, "<redacted>");
    // Assertion/schema messages can contain arbitrary object dumps. Keep their reason only.
    text = text.split(/\r?\n/)[0].replace(/[[{][\s\S]*/, "<structured details omitted>");
    text = text.replace(/\b(?:token|nonce|lease)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, "<capability omitted>");
    return text.slice(0, limit);
  };
  const causes = [],
    seen = new Set();
  let current = error;
  while (current instanceof Error && causes.length < 6 && !seen.has(current)) {
    seen.add(current);
    const name = scrub(current.name, 80);
    const message =
      name === "AssertionError"
        ? "Assertion failed; value dumps omitted"
        : name === "ZodError"
          ? "Schema validation rejected; value dumps omitted"
          : scrub(current.message, 360);
    const frames =
      typeof current.stack === "string"
        ? current.stack
            .split("\n")
            .filter((line) => line.startsWith("    at "))
            .map((line) => line.match(/(?:file:\/\/)?(\/[^()\s]+\.(?:m?js|ts):\d+:\d+)/)?.[1])
            .filter(
              (location) =>
                location && (location.startsWith(`${repo}/scripts/`) || location.startsWith(`${repo}/packages/argue`))
            )
            .slice(0, 8)
            .map((location) => scrub(location, 240))
        : [];
    causes.push({ name, code: scrub(typeof current.code === "string" ? current.code : "", 80), message, frames });
    current = current.cause;
  }
  return { causes, truncated: current instanceof Error && !seen.has(current) };
}

async function treeHashes(root, prefix = "") {
  const values = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), "fixture links forbidden");
    if (entry.isDirectory()) Object.assign(values, await treeHashes(root, path));
    else {
      assert.ok(entry.isFile());
      values[path] = sha(await readFile(join(root, path)));
    }
  }
  return values;
}

export function sanitizedEnvironment(input) {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "COTHINK_BUILD_VALIDATOR_IMAGE",
      "COTHINK_AGENT_SYNC_EVIDENCE",
      "COTHINK_AGENT_SYNC_STATIC_METAFILE"
    ]
      .filter((key) => typeof input[key] === "string")
      .map((key) => [key, input[key]])
  );
}

/** Bound output and wall time, and terminate only the group created by this call. */
export function runBounded(command, args, { env, cwd = repo, timeoutMs = 10000, maxOutputBytes = 1024 * 1024 } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      timedOut = false,
      outputExceeded = false,
      spawnFailed = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const interrupt = () => kill();
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const collect = (name, buffer) => {
      const keep = buffer.subarray(0, Math.max(0, maxOutputBytes - bytes));
      if (name === "stdout") stdout += keep.toString("utf8");
      else stderr += keep.toString("utf8");
      bytes += buffer.length;
      if (bytes > maxOutputBytes) {
        outputExceeded = true;
        kill();
      }
    };
    child.stdout.on("data", (buffer) => collect("stdout", buffer));
    child.stderr.on("data", (buffer) => collect("stderr", buffer));
    child.on("error", () => {
      spawnFailed = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      done({ code, signal, stdout, stderr, timedOut, outputExceeded, spawnFailed, command, args });
    });
  });
}

export async function guardedChild(mode, root, env) {
  const trace = join(root, `${mode}-imports.jsonl`);
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(new URL("./agent-sync-import-guard.mjs", import.meta.url).href)}, { data: { trace: ${JSON.stringify(trace)} } });`;
  return runBounded(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(registration)}`, "--", script, `--${mode}`, root],
    {
      env,
      timeoutMs: mode === "worker" ? 2400000 : 10000
    }
  );
}

async function harness(mode) {
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error("MODEL_FETCH_DENIED");
  };
  if (mode === "negative") {
    await assert.rejects(import("@onevcat/argue-cli"), (error) => error.code === "AGENT_SYNC_IMPORT_DENIED");
    assert.equal(fetchCalls, 0);
    console.log("ROOT_GUARD_REJECTED");
  } else {
    const { LocalAgentSync } = await import("@onevcat/argue-cli/agent-sync");
    assert.equal(typeof LocalAgentSync, "function");
    assert.equal(fetchCalls, 0);
    console.log("NEUTRAL_IMPORT_OK");
  }
}

async function staticAudit(path) {
  assert.ok(path, "static metafile artifact required");
  const text = await readFile(path, "utf8");
  const metadata = JSON.parse(text);
  const inputs = Object.keys(metadata.inputs);
  const forbidden =
    /(?:packages\/argue\/src\/(?:index\.ts|build\/(?:index|driver|requests)\.ts|core\/|discussion\/|transport\/)|packages\/argue-cli\/src\/(?:index\.ts|runtime\/|model-api\/|discussion\/|peer\/|build\/(?:runtime|config|commands|discussion-link)\.ts|config\.ts|env[^/]*\.ts)|node_modules\/(?:@ai-sdk\/|ai\/))/;
  assert.deepEqual(
    inputs.filter((path) => forbidden.test(path)),
    []
  );
  const external = Object.values(metadata.outputs).flatMap((o) =>
    o.imports.filter((i) => i.external).map((i) => i.path)
  );
  assert.deepEqual(
    external.filter((p) => /^(?:@onevcat\/argue(?:\/|$)|@ai-sdk\/|ai$|dotenv(?:\/|$))/.test(p)),
    []
  );
  for (const file of [
    "file-store",
    "git-snapshots",
    "workspace",
    "validator",
    "publisher",
    "recovery",
    "local-sync-adapter"
  ])
    assert.ok(inputs.includes(`packages/argue-cli/src/build/${file}.ts`));
  for (const file of ["packages/argue-cli/src/agent-sync/local.ts", "packages/argue/src/agent-sync/service.ts"])
    assert.ok(inputs.includes(file));
  const hashesPath = path.replace(/\.json$/, "-source-hashes.json");
  const sourceHashes = await json(hashesPath);
  assert.deepEqual(Object.keys(sourceHashes).sort(), [...inputs].sort());
  for (const file of inputs) assert.equal(sha(await readFile(resolve(repo, file))).slice(7), sourceHashes[file], file);
  return {
    path,
    hash: sha(text),
    sourceHashesPath: hashesPath,
    sourceHashesVerified: true,
    provenance:
      "parent-generated esbuild metafile; exact options recorded by sibling archive-static.mjs; existing neutral entry regression retained",
    inputCount: inputs.length,
    inputs,
    external
  };
}

async function runtimeAudit(root, mode) {
  const path = join(root, `${mode}-imports.jsonl`);
  const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  const denied = lines.filter((r) => r.decision === "denied");
  assert.equal(denied.length, mode === "negative" ? 1 : 0);
  if (mode !== "negative")
    for (const suffix of [
      "argue-cli/dist/agent-sync/local.js",
      "argue-cli/dist/build/file-store.js",
      "argue-cli/dist/build/git-snapshots.js",
      "argue-cli/dist/build/workspace.js",
      "argue-cli/dist/build/validator.js",
      "argue-cli/dist/build/publisher.js",
      "argue-cli/dist/build/recovery.js",
      "argue/dist/agent-sync/service.js",
      "argue/dist/peer/hash.js"
    ])
      assert.ok(
        lines.some((r) => r.url.endsWith(suffix)),
        suffix
      );
  return { path, resolutions: lines.length, denied: denied.length };
}

async function cleanupContainers(root, env) {
  const listed = await runBounded("docker", ["ps", "-aq"], { env });
  if (listed.code !== 0) return { available: false, removed: 0 };
  const ids = listed.stdout
    .trim()
    .split(/\s+/)
    .filter((id) => /^[a-f0-9]{12,64}$/.test(id));
  assert.ok(ids.length <= 256, "container inventory exceeds bounded cleanup limit");
  if (!ids.length) return { available: true, removed: 0 };
  const inspected = await runBounded("docker", ["inspect", ...ids], {
    env,
    timeoutMs: 30000,
    maxOutputBytes: 8 * 1024 * 1024
  });
  assert.equal(inspected.code, 0);
  const own = JSON.parse(inspected.stdout)
    .filter((container) =>
      container.Mounts?.some((mount) => mount.Source?.startsWith(join(root, "backend-temp") + sep))
    )
    .map((container) => container.Id);
  if (own.length) {
    const deletion = await runBounded("docker", ["rm", "-f", ...own], { env, timeoutMs: 30000 });
    assert.equal(deletion.code, 0);
  }
  const removed = own.length;
  return { available: true, removed };
}

async function launcher() {
  const evidenceBase = resolve(process.env.COTHINK_AGENT_SYNC_EVIDENCE ?? join(repo, "../work/agent-sync-stage6"));
  await mkdir(evidenceBase, { recursive: true });
  const root = await realpath(await mkdtemp(join(evidenceBase, "neutral-acceptance-")));
  const evidence = {
    gate: "stage6-compiled-neutral-transaction",
    status: "NOT VERIFIED",
    startedAt: new Date().toISOString(),
    clockMode: "real Date.now",
    launcherCommand: [process.execPath, "--", script],
    root
  };
  const env = sanitizedEnvironment(process.env);
  env.TMPDIR = join(root, "backend-temp");
  await mkdir(env.TMPDIR);
  let worker;
  try {
    assert.match(env.COTHINK_BUILD_VALIDATOR_IMAGE ?? "", /^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/);
    const inspected = await runBounded("docker", ["image", "inspect", env.COTHINK_BUILD_VALIDATOR_IMAGE], { env });
    if (inspected.code !== 0) throw new Error("DOCKER_IMAGE_UNAVAILABLE");
    evidence.imageId = JSON.parse(inspected.stdout)[0].Id;
    assert.match(evidence.imageId, /^sha256:[a-f0-9]{64}$/);
    evidence.staticImports = await staticAudit(env.COTHINK_AGENT_SYNC_STATIC_METAFILE);
    for (const mode of ["positive", "negative"]) {
      const result = await guardedChild(mode, root, env);
      assert.equal(result.code, 0, `${mode} control failed`);
      evidence[`${mode}Control`] = {
        code: result.code,
        marker: result.stdout.trim(),
        ...(await runtimeAudit(root, mode))
      };
    }
    worker = await guardedChild("worker", root, env);
    evidence.worker = {
      command: worker.command,
      args: worker.args,
      code: worker.code,
      signal: worker.signal,
      timedOut: worker.timedOut,
      outputExceeded: worker.outputExceeded,
      spawnFailed: worker.spawnFailed
    };
    assert.equal(worker.code, 0, "acceptance worker failed; inspect safe worker evidence");
    evidence.transaction = await json(join(root, "transaction.json"));
    assert.equal(evidence.transaction.status, "VERIFIED");
    evidence.runtimeImports = await runtimeAudit(root, "worker");
    evidence.status = "VERIFIED";
  } catch (error) {
    evidence.status = worker ? "FAILED" : "NOT VERIFIED";
    evidence.failure = { code: error.code ?? "ACCEPTANCE_ASSERTION", message: error.message };
    process.exitCode = 1;
  } finally {
    try {
      evidence.cleanup = await cleanupContainers(root, env);
    } catch {
      evidence.cleanup = { available: true, failed: true };
      evidence.status = "FAILED";
      process.exitCode = 1;
    }
    evidence.wallElapsedMs = Date.now() - Date.parse(evidence.startedAt);
    const path = join(root, evidence.status === "VERIFIED" ? "verified.json" : "failed.json");
    await save(path, evidence);
    console.log(JSON.stringify({ status: evidence.status, evidence: path }));
  }
}

async function transaction(root) {
  const startedAt = Date.now();
  const evidence = { status: "FAILED", clockMode: "real Date.now", events: [] };
  const secrets = [];
  const record = async (event) => {
    evidence.events.push(event);
    await writeEvidence();
  };
  const writeEvidence = async () => {
    const output = JSON.stringify(evidence);
    for (const secret of secrets) assert.ok(!output.includes(secret), "evidence leaked capability");
    assert.ok(!/"(?:token|nonce|lease)"\s*:/.test(output));
    await save(join(root, "transaction.json"), evidence);
  };
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error("MODEL_FETCH_DENIED");
  };
  try {
    assert.deepEqual(
      Object.keys(process.env).filter((key) => /(?:API|MODEL|NODE_OPTIONS|TOKEN|SECRET|KEY)/i.test(key)),
      []
    );
    evidence.modelEnvironmentAbsent = true;
    const { LocalAgentSync } = await import("@onevcat/argue-cli/agent-sync");
    const source = join(root, "source");
    const workspaceRoot = join(root, "workspace");
    await cp(join(repo, "examples/todo-stats"), source, {
      recursive: true,
      filter: (path) => !path.includes("node_modules")
    });
    await mkdir(workspaceRoot);
    const originalTree = await treeHashes(source);
    const planBytes = await readFile(join(source, "build-plan.json"));
    const plan = JSON.parse(planBytes.toString("utf8"));
    assert.equal(plan.manifest.length, 11);
    const original = Object.fromEntries(
      await Promise.all(plan.manifest.map(async ({ path }) => [path, await readFile(join(source, path))]))
    );
    const oracle = async (name) =>
      (await readFile(join(source, `test/oracle/${name}.ts`), "utf8")).replaceAll("../../src/types.js", "./types.js");
    const correctA = await oracle("correct-state"),
      correctB1 = await oracle("correct-report"),
      correctB2 = await oracle("correct-final");
    const statePath = join(workspaceRoot, ".cothink-build/state", plan.projectKey, "session.json");
    const state = () => json(statePath); // Observe authoritative state; never write or import it.
    const stateBytes = () => readFile(statePath, "utf8");
    const options = {
      workspaceRoot,
      sourceRoot: source,
      plan,
      runId: "neutral-stage6",
      image: process.env.COTHINK_BUILD_VALIDATOR_IMAGE,
      repoRoot: repo
    };
    evidence.source = {
      source,
      workspaceRoot,
      planHash: plan.planHash,
      planFileHash: sha(planBytes),
      wholeSourceHashes: originalTree,
      originalHashes: Object.fromEntries(Object.entries(original).map(([path, bytes]) => [path, sha(bytes)]))
    };
    let escapedService, escapedClient, escapedLease, finalVersion, durable;
    const capture = (result) => {
      assert.equal(result.kind, "granted");
      secrets.push(result.lease.token);
      return result.lease;
    };
    const refused = async (operation, code) =>
      assert.rejects(operation, (error) => (code ? error.code === code : typeof error.code === "string"));
    await new LocalAgentSync(options).withSession(async (service) => {
      escapedService = service;
      const a = service.forWorker("member-a"),
        b = service.forWorker("member-b");
      escapedClient = b;
      const v0 = (await service.status()).acceptedVersion;
      const initialized = await state();
      evidence.deadlines = {
        startedAt: initialized.startedAt,
        deadlineAt: initialized.deadlineAt,
        budget: initialized.plan.budget
      };
      const la = capture(await a.requestScope("T-A", "scope-a"));
      const waiting = await b.requestScope("T-B2", "scope-b2-wait");
      assert.equal(waiting.kind, "waiting");
      assert.equal(await b.currentLease("T-B2"), null);
      const lb1 = capture(await b.requestScope("T-B1", "scope-b1"));
      assert.deepEqual(await a.currentLease("T-A"), la);
      assert.deepEqual(await b.currentLease("T-B1"), lb1);
      const status = await service.status();
      const publicText = JSON.stringify(status);
      for (const secret of secrets) assert.ok(!publicText.includes(secret));
      assert.ok(!/token|nonce/.test(publicText));
      await refused(() => b.read(lb1, "b1-scope-violation", "src/normalize.ts"), "scope_violation");
      evidence.waitAndIndependence = {
        waitingTask: "T-B2",
        independentTask: "T-B1",
        concurrentTask: "T-A",
        waitingLease: false,
        statusRedacted: true,
        crossScopeReadRejected: true
      };
      await record("independent A/B1 grants coexist while B2 waits; worker scope and status redaction enforced");
      await a.freezeInput(la, "freeze-a");
      await b.freezeInput(lb1, "freeze-b1");
      const ra = await a.read(la, "read-a", "src/normalize.ts"),
        rb1 = await b.read(lb1, "read-b1", "src/report.ts");
      await a.edit(la, "edit-a", [{ path: "src/normalize.ts", text: correctA, expectedContentHash: ra.contentHash }]);
      await b.edit(lb1, "edit-b1", [{ path: "src/report.ts", text: correctB1, expectedContentHash: rb1.contentHash }]);
      await record("A/B1 private edits match host oracle texts with expected content hashes");
      const sealedA = await a.seal(la, "seal-a");
      const standaloneA = await a.check(la, "check-a", sealedA);
      assert.equal(standaloneA.receipt.passed, true);
      assert.equal((await service.status()).acceptedVersion, v0);
      assert.equal((await state()).publishReceipts.length, 0);
      assert.equal((await state()).checkReceipts.length, 0);
      const acceptedA = await a.finish(la, "finish-a");
      const beforeReplay = await stateBytes();
      assert.deepEqual(await a.finish(la, "finish-a"), acceptedA);
      assert.equal(await stateBytes(), beforeReplay);
      const acceptedB1 = await b.finish(lb1, "finish-b1");
      assert.equal(acceptedB1.receipt.baseVersion, acceptedA.receipt.acceptedVersion);
      await record(
        "A standalone actual Docker check did not publish; A/B1 Publisher checks accepted; finish replay preserved exact state bytes"
      );
      const lb2 = capture(await b.requestScope("T-B2", "scope-b2-latest"));
      const frozenB2 = await b.freezeInput(lb2, "freeze-b2-before-recovery");
      assert.equal(frozenB2.baseVersion, acceptedB1.receipt.acceptedVersion);
      const observedA = await b.read(lb2, "read-b2-before-recovery", "src/normalize.ts");
      assert.equal(observedA.text, correctA);
      assert.equal(observedA.contentHash, sha(correctA));
      const beforeRecovery = await state();
      const recovered = await service.recover("recover-before-b2");
      const afterRecovery = await state();
      assert.equal(recovered.acceptedVersion, acceptedB1.receipt.acceptedVersion);
      assert.equal(recovered.replayedActions, 0);
      assert.equal(recovered.status, "paused");
      for (const key of ["acceptedVersion", "checkReceipts", "publishReceipts", "calls", "workspace"])
        assert.deepEqual(afterRecovery[key], beforeRecovery[key]);
      await refused(() => b.read(lb2, "read-b2-stale-new", "src/normalize.ts"));
      assert.deepEqual(await b.read(lb2, "read-b2-before-recovery", "src/normalize.ts"), observedA);
      await record(
        "B2 read newest accepted normalizer; explicit recovery preserved checks/publications/workspace and rejected new stale action"
      );
      const resumed = capture(await b.requestScope("T-B2", "scope-b2-resume"));
      assert.notEqual(resumed.token, lb2.token);
      const frozenResumed = await b.freezeInput(resumed, "freeze-b2-resumed");
      assert.equal(frozenResumed.baseVersion, acceptedB1.receipt.acceptedVersion);
      const rb2 = await b.read(resumed, "read-b2-resumed", "src/normalize.ts");
      assert.equal(rb2.text, correctA);
      await b.edit(resumed, "edit-b2", [
        { path: "src/normalize.ts", text: correctB2, expectedContentHash: rb2.contentHash }
      ]);
      const sealedB2 = await b.seal(resumed, "seal-b2");
      const standaloneB2 = await b.check(resumed, "check-b2", sealedB2);
      assert.equal(standaloneB2.receipt.passed, true);
      assert.equal((await service.status()).acceptedVersion, acceptedB1.receipt.acceptedVersion);
      await record("resumed B2 standalone final Docker check passed without changing accepted pointer");
      const acceptedB2 = await b.finish(resumed, "finish-b2");
      finalVersion = acceptedB2.receipt.acceptedVersion;
      escapedLease = resumed;
      assert.equal((await service.status()).status, "completed");
      const diff = await service.diff({ fromVersion: v0 });
      assert.deepEqual(
        diff.files.map((f) => f.path),
        ["src/normalize.ts", "src/report.ts"]
      );
      assert.equal(diff.toVersion, finalVersion);
      evidence.diff = diff;
      evidence.recovery = {
        replayedActions: 0,
        calls: afterRecovery.calls.length,
        acceptedVersion: recovered.acceptedVersion,
        checksUnchanged: true,
        publicationsUnchanged: true,
        workspaceUnchanged: true,
        oldNewActionDenied: true,
        historicalReadReplay: true,
        resumedBase: frozenResumed.baseVersion,
        observedAHash: observedA.contentHash
      };
      evidence.exports = [];
      for (const target of [join(root, "export-one"), join(root, "export-two")]) {
        const exported = await service.exportVersion({ target });
        assert.equal(exported.version, finalVersion);
        const hashes = {};
        for (const { path } of plan.manifest) {
          const bytes = await readFile(join(target, path));
          const expected =
            path === "src/normalize.ts"
              ? Buffer.from(correctB2)
              : path === "src/report.ts"
                ? Buffer.from(correctB1)
                : original[path];
          assert.ok(bytes.equals(expected));
          hashes[path] = sha(bytes);
        }
        evidence.exports.push({ version: exported.version, directory: target, hashes });
      }
      durable = await state();
      assert.deepEqual(durable.acceptedTasks, ["T-A", "T-B1", "T-B2"]);
      assert.equal(durable.acceptedVersion, finalVersion);
      assert.equal(durable.startedAt, initialized.startedAt);
      assert.equal(durable.deadlineAt, initialized.deadlineAt);
      assert.deepEqual(durable.plan, initialized.plan);
      assert.equal(durable.publishReceipts.length, 3);
      assert.equal(durable.checkReceipts.length, 3);
      assert.deepEqual(durable.calls, []);
      assert.deepEqual(durable.checkReceipts.at(-1).groups, ["common", "state-format", "report", "identity", "final"]);
      for (const check of durable.checkReceipts) {
        assert.equal(check.passed, true);
        assert.equal(check.sourceHashBefore, check.sourceHashAfter);
      }
      const sessionFiles = (await readdir(dirname(statePath))).filter((name) => name === "session.json");
      assert.equal(sessionFiles.length, 1);
      evidence.authoritativeState = {
        pointerFiles: sessionFiles,
        acceptedVersion: finalVersion,
        acceptedTasks: durable.acceptedTasks,
        checkReceipts: durable.checkReceipts.map(
          ({ receiptId, groups, passed, imageDigest, sourceHashBefore, sourceHashAfter }) => ({
            receiptId,
            groups,
            passed,
            imageDigest,
            sourceHashBefore,
            sourceHashAfter
          })
        ),
        publications: durable.publishReceipts.map(
          ({ receiptId, requestId, baseVersion, acceptedVersion, checkReceiptId }) => ({
            receiptId,
            requestId,
            baseVersion,
            acceptedVersion,
            checkReceiptId
          })
        ),
        calls: 0
      };
      evidence.standaloneChecks = [standaloneA, standaloneB2].map(({ requestId, receipt }) => ({
        requestId,
        receiptId: receipt.receiptId,
        groups: receipt.groups,
        passed: receipt.passed
      }));
      evidence.finalOracle = {
        source: "examples/todo-stats/test/final.test.ts",
        expected: "4/1/2/1",
        assertion:
          "actual passing frozen final group asserts exact CLI summary and edge cases; stdout not fabricated or separately captured"
      };
    });
    const closedBytes = await stateBytes();
    await refused(() => escapedService.status(), "service_closed");
    await refused(() => escapedClient.read(escapedLease, "closed-client-read", "src/normalize.ts"), "service_closed");
    assert.equal(await stateBytes(), closedBytes);
    const reopenOptions = { ...options };
    delete reopenOptions.sourceRoot;
    await new LocalAgentSync(reopenOptions).withSession(async (service) => {
      assert.equal((await service.status()).acceptedVersion, finalVersion);
      const before = await state();
      assert.equal(before.deadlineAt, evidence.deadlines.deadlineAt);
      const recovery = await service.recover("recover-new-instance");
      assert.equal(recovery.replayedActions, 0);
      assert.equal(recovery.status, "completed");
      const after = await state();
      for (const key of ["acceptedVersion", "checkReceipts", "publishReceipts", "calls", "workspace"])
        assert.deepEqual(after[key], before[key]);
      assert.deepEqual(after.publishReceipts, durable.publishReceipts);
      assert.equal(after.deadlineAt, evidence.deadlines.deadlineAt);
      assert.equal(after.startedAt, evidence.deadlines.startedAt);
      assert.deepEqual(after.plan, durable.plan);
      assert.equal((await service.exportVersion({ target: join(root, "export-one") })).version, finalVersion);
      assert.equal(await service.forWorker("member-b").currentLease("T-B2"), null);
    });
    for (const [path, bytes] of Object.entries(original)) assert.ok((await readFile(join(source, path))).equals(bytes));
    assert.ok((await readFile(join(source, "build-plan.json"))).equals(planBytes));
    assert.deepEqual(await treeHashes(source), originalTree);
    assert.equal(fetchCalls, 0);
    evidence.modelFetchCalls = fetchCalls;
    evidence.modelCalls = 0;
    evidence.reopenWithoutSource = {
      acceptedVersion: finalVersion,
      receiptsPreserved: true,
      replayedActions: 0,
      exactTargetExportRetry: true
    };
    evidence.closedCapabilitiesDenied = true;
    evidence.originalSourceUnchanged = true;
    evidence.wallElapsedMs = Date.now() - startedAt;
    evidence.status = "VERIFIED";
    await record(
      "all eleven export files match frozen golden bytes; fresh host recovery preserves acceptance; source unchanged; escaped capabilities closed"
    );
  } catch (error) {
    evidence.failure = safeFailure(error, secrets);
    evidence.wallElapsedMs = Date.now() - startedAt;
    await writeEvidence();
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const mode = process.argv[2];
  if (mode === "--positive" || mode === "--negative") await harness(mode.slice(2));
  else if (mode === "--worker") await transaction(process.argv[3]);
  else await launcher();
}
