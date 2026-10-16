/** Local compiled-checkout gate. Controlled HTTP replies are host fixtures, not AI ability. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { setTimeout, clearTimeout } from "node:timers";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";

const privateMarkers = ["smoke-fake-a", "smoke-fake-b", "BUILD_PRIVATE_PROVIDER_SENTINEL"];
/** Output is admitted before attaching it to evidence. Rejected bytes never escape this projection. */
export function projectSmokeOutput(stdout, stderr) {
  const text = stdout + stderr;
  const rejected =
    privateMarkers.some((marker) => text.includes(marker)) ||
    /"(?:token|nonce|apiKey|authorization|rawContent|reasoning_content|messages)"\s*:/i.test(text);
  return rejected
    ? {
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        errorCode: "SMOKE_PUBLIC_OUTPUT_REJECTED"
      }
    : { stdout, stderr };
}
/** Errors may embed assertion actuals/provider bodies: retain only program-owned codes. */
export function smokeFailure(error) {
  const message = error instanceof Error ? error.message : "";
  return {
    code: /^(?:BUILD|SMOKE)_[A-Z0-9_]{1,80}$/.test(message)
      ? message
      : error?.name === "AssertionError"
        ? "SMOKE_ASSERTION_FAILED"
        : "SMOKE_OPERATION_FAILED"
  };
}
export async function boundedSmokeWait(pending, timeoutMs, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, no) => {
        timer = setTimeout(() => {
          onTimeout();
          no(new Error("SMOKE_BARRIER_TIMEOUT"));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Independent harness limit, never substituted for a construction budget. */
export function spawnSmokeProcess(executable, args, options = {}) {
  const { timeoutMs = 480000, maxOutputBytes = 16 * 1024 * 1024, ...spawnOptions } = options;
  // Separate Node startup options from a script's flags (notably --env-file).
  const script = executable === process.execPath && args.length > 0 && !args[0].startsWith("-");
  const child = spawn(executable, script ? ["--", ...args] : args, {
    ...spawnOptions,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "",
    stderr = "",
    timedOut = false,
    overflow = false;
  let timer, reapTimer;
  const done = new Promise((yes, no) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      clearTimeout(reapTimer);
      callback(value);
    };
    const stop = () => {
      child.kill("SIGKILL");
      reapTimer ??= setTimeout(() => finish(no, new Error("SMOKE_CHILD_REAP_TIMEOUT")), 5000);
    };
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const collect = (part, channel) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + part.length > maxOutputBytes) {
        overflow = true;
        stop();
        return;
      }
      if (channel === "stdout") stdout += part;
      else stderr += part;
    };
    child.stdout.on("data", (part) => collect(part, "stdout"));
    child.stderr.on("data", (part) => collect(part, "stderr"));
    child.once("error", () => finish(no, new Error("SMOKE_CHILD_SPAWN_FAILED")));
    child.once("close", (code, signal) => finish(yes, { code, signal, stdout, stderr, timedOut, overflow }));
  });
  return { child, done };
}

export function assertSmokeConsumerLive(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    throw new Error("SMOKE_LIVE_CANCEL_CHECKPOINT_MISSED");
  try {
    process.kill(child.pid, 0);
  } catch {
    throw new Error("SMOKE_LIVE_CANCEL_CHECKPOINT_MISSED");
  }
}
export function smokeLateEdit(input, path, text) {
  const expectedContentHash = input.input.files.find((file) => file.path === path)?.contentHash;
  if (typeof expectedContentHash !== "string") throw new Error("SMOKE_LATE_REQUEST_HASH_MISSING");
  return {
    actionVersion: input.actionVersion,
    requestId: input.requestId,
    action: { kind: "edit", path, text, expectedContentHash }
  };
}
export async function observeSmokeState(path, predicate, timeoutMs = 110000) {
  let watcher,
    reading = false,
    dirty = false;
  const pending = new Promise((yes, no) => {
    const inspect = async () => {
      dirty = true;
      if (reading) return;
      reading = true;
      try {
        while (dirty) {
          dirty = false;
          const state = JSON.parse(await readFile(path, "utf8"));
          if (predicate(state)) {
            yes(state);
            return;
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") no(new Error("SMOKE_STATE_OBSERVATION_FAILED"));
      } finally {
        reading = false;
      }
    };
    watcher = watch(dirname(path), () => {
      void inspect();
    });
    watcher.once("error", () => no(new Error("SMOKE_STATE_OBSERVATION_FAILED")));
    void inspect();
  });
  try {
    return await boundedSmokeWait(pending, timeoutMs);
  } finally {
    watcher?.close();
  }
}

export async function smokeMain() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = join(repo, "packages/cothink/dist/cli.js");
  const source = join(repo, "examples/todo-stats");
  const evidenceRoot = resolve(
    process.env.COTHINK_BUILD_SMOKE_EVIDENCE ?? join(repo, "../work/construction-stage5/current/local-http")
  );
  const scenario = process.env.COTHINK_BUILD_SMOKE_SCENARIO ?? "all";
  assert(["all", "main", "cancel", "recovery"].includes(scenario), "Unknown smoke scenario");
  const image = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
  const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const evidence = {
    gate: "construction-stage5-compiled-local-http",
    status: "NOT VERIFIED",
    scenario,
    startedAt: new Date().toISOString(),
    clock: "real Date.now; frozen call/task/run deadlines, no extensions",
    fixtureKind: "CONTROLLED local HTTP responses from frozen host test/oracle; not model ability",
    entry,
    commands: [],
    httpRequests: [],
    scenarios: {}
  };
  await mkdir(evidenceRoot, { recursive: true });
  const evidencePath = join(evidenceRoot, `smoke-${scenario}-${Date.now()}.json`);
  let saving = Promise.resolve();
  const save = () => {
    const bytes = JSON.stringify(evidence, null, 2) + "\n";
    saving = saving.then(() => writeFile(evidencePath, bytes));
    return saving;
  };
  let sandbox;
  let server;
  let sequence = 0;
  let current;
  const children = new Set();
  const deferred = () => {
    let resolve;
    const promise = new Promise((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };

  const owned = new Map();
  let harnessStopped = false;
  function stopOwned() {
    harnessStopped = true;
    for (const child of children) child.kill("SIGKILL");
    server?.closeAllConnections();
  }
  function command(args, options = {}) {
    if (harnessStopped) throw new Error("SMOKE_HARNESS_STOPPED");
    const started = Date.now();
    const row = { command: process.execPath, args: [entry, ...args], cwd: repo, startedAt: started };
    evidence.commands.push(row);
    const timeoutMs = ["start", "retry"].includes(args[1]) ? 2880000 : 480000;
    const running = spawnSmokeProcess(process.execPath, [entry, ...args], {
      timeoutMs,
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
    });
    const { child } = running;
    row.args = child.spawnargs.slice(1);
    children.add(child);
    const done = running.done
      .then(async (result) => {
        const output = projectSmokeOutput(result.stdout, result.stderr);
        Object.assign(row, {
          exitCode: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          outputLimitExceeded: result.overflow,
          elapsedMs: Date.now() - started,
          timeoutMs,
          ...output
        });
        await save();
        if (output.errorCode) throw new Error(output.errorCode);
        if (result.timedOut) throw new Error("SMOKE_CHILD_TIMEOUT");
        if (result.overflow) throw new Error("SMOKE_CHILD_OUTPUT_LIMIT");
        let json;
        try {
          json = result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
        } catch {
          throw new Error("SMOKE_INVALID_PUBLIC_JSON");
        }
        return { ...result, json };
      })
      .finally(() => {
        children.delete(child);
        owned.delete(child);
      });
    owned.set(child, done);
    // Cleanup owns the same promise even when a sibling barrier fails first.
    void done.catch(() => {});
    if (options.expect !== undefined)
      return done.then((result) => {
        if (result.code !== options.expect) throw new Error("SMOKE_UNEXPECTED_EXIT");
        return result;
      });
    return { child, done };
  }
  async function run(args, expected = 0) {
    return command(["build", ...args], { expect: expected });
  }
  async function statePath(root, plan) {
    const workspaces = await readdir(join(root, "workspaces"));
    assert.equal(workspaces.length, 1, "One stable request must map to one run");
    const runId = workspaces[0];
    return { runId, path: join(root, "workspaces", runId, ".cothink-build/state", plan.projectKey, "session.json") };
  }
  // Raw JSON observation avoids re-running expensive immutable Git validation to watch progress.
  async function rawState(root, plan) {
    const { runId, path } = await statePath(root, plan);
    return { runId, state: JSON.parse(await readFile(path, "utf8")) };
  }
  async function tree(directory, prefix = "") {
    const found = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) found.push(...(await tree(join(directory, item.name), path)));
      else {
        assert(item.isFile() && !item.isSymbolicLink());
        found.push(path);
      }
    }
    return found.sort();
  }
  async function fixture(name) {
    const root = await realpath(await mkdtemp(join(sandbox, `${name}-`)));
    const project = join(root, "project");
    await cp(source, project, { recursive: true, filter: (path) => !path.includes("node_modules") });
    const plan = JSON.parse(await readFile(join(project, "build-plan.json"), "utf8"));
    assert.equal(plan.manifest.length, 11);
    assert.equal(plan.budget.taskTimeoutMs, 900000);
    assert.equal(plan.budget.runTimeoutMs, 2700000);
    const rootDirectory = join(root, "runs");
    await mkdir(rootDirectory);
    const requestId = `smoke-${name}`;
    const request = join(root, "request.json");
    await writeFile(
      request,
      JSON.stringify({
        integrationVersion: "build-integration-v1",
        requestId,
        frozenBuildPlan: plan,
        materialRefs: plan.manifest.map(({ path, contentHash }) => ({ path, contentHash }))
      })
    );
    const config = join(root, "config.json"),
      keys = join(root, "keys.env");
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(
      config,
      JSON.stringify({
        configVersion: 2,
        discussion: { effort: "standard" },
        members: {
          "member-a": { protocol: "openai-compatible", baseUrl, modelId: "a", apiKeyEnv: "BUILD_SMOKE_A" },
          "member-b": { protocol: "openai-compatible", baseUrl, modelId: "b", apiKeyEnv: "BUILD_SMOKE_B" }
        }
      })
    );
    await writeFile(keys, "BUILD_SMOKE_A=smoke-fake-a\nBUILD_SMOKE_B=smoke-fake-b\n", { mode: 0o600 });
    const oracle = async (file) =>
      (await readFile(join(source, `test/oracle/${file}.ts`), "utf8")).replaceAll("../../src/types.js", "./types.js");
    const texts = {
      "T-A": await oracle("correct-state"),
      "T-B1": await oracle("correct-report"),
      "T-B2": await oracle("correct-final")
    };
    return {
      name,
      root,
      project,
      rootDirectory,
      plan,
      config,
      keys,
      texts,
      requestId,
      startArgs: [
        "start",
        "--project",
        project,
        "--request",
        request,
        "--approve-plan",
        plan.planHash,
        "--config",
        config,
        "--env-file",
        keys,
        "--root",
        rootDirectory,
        "--image",
        image,
        "--json"
      ],
      calls: [],
      count: { "T-A": 0, "T-B1": 0, "T-B2": 0 },
      both: deferred(),
      held: [],
      waiting: deferred(),
      mode: name
    };
  }
  function reply(res, body, payload, trace) {
    trace.end = Date.now();
    trace.endSequence = ++sequence;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "controlled-build-fixture",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(payload),
              reasoning_content: "BUILD_PRIVATE_PROVIDER_SENTINEL"
            },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  }
  async function handle(req, res) {
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.headers.authorization, `Bearer smoke-fake-${body.model}`);
    const input = JSON.parse(body.messages.find(({ role }) => role === "user").content);
    const f = current,
      task = f.plan.tasks.find(({ taskId }) => taskId === input.task.taskId);
    assert(task, "Unknown task in actual HTTP request");
    assert.deepEqual(input.task.scope, task.scope, "Frozen task scope changed");
    assert.equal(input.task.workerId, task.workerId);
    assert.equal(body.model, task.workerId === "member-a" ? "a" : "b");
    assert.deepEqual(
      input.input.files.map(({ path }) => path).sort(),
      [...task.scope.read, ...task.scope.write].sort()
    );
    assert.equal(body.max_tokens ?? body.max_completion_tokens, f.plan.budget.maxOutputTokensPerCall);
    assert(
      !JSON.stringify(input).match(/"(?:token|leaseEpoch|ownerEpoch|attemptId)"/),
      "Private authority entered model input"
    );
    const taskId = task.taskId,
      step = f.count[taskId]++;
    const trace = {
      scenario: f.name,
      taskId,
      requestId: input.requestId,
      start: Date.now(),
      startSequence: ++sequence,
      baseVersion: input.input.baseVersion,
      paths: input.input.files.map(({ path }) => path),
      normalizeHash: input.input.files.find(({ path }) => path === "src/normalize.ts")?.contentHash ?? null
    };
    f.calls.push(trace);
    evidence.httpRequests.push(trace);
    if (taskId === "T-B1") assert(!trace.paths.includes("src/normalize.ts"));
    if (taskId === "T-B2" && step === 0 && f.name === "main") {
      const { state } = await rawState(f.rootDirectory, f.plan);
      assert(state.acceptedTasks.includes("T-A"), "B2 called before A was accepted");
      assert.equal(trace.normalizeHash, sha(f.texts["T-A"]));
      assert.equal(input.input.files.find(({ path }) => path === "src/normalize.ts").text, f.texts["T-A"]);
      evidence.scenarios.main.firstB2NormalizeHash = trace.normalizeHash;
      evidence.scenarios.main.aAcceptedNormalizeHash = sha(f.texts["T-A"]);
    }
    if (f.mode === "cancel" || f.mode === "recovery") {
      res.once("close", () => {
        trace.transportClosedAt = Date.now();
      });
      f.held.push({ res, body, input, trace });
      if (f.held.length === 2) f.waiting.resolve();
      await save();
      return;
    }
    if (f.mode === "abort") {
      reply(
        res,
        body,
        {
          actionVersion: input.actionVersion,
          requestId: input.requestId,
          action: { kind: "abort", reason: "controlled-recovery-proof" }
        },
        trace
      );
      return;
    }
    if (step === 0 && taskId !== "T-B2") {
      if (f.calls.some((call) => call.taskId === "T-A") && f.calls.some((call) => call.taskId === "T-B1"))
        f.both.resolve();
      await boundedSmokeWait(f.both.promise, 110000, stopOwned);
    }
    const path = task.scope.write[0];
    assert(step < 2, "Accepted task was unexpectedly repeated");
    const action =
      step === 0
        ? {
            kind: "edit",
            path,
            text: f.texts[taskId],
            expectedContentHash: input.input.files.find((file) => file.path === path).contentHash
          }
        : { kind: "finish" };
    reply(res, body, { actionVersion: input.actionVersion, requestId: input.requestId, action }, trace);
    await save();
  }
  function summarize(state) {
    // Explicit projection: never persist lease tokens, nonces or raw provider text in evidence.
    return {
      runId: state.runId,
      status: state.status,
      revision: state.revision,
      startedAt: state.startedAt,
      deadlineAt: state.deadlineAt,
      acceptedVersion: state.acceptedVersion,
      acceptedTasks: state.acceptedTasks,
      attempts: state.attempts.map(({ taskId, status, startedAt, deadlineAt }) => ({
        taskId,
        status,
        startedAt,
        deadlineAt
      })),
      calls: state.calls.map(({ taskId, status, allocatedOutputTokens, reservedAt, deadlineAt }) => ({
        taskId,
        status,
        allocatedOutputTokens,
        reservedAt,
        deadlineAt
      })),
      checkReceipts: state.checkReceipts,
      publicationOrder: state.publishReceipts.map(
        ({ attemptId }) => state.attempts.find((attempt) => attempt.attemptId === attemptId)?.taskId
      ),
      publishReceipts: state.publishReceipts.map(
        ({
          publishVersion,
          receiptId,
          attemptId,
          baseVersion,
          acceptedVersion,
          candidateHash,
          checkReceiptId,
          planHash
        }) => ({
          publishVersion,
          receiptId,
          attemptId,
          baseVersion,
          acceptedVersion,
          candidateHash,
          checkReceiptId,
          planHash
        })
      )
    };
  }
  async function mainGate() {
    const f = (current = await fixture("main"));
    const report = (evidence.scenarios.main = { paths: { fixture: f.root, root: f.rootDirectory }, status: "RUNNING" });
    await save();
    const started = Date.now();
    const result = await command(["build", ...f.startArgs]).done;
    report.elapsedMs = Date.now() - started;
    report.result = result.json;
    const { runId, state } = await rawState(f.rootDirectory, f.plan);
    report.persisted = summarize(state);
    await save();
    assert.equal(result.code, 0, "Full real-clock construction did not complete; inspect persisted deadline evidence");
    assert.equal(result.json.status, "completed");
    assert.equal(state.status, "completed");
    assert.deepEqual(state.plan, f.plan);
    assert.deepEqual([...state.acceptedTasks].sort(), ["T-A", "T-B1", "T-B2"]);
    assert.equal(f.calls.length, 6);
    const a = f.calls.find(({ taskId }) => taskId === "T-A"),
      b = f.calls.find(({ taskId }) => taskId === "T-B1");
    assert(a.startSequence < b.endSequence && b.startSequence < a.endSequence, "Actual HTTP requests did not overlap");
    report.actualHttpOverlap = true;
    assert.equal(state.checkReceipts.length, 3);
    for (const receipt of state.checkReceipts) {
      assert.equal(receipt.passed, true);
      assert.equal(receipt.exitCode, 0);
      assert.equal(receipt.imageDigest, evidence.imageId);
      assert.equal(receipt.sourceHashBefore, receipt.sourceHashAfter);
    }
    assert.deepEqual(state.checkReceipts.at(-1).groups, ["common", "state-format", "report", "identity", "final"]);
    report.finalBehaviorEvidence = {
      receiptId: state.checkReceipts.at(-1).receiptId,
      claim:
        "Actual frozen final group passed: 4/1/2/1, trimmed titles, id/uniqueness, legacy done/status and invalid input boundaries",
      expectedStdout: "total: 4\npending: 1\ndone: 2\ncancelled: 1\n",
      boundary:
        "Expected stdout is an assertion description; evidence is the bound real Docker check receipt, not separate CLI stdout"
    };
    const callsBefore = f.calls.length;
    await rm(f.keys);
    const show = await run(["show", runId, "--root", f.rootDirectory, "--json"]);
    assert.equal(show.json.acceptedVersion, result.json.acceptedVersion);
    const exports = [join(f.root, "export-one"), join(f.root, "export-two")];
    for (const output of exports) {
      const exported = await run([
        "export",
        runId,
        "--root",
        f.rootDirectory,
        "--output",
        output,
        "--version",
        state.acceptedVersion,
        "--json"
      ]);
      assert.equal(exported.json.acceptedVersion, state.acceptedVersion);
      assert.deepEqual(await tree(output), f.plan.manifest.map(({ path }) => path).sort());
    }
    report.exportedFiles = [];
    for (const { path } of f.plan.manifest) {
      const one = await readFile(join(exports[0], path)),
        two = await readFile(join(exports[1], path));
      assert.deepEqual(one, two);
      const expected =
        path === "src/normalize.ts"
          ? f.texts["T-B2"]
          : path === "src/report.ts"
            ? f.texts["T-B1"]
            : await readFile(join(source, path), "utf8");
      assert.equal(one.toString("utf8"), expected);
      assert.deepEqual(
        await readFile(join(f.project, path)),
        await readFile(join(source, path)),
        "Original source was changed"
      );
      report.exportedFiles.push({ path, contentHash: sha(one) });
    }
    for (let retry = 0; retry < 2; retry++) {
      const repeated = await run(["retry", runId, "--root", f.rootDirectory, "--json"]);
      assert.equal(repeated.json.acceptedVersion, state.acceptedVersion);
    }
    const repeated = await run(f.startArgs);
    assert.equal(repeated.json.runId, runId);
    assert.equal(f.calls.length, callsBefore, "Readonly/repeated operations dispatched model calls");
    const after = (await rawState(f.rootDirectory, f.plan)).state;
    assert.deepEqual(after.acceptedTasks, state.acceptedTasks);
    assert.equal(after.publishReceipts.length, 3);
    report.readonlyAndRepeatedAdditionalCalls = f.calls.length - callsBefore;
    report.status = "VERIFIED";
    await save();
  }
  async function controlledStopGate(kind) {
    const f = (current = await fixture(kind));
    const report = (evidence.scenarios[kind] = {
      paths: { fixture: f.root, root: f.rootDirectory },
      status: "RUNNING"
    });
    const running = command(["build", ...f.startArgs]);
    const first = await boundedSmokeWait(
      Promise.race([f.waiting.promise.then(() => "waiting"), running.done.then(() => "exited")]),
      480000,
      stopOwned
    );
    assert.equal(first, "waiting", "Process exited before two held HTTP requests");
    const { runId, state: before } = await rawState(f.rootDirectory, f.plan);
    report.before = summarize(before);
    const calls = f.calls.length;
    let beforeLate;
    let firstRecovery;
    const releaseHeld = async (consumerLive) => {
      report.lateResponses = [];
      for (const held of f.held) {
        const task = f.plan.tasks.find(({ taskId }) => taskId === held.input.task.taskId);
        const path = task.scope.write[0];
        const payload = smokeLateEdit(held.input, path, f.texts[task.taskId]);
        const expectedContentHash = payload.action.expectedContentHash;
        if (consumerLive) assertSmokeConsumerLive(running.child);
        const observation = {
          taskId: task.taskId,
          originalConsumerLive: consumerLive,
          expectedContentHash,
          socketClosedBeforeRelease: held.res.destroyed,
          serverWriteFinished: false,
          clientLateActionProcessing:
            "UNVERIFIED: SDK abort may close transport; server write is not client consumption"
        };
        report.lateResponses.push(observation);
        if (!held.res.destroyed) {
          const settled = new Promise((yes) => {
            held.res.once("finish", () => {
              observation.serverWriteFinished = true;
              yes();
            });
            held.res.once("close", yes);
          });
          reply(held.res, held.body, payload, held.trace);
          await boundedSmokeWait(settled, 5000, stopOwned);
        }
      }
      f.held = [];
    };
    if (kind === "cancel") {
      // Subscribe before dispatch so an atomic persisted revocation cannot be missed.
      const location = await statePath(f.rootDirectory, f.plan);
      const revocation = observeSmokeState(location.path, (state) => state.status === "cancelled");
      const cancelling = command(["build", "cancel", runId, "--root", f.rootDirectory, "--json"]);
      beforeLate = await revocation;
      report.authoritativeRevocationObserved = true;
      assertSmokeConsumerLive(running.child);
      await releaseHeld(true);
      const acknowledgement = await cancelling.done;
      assert.equal(acknowledgement.code, 0);
      const stopped = await running.done;
      assert.equal(stopped.code, 2);
      assert.equal(stopped.json.status, "cancelled");
      beforeLate = (await rawState(f.rootDirectory, f.plan)).state;
      firstRecovery = await run(["retry", runId, "--root", f.rootDirectory, "--json"], 2);
      report.lateResponseBoundary =
        "Process alive at release; socket state recorded separately. No claim that SDK delivered a late reply to Driver. Live Driver stale-result fencing has separate stage4 driver-boundaries evidence.";
    } else {
      running.child.kill("SIGKILL");
      assert.equal((await running.done).signal, "SIGKILL");
      firstRecovery = await run(["retry", runId, "--root", f.rootDirectory, "--json"], 2);
      await releaseHeld(false);
      report.lateResponseBoundary =
        "Post-kill disconnected transport only; no consumer existed and no late client processing is claimed. This gate proves durable recovery and explicit continuation.";
    }
    assert.equal(f.calls.length, calls, "First retry made a model request");
    const recovered = (await rawState(f.rootDirectory, f.plan)).state;
    report.recovered = summarize(recovered);
    assert.equal(recovered.acceptedVersion, before.acceptedVersion);
    assert.deepEqual(recovered.acceptedTasks, before.acceptedTasks);
    assert.equal(recovered.publishReceipts.length, 0);
    assert.equal(
      recovered.workspace?.toolReceipts.filter(({ result }) => result.kind === "edited").length ?? 0,
      0,
      "Late response edited the cancelled or killed workspace"
    );
    if (kind === "cancel") {
      assert.equal(firstRecovery.json.status, "cancelled");
      assert.deepEqual(
        recovered,
        beforeLate,
        "Cancelled retry rewrote construction state after the original host settled"
      );
      report.afterCancelledRetryStateStable = true;
      assert.equal((await run(["show", runId, "--root", f.rootDirectory, "--json"])).json.status, "cancelled");
      assert.equal(f.calls.length, calls);
    } else {
      assert(
        recovered.calls.some(({ status }) => status === "unknown"),
        "Killed reserved calls were not retained as unknown"
      );
      f.mode = "abort";
      const continued = await run(["retry", runId, "--root", f.rootDirectory, "--json"], 2);
      assert.equal(continued.json.status, "incomplete");
      assert(f.calls.length > calls, "Second explicit retry did not resume requests");
      const after = (await rawState(f.rootDirectory, f.plan)).state;
      assert(after.calls.length > recovered.calls.length);
      assert.deepEqual(
        after.calls.slice(0, recovered.calls.length),
        recovered.calls,
        "Recovery refunded or rewrote unknown allocation"
      );
      assert.equal(after.acceptedVersion, before.acceptedVersion);
      report.afterContinuation = summarize(after);
    }
    report.firstRetryAdditionalCalls = 0;
    report.status = "VERIFIED";
    await save();
  }
  try {
    const executeGate = async () => {
      if (!image)
        throw new Error(
          "NOT VERIFIED: set COTHINK_BUILD_VALIDATOR_IMAGE to an existing immutable local validator image; no host fallback"
        );
      assert(
        /^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/.test(image),
        "Immutable image reference required"
      );
      await readFile(entry);
      const dockerStarted = Date.now();
      const dockerCommand = { command: "docker", args: ["image", "inspect", image] };
      evidence.dockerPreflight = dockerCommand;
      const inspecting = spawnSmokeProcess("docker", ["image", "inspect", image], { timeoutMs: 30000 });
      children.add(inspecting.child);
      owned.set(inspecting.child, inspecting.done);
      const inspectedResult = await inspecting.done.finally(() => {
        children.delete(inspecting.child);
        owned.delete(inspecting.child);
      });
      Object.assign(dockerCommand, {
        exitCode: inspectedResult.code,
        elapsedMs: Date.now() - dockerStarted,
        timeoutMs: 30000
      });
      if (inspectedResult.timedOut) throw new Error("SMOKE_DOCKER_PREFLIGHT_TIMEOUT");
      if (inspectedResult.code !== 0) throw new Error("NOT VERIFIED: local Docker image inspection failed");
      let inspected;
      try {
        inspected = JSON.parse(inspectedResult.stdout)[0];
      } catch {
        throw new Error("SMOKE_DOCKER_PREFLIGHT_JSON");
      }
      evidence.requestedImage = image;
      evidence.imageId = inspected.Id;
      sandbox = await realpath(await mkdtemp(join(tmpdir(), "cothink-build-http-")));
      evidence.fixtureRoot = sandbox;
      server = createServer((req, res) => {
        void handle(req, res).catch(async (error) => {
          evidence.httpFailure = smokeFailure(error);
          res.writeHead(500);
          res.end("controlled fixture rejected request");
          await save();
        });
      });
      await boundedSmokeWait(
        new Promise((yes, no) => {
          server.once("error", () => no(new Error("SMOKE_HTTP_SERVER_FAILED")));
          server.listen(0, "127.0.0.1", yes);
        }),
        5000,
        stopOwned
      );
      evidence.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      if (scenario === "all" || scenario === "main") await mainGate();
      if (scenario === "all" || scenario === "cancel") await controlledStopGate("cancel");
      if (scenario === "all" || scenario === "recovery") await controlledStopGate("recovery");
      assert(!evidence.httpFailure, "Controlled HTTP server rejected a request");
      evidence.status = "VERIFIED";
      evidence.finishedAt = new Date().toISOString();
      await save();
      console.log(
        JSON.stringify({
          status: evidence.status,
          evidence: evidencePath,
          imageId: evidence.imageId,
          scenarios: Object.keys(evidence.scenarios)
        })
      );
    };
    await boundedSmokeWait(executeGate(), 7200000, stopOwned);
  } catch (error) {
    evidence.status = error.message.startsWith("NOT VERIFIED:") ? "NOT VERIFIED" : "FAILED";
    evidence.error = smokeFailure(error);
    if (evidence.status === "NOT VERIFIED")
      evidence.reason = !image
        ? "COTHINK_BUILD_VALIDATOR_IMAGE is required; no host fallback."
        : "Local Docker/image prerequisite could not be verified.";
    evidence.finishedAt = new Date().toISOString();
    await save();
    console.error(
      JSON.stringify({
        status: evidence.status,
        evidence: evidencePath,
        fixtureRoot: sandbox,
        error: smokeFailure(error).code,
        ...(evidence.reason ? { reason: evidence.reason } : {})
      })
    );
    process.exitCode = 1;
  } finally {
    stopOwned();
    await Promise.allSettled([...owned.values()]);
    if (server)
      await boundedSmokeWait(new Promise((yes) => server.close(yes)), 5000).catch(async (error) => {
        evidence.status = "FAILED";
        evidence.error = smokeFailure(error);
        process.exitCode = 1;
        await save();
      });
    if (evidence.status === "VERIFIED" && sandbox) await rm(sandbox, { recursive: true, force: true });
  }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) await smokeMain();
