import { Buffer } from "node:buffer";
export const VERSION = "agent-sync-data-rpc-v1";
const bad = () => {
  throw new Error("AGENT_SYNC_RPC_DATA");
};
export function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    bad();
}
function walk(value, limits, encoding) {
  let count = 0;
  function visit(v, depth) {
    if (++count > limits.maxElements || depth > limits.maxDepth) bad();
    if (encoding) {
      if (v === undefined) return ["undefined"];
      if (typeof v === "number") return ["number", Object.is(v, -0) ? "-0" : String(v)];
      if (v === null || typeof v === "string" || typeof v === "boolean") return ["scalar", v];
      if (Array.isArray(v)) return ["array", v.map((x) => visit(x, depth + 1))];
      if (typeof v !== "object" || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null))
        bad();
      return ["object", Object.entries(v).map(([k, x]) => [k, visit(x, depth + 1)])];
    }
    if (!Array.isArray(v)) bad();
    if (v.length === 1 && v[0] === "undefined") return undefined;
    if (v.length !== 2) bad();
    if (v[0] === "number") {
      if (typeof v[1] !== "string") bad();
      const n = Number(v[1]);
      if ((Object.is(n, -0) ? "-0" : String(n)) !== v[1]) bad();
      return n;
    }
    if (v[0] === "scalar" && (v[1] === null || typeof v[1] === "string" || typeof v[1] === "boolean")) return v[1];
    if (v[0] === "array" && Array.isArray(v[1])) return v[1].map((x) => visit(x, depth + 1));
    if (v[0] === "object" && Array.isArray(v[1])) {
      const result = Object.create(null),
        keys = new Set();
      for (const entry of v[1]) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || keys.has(entry[0])) bad();
        keys.add(entry[0]);
        result[entry[0]] = visit(entry[1], depth + 1);
      }
      return result;
    }
    bad();
  }
  return visit(value, 0);
}
export function encode(value, limits) {
  const result = walk(value, limits, true);
  if (Buffer.byteLength(JSON.stringify(result)) > limits.maxRpcBytes) bad();
  return result;
}
export function decode(value, limits) {
  return walk(value, limits, false);
}
export function parse(text, maxBytes) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBytes) bad();
  const value = JSON.parse(text);
  // All fixed programs emit compact JSON. This also rejects duplicate keys and extra/trailing output.
  if (JSON.stringify(value) !== text) bad();
  return value;
}
export function request(text, config) {
  const value = parse(text, config.limits.maxRpcBytes);
  exact(value, ["rpcVersion", "requestId", "operationId", "input"]);
  if (
    value.rpcVersion !== VERSION ||
    typeof value.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.requestId) ||
    !config.operations.some((o) => o.id === value.operationId)
  )
    bad();
  decode(value.input, config.limits);
  return value;
}
export function readEnvelope(text, req, limits) {
  const value = parse(text, limits.maxResultBytes);
  exact(
    value,
    value.ok === true
      ? ["rpcVersion", "requestId", "operationId", "ok", "value"]
      : ["rpcVersion", "requestId", "operationId", "ok", "error"]
  );
  if (value.rpcVersion !== VERSION || value.requestId !== req.requestId || value.operationId !== req.operationId) bad();
  if (value.ok === false && value.error === "E_INPUT") throw new Error("E_INPUT");
  if (value.ok !== true) bad();
  return decode(value.value, limits);
}
export async function readInput(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) bad();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
