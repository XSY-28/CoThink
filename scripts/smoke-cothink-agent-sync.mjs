// Deterministic caller integration: actual local HTTP + external agent-sync + disk/Git/Docker.
import process from "node:process";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freezeAgentSyncProject } from "@onevcat/argue/agent-sync/project";
import { freezeTrustedCheckConfig, configurationHash } from "@onevcat/argue-cli/agent-sync/project";
import { prepareCart } from "../examples/agent-sync/cart/project.mjs";
import { safeChildEnvironment } from "../tools/agent-sync/client.mjs";
const exec = promisify(execFile),
  repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!["--image", "--output"].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i]))
    throw Error("SMOKE_ARGUMENTS");
  args.set(process.argv[i], process.argv[i + 1]);
}
if (!/^sha256:[a-f0-9]{64}$/.test(args.get("--image") ?? "") || !args.has("--output"))
  throw Error("SMOKE_IMAGE_AND_OUTPUT_REQUIRED");
const output = resolve(args.get("--output")),
  image = args.get("--image"),
  started = Date.now();
await mkdir(output, { mode: 0o700 });
const report = {
  kind: "cothink-agent-sync-integration",
  status: "running",
  paidModelCalls: 0,
  commands: [],
  requests: [],
  checks: {}
};
const save = () =>
  writeFile(join(output, "smoke-result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const run = async (file, argv, options = {}) =>
  exec(file, argv, { cwd: repo, env: safeChildEnvironment(), timeout: 600000, maxBuffer: 8 * 1024 * 1024, ...options });
let server;
try {
  const dockerContext = (await run("docker", ["context", "show"])).stdout.trim();
  const imageMetadata = JSON.parse(
    (
      await run("docker", [
        "--context",
        dockerContext,
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
    ).stdout
  );
  const sourceRoot = join(output, "source"),
    trustedRoot = join(output, "trusted"),
    workspaceRoot = join(output, "managed"),
    home = join(output, "home"),
    caller = join(output, "caller");
  for (const path of [sourceRoot, trustedRoot, workspaceRoot, home]) await mkdir(path, { mode: 0o700 });
  const prepared = await prepareCart({
    fixtureRoot: join(repo, "examples/agent-sync/cart"),
    sourceRoot,
    trustedRoot,
    imageMetadata,
    variant: "three"
  });
  const config = freezeTrustedCheckConfig(prepared.config);
  const project = freezeAgentSyncProject({ ...prepared.project, checkConfigurationHash: configurationHash(config) });
  const stateFile = join(workspaceRoot, ".agent-sync/state", project.projectKey, "session.json");
  const state = async () => JSON.parse(await readFile(stateFile, "utf8"));
  const jobFile = join(output, "job.json");
  await writeFile(
    jobFile,
    JSON.stringify({
      options: {
        sourceRoot,
        trustedRoot,
        workspaceRoot,
        home,
        project,
        config,
        image,
        dockerContext,
        runId: "cothink-sync-smoke",
        programRoot: join(repo, "tools")
      },
      connections: {
        admin: { role: "host" },
        a: { workerId: "calc-owner" },
        b: { workerId: "receipt-owner" },
        c: { workerId: "guard-owner" }
      }
    })
  );
  const rounds = {};
  server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const call = JSON.parse(body),
        input = JSON.parse(call.messages.at(-1).content),
        taskId = input.task.taskId;
      assert.equal(req.headers.authorization, "Bearer sync-smoke-" + call.model);
      const round = (rounds[taskId] = (rounds[taskId] ?? 0) + 1);
      report.requests.push({ taskId, round, baseVersion: input.input.baseVersion });
      let action;
      if (round === 1) {
        if (taskId === "amount-guards") {
          assert((await state()).acceptedTasks.includes("amount-basic"));
          assert.equal(input.input.files.find((f) => f.path === "lib/amount.ts").text, prepared.texts["amount-basic"]);
          report.checks.waiterReadsLatestAcceptedInput = true;
        }
        const path = taskId === "receipt-lines" ? "lib/receipt.ts" : "lib/amount.ts";
        action = {
          kind: "edit",
          path,
          text: prepared.texts[taskId],
          expectedContentHash: input.input.files.find((f) => f.path === path).contentHash
        };
      } else if (round === 2) action = { kind: "check" };
      else if (round === 3) {
        assert.equal(input.previousToolResult.receipt.passed, true);
        assert(!(await state()).acceptedTasks.includes(taskId));
        report.checks.privateCheckNotAcceptance = true;
        action = { kind: "finish" };
      } else throw Error("unexpected extra model request");
      const payload = { actionVersion: input.actionVersion, requestId: input.requestId, action };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "smoke",
          object: "chat.completion",
          created: 1,
          model: call.model,
          choices: [
            { index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 }
        })
      );
      await save();
    } catch (error) {
      report.httpError = error.message;
      res.writeHead(500);
      res.end("{}");
      await save();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const modelConfig = {
    configVersion: 2,
    members: Object.fromEntries(
      ["a", "b"].map((x) => [
        "member-" + x,
        {
          protocol: "openai-compatible",
          baseUrl,
          modelId: x,
          apiKeyEnv: "SYNC_SMOKE_" + x.toUpperCase(),
          outputMode: "json_object",
          maxInputCharacters: 120000
        }
      ])
    )
  };
  const modelFile = join(output, "models.json"),
    integrationFile = join(output, "integration.json");
  await writeFile(modelFile, JSON.stringify(modelConfig));
  await writeFile(
    integrationFile,
    JSON.stringify({
      integrationVersion: "cothink-agent-sync-v1",
      toolEntry: join(repo, "tools/agent-sync/dist/stdio.mjs"),
      jobFile,
      members: { "calc-owner": "member-a", "receipt-owner": "member-b", "guard-owner": "member-a" },
      instructions: Object.fromEntries(
        project.tasks.map((t) => [t.taskId, "Implement this task and request trusted checks and formal acceptance."])
      ),
      budget: {
        maxCalls: 9,
        maxOutputTokensPerCall: 4096,
        maxAllocatedOutputTokens: 36864,
        maxDurationMs: 600000,
        callTimeoutMs: 10000
      }
    })
  );
  // Exercise the installed tarball in a fresh project without repository-relative CLI files.
  const install = join(output, "install");
  await mkdir(install);
  const packed = JSON.parse(
    (await run("npm", ["pack", "--json", "--workspace", "packages/cothink", "--pack-destination", install])).stdout
  )[0];
  await run("npm", ["init", "-y"], { cwd: install });
  await run("npm", ["install", "--ignore-scripts", join(install, packed.filename)], { cwd: install });
  const entry = join(install, "node_modules/cothink/dist/cli.js");
  const cli = async (argv, keys = false) => {
    const begin = Date.now();
    const result = await run(process.execPath, [entry, "build", "sync", ...argv, "--json"], {
      cwd: install,
      env: {
        ...safeChildEnvironment(),
        ...(keys ? { SYNC_SMOKE_A: "sync-smoke-a", SYNC_SMOKE_B: "sync-smoke-b" } : {})
      }
    });
    assert(!result.stdout.includes("sync-smoke-a") && !result.stdout.includes("sync-smoke-b"));
    report.commands.push({ command: argv[0], durationMs: Date.now() - begin });
    await save();
    return JSON.parse(result.stdout);
  };
  const result = await cli(
    [
      "start",
      "--integration",
      integrationFile,
      "--approve-plan",
      project.planHash,
      "--config",
      modelFile,
      "--root",
      caller
    ],
    true
  );
  assert.equal(result.status, "completed");
  assert.equal(result.usedCalls, 9);
  assert.equal(result.writerReleased, true);
  const actual = await state();
  assert.equal(actual.publishReceipts.length, 3);
  const events = (await readFile(join(caller, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert(events.some((e) => e.event === "waiting" && e.taskId === "amount-guards"));
  const acceptedFirst = events.findIndex(
    (e) => e.event === "tool-result" && e.taskId === "amount-basic" && e.action === "finish"
  );
  assert(events.findIndex((e) => e.event === "call-reserved" && e.taskId === "amount-guards") > acceptedFirst);
  const callsBefore = report.requests.length;
  assert.equal((await cli(["show", "--root", caller])).status, "completed");
  const exported = await cli(["export", "--root", caller, "--output", join(output, "export")]);
  assert.equal(exported.status, "exported");
  assert.equal(await readFile(join(output, "export/lib/amount.ts"), "utf8"), prepared.texts["amount-guards"]);
  assert.equal(await readFile(join(output, "export/lib/receipt.ts"), "utf8"), prepared.texts["receipt-lines"]);
  const recovered = await cli(["recover", "--root", caller]);
  assert.equal(recovered.replayedActions, 0);
  assert.equal(recovered.usedCalls, 9);
  assert.equal(report.requests.length, callsBefore);
  assert.equal(recovered.deadlineAt, result.deadlineAt);
  assert.equal((await state()).acceptedVersion, actual.acceptedVersion);
  await assert.rejects(lstat(join(workspaceRoot, ".agent-sync/state", project.projectKey, ".writer.lock")), {
    code: "ENOENT"
  });
  report.checks = {
    ...report.checks,
    installedTarball: true,
    threeFormalPublications: true,
    exactExport: true,
    modelFreeShowExportRecovery: true,
    fixedBudgetAndDeadline: true,
    writerReleased: true
  };
  report.status = "verified";
} catch (error) {
  report.status = "failed";
  report.error = { message: error.message, stdout: error.stdout, stderr: error.stderr };
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  report.elapsedMs = Date.now() - started;
  await save();
}
process.stdout.write(
  JSON.stringify({ status: report.status, output, localHttpModelRequests: report.requests.length, paidModelCalls: 0 }) +
    "\n"
);
