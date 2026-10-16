import process from "node:process";
import { Buffer } from "node:buffer";
import { installGuard } from "./guard.mjs";
import { readOutputBudget, consumeRawOutput } from "./output-budget.mjs";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
// macOS may add __CF_USER_TEXT_ENCODING at process startup even with an explicit spawn env.
// Normalize before any trusted checker or test framework import.
for (const key of Object.keys(process.env)) if (!["PATH", "HOME", "LANG"].includes(key)) delete process.env[key];
const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = job.root;
installGuard(job.guardPolicyPath);
const configPath = job.configPath;
rmSync(job.guardMarkerPath, { force: true });
const budget = readOutputBudget(job.outputBudgetPath, job.limits.maxOracleOutputBytes);
const allowance = budget.limit - budget.rawBytes - budget.wrapperBytes;
const remaining = Number((BigInt(job.deadlineNs) - process.hrtime.bigint()) / 1000000n);
if (remaining < 1) throw new Error("AGENT_SYNC_CHECK_TIMEOUT");
const result = spawnSync(
  process.execPath,
  [
    "--import",
    job.guardBootstrap,
    join(job.dependencyRoot, "vitest/vitest.mjs"),
    "run",
    "--root",
    root,
    "--config",
    configPath,
    "--configLoader",
    "native",
    ...job.checks.map((c) => relative(root, c.entry)),
    "--reporter=json"
  ],
  {
    encoding: "utf8",
    timeout: remaining,
    killSignal: "SIGKILL",
    maxBuffer: allowance,
    env: { PATH: process.env.PATH, HOME: job.home, LANG: "C.UTF-8", BUILD_SAMPLE_COMPILED_ROOT: job.proxyRoot }
  }
);
try {
  consumeRawOutput(
    job.outputBudgetPath,
    job.limits.maxOracleOutputBytes,
    Buffer.byteLength(result.stdout || "") + Buffer.byteLength(result.stderr || "")
  );
  if (result.stderr) throw new Error("AGENT_SYNC_ORACLE_STDERR");
  if (result.error || result.signal || result.status === null) throw new Error("AGENT_SYNC_ORACLE_EXECUTION");
  if (readFileSync(job.guardMarkerPath, "utf8") !== installGuard(job.guardPolicyPath).hash)
    throw new Error("AGENT_SYNC_VITE_GUARD_INACTIVE");
} catch (error) {
  try {
    writeFileSync(JSON.parse(readFileSync(job.guardPolicyPath, "utf8")).failurePath, "oracle-output-or-guard-failure", {
      flag: "wx"
    });
  } catch (writeError) {
    if (writeError.code !== "EEXIST") throw writeError;
  }
  throw error;
}

const summary = JSON.parse(result.stdout),
  checks = [];
if (
  !Array.isArray(summary.testResults) ||
  summary.testResults.length !== job.checks.length ||
  summary.numPendingTests !== 0 ||
  summary.numTodoTests !== 0
)
  throw new Error("AGENT_SYNC_ORACLE_INCOMPLETE");
let passed = 0,
  failed = 0;
for (const check of job.checks) {
  const matches = summary.testResults.filter((r) => r.name === check.entry);
  if (matches.length !== 1 || !Array.isArray(matches[0].assertionResults))
    throw new Error("AGENT_SYNC_ORACLE_SELECTION");
  const cases = matches[0].assertionResults.map((r) => {
    if (
      !["passed", "failed"].includes(r.status) ||
      !Array.isArray(r.ancestorTitles) ||
      r.ancestorTitles.length !== 1 ||
      typeof r.title !== "string"
    )
      throw new Error("AGENT_SYNC_ORACLE_CASE");
    if (r.status === "passed") passed++;
    else failed++;
    return { caseId: relative(root, check.entry) + "::" + r.ancestorTitles[0] + "::" + r.title, status: r.status };
  });
  checks.push({ checkId: check.checkId, cases });
}
if (
  summary.numTotalTests !== passed + failed ||
  summary.numPassedTests !== passed ||
  summary.numFailedTests !== failed ||
  (failed === 0 ? result.status !== 0 : result.status !== 1)
)
  throw new Error("AGENT_SYNC_ORACLE_INCONSISTENT");
process.stdout.write(JSON.stringify({ oracleVersion: "agent-sync-oracle-result-v1", checks }));
process.exitCode = failed ? 1 : 0;
