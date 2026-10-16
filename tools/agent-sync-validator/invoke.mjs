import process from "node:process";
// Untrusted application code runs only in this short-lived child, never the fixed parent.
import { readFileSync } from "node:fs";
import { request, decode, encode, readInput } from "./protocol.mjs";
const config = JSON.parse(readFileSync("/runtime-config/config.json", "utf8"));
const req = request(await readInput(process.stdin, config.limits.maxRpcBytes), config);
const operation = config.operations.find((o) => o.id === req.operationId);
try {
  const module = await import("/tmp/out/" + operation.module.replace(/\.ts$/, ".js"));
  const result = await module[operation.exportName](decode(req.input, config.limits));
  process.stdout.write(
    JSON.stringify({ ok: true, value: encode(result, { ...config.limits, maxRpcBytes: config.limits.maxResultBytes }) })
  );
} catch (error) {
  if (error instanceof Error && error.message === "E_INPUT")
    process.stdout.write(JSON.stringify({ ok: false, error: "E_INPUT" }));
  else process.exitCode = 2;
}
