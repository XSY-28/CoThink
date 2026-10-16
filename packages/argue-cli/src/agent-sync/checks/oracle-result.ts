import { z } from "zod";
import { type TrustedCheckConfig, selectedChecks } from "./config.js";
const Summary = z
  .object({
    oracleVersion: z.literal("agent-sync-oracle-result-v1"),
    checks: z
      .array(
        z
          .object({
            checkId: z.string(),
            cases: z.array(z.object({ caseId: z.string(), status: z.enum(["passed", "failed"]) }).strict()).min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict();
export function oracleExit(
  text: string,
  status: number | null,
  config: TrustedCheckConfig,
  groups: readonly string[]
): number {
  if (Buffer.byteLength(text) > config.limits.maxOracleOutputBytes) throw new Error("AGENT_SYNC_ORACLE_LIMIT");
  const summary = Summary.parse(JSON.parse(text));
  const selected = selectedChecks(config, groups);
  if (
    summary.checks.length !== selected.length ||
    new Set(summary.checks.map((c) => c.checkId)).size !== selected.length ||
    summary.checks.some((c) => !selected.includes(c.checkId))
  )
    throw new Error("AGENT_SYNC_ORACLE_SELECTION");
  for (const check of summary.checks) {
    const expected = config.checks.find((c) => c.checkId === check.checkId)!.expectedCaseIds;
    if (
      check.cases.length !== expected.length ||
      new Set(check.cases.map((c) => c.caseId)).size !== expected.length ||
      check.cases.some((c) => !expected.includes(c.caseId))
    )
      throw new Error("AGENT_SYNC_ORACLE_INCOMPLETE");
  }
  const passed = summary.checks.every((c) => c.cases.every((x) => x.status === "passed"));
  if (status === null || (passed ? status !== 0 : status !== 1)) throw new Error("AGENT_SYNC_ORACLE_INCONSISTENT");
  return passed ? 0 : 1;
}
