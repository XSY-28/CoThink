import process from "node:process";
import { installGuard } from "./guard.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// macOS may add __CF_USER_TEXT_ENCODING at process startup even with an explicit spawn env.
// Normalize before any trusted checker or test framework import.
for (const key of Object.keys(process.env)) if (!["PATH", "HOME", "LANG"].includes(key)) delete process.env[key];
const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
installGuard(job.guardPolicyPath);
const { invoke } = await import(pathToFileURL(job.bridgePath).href);
const checks = [];
for (const selected of job.checks) {
  const cases = [];
  const checker = await import(pathToFileURL(selected.entry).href);
  if (typeof checker.default !== "function") throw new Error("AGENT_SYNC_ORACLE_ENTRY");
  const context = Object.freeze({
    parameters: selected.parameters,
    invoke,
    case: async (caseId, assertion) => {
      if (
        !selected.expectedCaseIds.includes(caseId) ||
        cases.some((c) => c.caseId === caseId) ||
        typeof assertion !== "function"
      )
        throw new Error("AGENT_SYNC_ORACLE_CASE");
      const item = { caseId, status: "pending" };
      cases.push(item);
      try {
        await assertion();
        item.status = "passed";
      } catch {
        item.status = "failed";
      }
    }
  });
  // Errors outside a registered assertion are protocol failures, never passing summaries.
  await checker.default(context);
  if (cases.length !== selected.expectedCaseIds.length || cases.some((c) => c.status === "pending"))
    throw new Error("AGENT_SYNC_ORACLE_INCOMPLETE");
  checks.push({ checkId: selected.checkId, cases });
}
process.stdout.write(JSON.stringify({ oracleVersion: "agent-sync-oracle-result-v1", checks }));
process.exitCode = checks.some((c) => c.cases.some((x) => x.status !== "passed")) ? 1 : 0;
