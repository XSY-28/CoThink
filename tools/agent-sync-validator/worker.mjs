import process from "node:process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { request, parse, exact, encode, decode, readInput } from "./protocol.mjs";
const config = JSON.parse(readFileSync("/runtime-config/config.json", "utf8"));
const input = await readInput(process.stdin, config.limits.maxRpcBytes);
const req = request(input, config);
const op = config.operations.find((o) => o.id === req.operationId);
const result = spawnSync(process.execPath, ["/opt/validator/" + (op.kind === "cli" ? "cli-shim.mjs" : "invoke.mjs")], {
  input,
  encoding: "utf8",
  timeout: config.limits.callTimeoutMs,
  maxBuffer: config.limits.maxResultBytes,
  killSignal: "SIGKILL",
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" }
});
if (result.error || result.signal || result.status === null) process.exit(2);
let output;
if (op.kind === "cli")
  output = {
    ok: true,
    value: encode(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      { ...config.limits, maxRpcBytes: config.limits.maxResultBytes }
    )
  };
else {
  if (result.status !== 0 || result.stderr) process.exit(2);
  output = parse(result.stdout, config.limits.maxResultBytes);
  exact(output, output.ok === true ? ["ok", "value"] : ["ok", "error"]);
  if (output.ok === true) decode(output.value, config.limits);
  else if (output.ok !== false || output.error !== "E_INPUT") process.exit(2);
}
const envelope = JSON.stringify({
  rpcVersion: req.rpcVersion,
  requestId: req.requestId,
  operationId: req.operationId,
  ...output
});
if (Buffer.byteLength(envelope) > config.limits.maxResultBytes) process.exit(2);
process.stdout.write(envelope);
