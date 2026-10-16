import { readFileSync, writeFileSync } from "node:fs";
export function readOutputBudget(path, limit) {
  const b = JSON.parse(readFileSync(path, "utf8"));
  if (
    !b ||
    Object.keys(b).sort().join() !== "limit,rawBytes,version,wrapperBytes" ||
    b.version !== "agent-sync-oracle-output-v1" ||
    b.limit !== limit ||
    ![b.rawBytes, b.wrapperBytes].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error("AGENT_SYNC_ORACLE_BUDGET");
  if (b.rawBytes + b.wrapperBytes >= limit) throw new Error("AGENT_SYNC_ORACLE_LIMIT");
  return b;
}
export function consumeRawOutput(path, limit, bytes) {
  const b = readOutputBudget(path, limit);
  b.rawBytes += bytes;
  writeFileSync(path, JSON.stringify(b));
  if (!Number.isSafeInteger(bytes) || bytes < 0 || b.rawBytes + b.wrapperBytes > limit)
    throw new Error("AGENT_SYNC_ORACLE_LIMIT");
}
