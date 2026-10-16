import process from "node:process";
import { installGuard } from "./guard.mjs";
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { encode, readEnvelope } from "./protocol.mjs";
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export async function createBridge(jobPath, expectedHash) {
  const bytes = readFileSync(jobPath);
  if (sha(bytes) !== expectedHash) throw new Error("AGENT_SYNC_JOB_CHANGED");
  const job = JSON.parse(bytes);
  installGuard(job.guardPolicyPath);
  const decoders = new Map();
  for (const item of job.decoders) {
    const mod = await import(pathToFileURL(item.path).href);
    if (typeof mod[item.exportName] !== "function") throw new Error("AGENT_SYNC_DECODER");
    decoders.set(item.operationId, mod[item.exportName]);
  }
  function remaining() {
    const ms = Number((BigInt(job.deadlineNs) - process.hrtime.bigint()) / 1000000n);
    if (ms < 1) throw new Error("AGENT_SYNC_CHECK_TIMEOUT");
    return Math.min(ms, job.limits.callTimeoutMs);
  }
  return function invoke(operationId, input) {
    let applicationInputError = false;
    try {
      if (!decoders.has(operationId) || sha(readFileSync(jobPath)) !== expectedHash)
        throw new Error("AGENT_SYNC_JOB_CHANGED");
      const req = {
        rpcVersion: "agent-sync-data-rpc-v1",
        requestId: randomUUID(),
        operationId,
        input: encode(input, job.limits)
      };
      const text = JSON.stringify(req),
        inputBytes = Buffer.byteLength(text);
      if (inputBytes > job.limits.maxRpcBytes) throw new Error("AGENT_SYNC_RPC_LIMIT");
      const lock = job.budgetPath + ".lock";
      mkdirSync(lock, { mode: 0o700 });
      try {
        const budget = JSON.parse(readFileSync(job.budgetPath, "utf8"));
        if (
          budget.jobHash !== expectedHash ||
          !Number.isSafeInteger(budget.calls) ||
          !Number.isSafeInteger(budget.inputBytes) ||
          !Number.isSafeInteger(budget.outputBytes) ||
          budget.calls < 0 ||
          budget.inputBytes < 0 ||
          budget.outputBytes < 0
        )
          throw new Error("AGENT_SYNC_BUDGET");
        if (budget.calls >= job.limits.maxCalls || budget.inputBytes + inputBytes > job.limits.maxTotalRpcBytes)
          throw new Error("AGENT_SYNC_RPC_LIMIT");
        budget.calls++;
        budget.inputBytes += inputBytes;
        writeFileSync(job.budgetPath, JSON.stringify(budget));
        const result = spawnSync(job.invocation.command, job.invocation.args, {
          input: text,
          encoding: "utf8",
          env: job.invocation.env,
          timeout: remaining(),
          killSignal: "SIGKILL",
          maxBuffer: Math.min(job.limits.maxResultBytes, job.limits.maxTotalResultBytes - budget.outputBytes)
        });
        budget.outputBytes += Buffer.byteLength(result.stdout || "") + Buffer.byteLength(result.stderr || "");
        writeFileSync(job.budgetPath, JSON.stringify(budget));
        remaining();
        if (
          budget.outputBytes > job.limits.maxTotalResultBytes ||
          result.error ||
          result.signal ||
          result.status !== 0 ||
          result.stderr
        )
          throw new Error("AGENT_SYNC_RPC_EXECUTION");
        let value;
        try {
          value = readEnvelope(result.stdout, req, job.limits);
        } catch (error) {
          applicationInputError = error instanceof Error && error.message === "E_INPUT";
          throw error;
        }
        return decoders.get(operationId)(value);
      } finally {
        rmdirSync(lock);
      }
    } catch (error) {
      if (!applicationInputError) writeFileSync(job.budgetPath + ".failed", "infrastructure-failure");
      throw error;
    }
  };
}
