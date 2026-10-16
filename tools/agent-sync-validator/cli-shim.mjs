import process from "node:process";
import { Buffer } from "node:buffer";
// Preserve exact UTF-8 chunk boundaries from a trusted CLI oracle.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { request, decode, readInput } from "./protocol.mjs";
const config = JSON.parse(readFileSync("/runtime-config/config.json", "utf8"));
const req = request(await readInput(process.stdin, config.limits.maxRpcBytes), config);
const chunks = decode(req.input, config.limits);
if (
  !Array.isArray(chunks) ||
  chunks.some((c) => !Array.isArray(c) || c.some((b) => !Number.isInteger(b) || b < 0 || b > 255))
)
  throw new Error("AGENT_SYNC_CLI_INPUT");
Object.defineProperty(process, "stdin", {
  value: Readable.from(
    chunks.map((c) => Buffer.from(c)),
    { objectMode: true }
  )
});
const op = config.operations.find((o) => o.id === req.operationId);
await import("/tmp/out/" + op.module.replace(/\.ts$/, ".js"));
