import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { hashJson, agentSyncLeaseFromAttempt } from "@onevcat/argue/agent-sync/project";
export const WIRE_VERSION = "agent-sync-stdio-v1";
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export function wireError(code) {
  return Object.assign(new Error(code), { code });
}
const invalid = () => {
  throw wireError("wire_invalid_request");
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fields = {
  status: [],
  diff: ["fromVersion?", "toVersion?"],
  exportVersion: ["target", "version?"],
  recover: [],
  close: [],
  requestScope: ["taskId"],
  currentLease: ["taskId"],
  cancel: ["taskId"],
  freezeInput: ["taskId", "capability"],
  read: ["taskId", "capability", "path"],
  edit: ["taskId", "capability", "edits"],
  seal: ["taskId", "capability"],
  check: ["taskId", "capability"],
  finish: ["taskId", "capability"],
  release: ["taskId", "capability"]
};
function exact(value, allowed) {
  if (!object(value)) invalid();
  const names = allowed.map((k) => k.replace(/\?$/, ""));
  if (
    Object.keys(value).some((k) => !names.includes(k)) ||
    allowed.some((k) => !k.endsWith("?") && !Object.hasOwn(value, k))
  )
    invalid();
}
export function parseMessage(raw) {
  exact(raw, ["protocolVersion", "requestId", "method", "params"]);
  if (raw.protocolVersion !== WIRE_VERSION) throw wireError("wire_version");
  if (!id(raw.requestId) || !Object.hasOwn(fields, raw.method)) invalid();
  exact(raw.params, fields[raw.method]);
  if (raw.params.taskId !== undefined && !id(raw.params.taskId)) invalid();
  if (
    raw.params.capability !== undefined &&
    (typeof raw.params.capability !== "string" || raw.params.capability.length > 128)
  )
    invalid();
  if (raw.method === "edit") {
    if (!Array.isArray(raw.params.edits)) invalid();
    for (const edit of raw.params.edits) exact(edit, ["path", "text", "expectedContentHash"]);
  }
  return globalThis.structuredClone(raw);
}
export function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  const leaseLike = (item) =>
    object(item) &&
    typeof item.token === "string" &&
    typeof item.ownerEpoch === "number" &&
    typeof item.leaseEpoch === "number" &&
    typeof item.attemptId === "string";
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !(key === "token" && leaseLike(value)) && !(key === "lease" && leaseLike(item)))
        .map(([key, item]) => [key, publicResult(item)])
    );
  return value;
}
export function safeError(error) {
  const code = error?.code;
  return { code: typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "backend_rejected" };
}
export function captureBindings(bindings, memberIds) {
  if (!object(bindings) || Object.keys(bindings).length < 1 || Object.keys(bindings).length > 256)
    throw wireError("wire_configuration");
  const captured = globalThis.structuredClone(bindings);
  for (const [name, binding] of Object.entries(captured)) {
    if (!id(name) || !object(binding)) throw wireError("wire_configuration");
    exact(binding, binding.role === "host" ? ["role"] : ["workerId"]);
    if (binding.role !== "host" && (!id(binding.workerId) || (memberIds && !memberIds.includes(binding.workerId))))
      throw wireError("wire_configuration");
    Object.freeze(binding);
  }
  return Object.freeze(captured);
}
/** Trusted connection comes from the router pipe, never from a model action. Every settled call reenters core. */
export function createDispatcher({ service, bindings, loadState, onClose = () => {}, maxBindings = 4096 }) {
  const captured = captureBindings(bindings),
    caps = new Map(),
    contexts = new Map();
  let closing = false;
  function register(lease) {
    const capability = hashJson(lease);
    if (!caps.has(capability))
      caps.set(capability, { lease: Object.freeze(globalThis.structuredClone(lease)), candidate: undefined });
    return capability;
  }
  async function context(binding, request) {
    const p = request.params;
    let entry = caps.get(p.capability);
    if (!entry && loadState) {
      // Hydrate only an existing durable SUCCESS with this precise ID. Never resume unknown work.
      const state = await loadState();
      const tool = state.workspace?.toolReceipts.find((r) => r.requestId === request.requestId);
      const publication = state.publishReceipts.find((r) => r.requestId === request.requestId);
      const operations = { freezeInput: "freeze", read: "inspect", edit: "edit", seal: "seal" };
      let oldLease;
      if (tool) {
        if (operations[request.method] !== tool.request.operation) throw wireError("request_id_conflict");
        oldLease = tool.request.lease;
      } else if (publication) {
        if (request.method !== "finish") throw wireError("request_id_conflict");
        const attempt = state.attempts.find((a) => a.attemptId === publication.attemptId);
        if (attempt) oldLease = agentSyncLeaseFromAttempt(state, attempt);
      }
      if (
        oldLease &&
        oldLease.workerId === binding.workerId &&
        oldLease.taskId === p.taskId &&
        hashJson(oldLease) === p.capability
      ) {
        register(oldLease);
        entry = caps.get(p.capability);
      }
    }
    if (!entry || entry.lease.workerId !== binding.workerId || entry.lease.taskId !== p.taskId)
      throw wireError("wire_lease_context");
    return entry;
  }
  function close() {
    if (!closing) {
      closing = true;
      service.close();
      onClose();
    }
  }
  return {
    close,
    async dispatch(connectionId, raw) {
      if (closing) throw wireError("service_closed");
      const binding = Object.hasOwn(captured, connectionId) ? captured[connectionId] : undefined;
      if (!binding) throw wireError("wire_unknown_connection");
      const request = parseMessage(raw),
        { method, requestId, params: p } = request;
      const hostOnly = ["diff", "exportVersion", "recover", "close"].includes(method);
      if ((hostOnly && binding.role !== "host") || (!hostOnly && method !== "status" && binding.role === "host"))
        throw wireError("wire_forbidden");
      const hash = hashJson({ connectionId, ...request }),
        prior = contexts.get(requestId);
      if (prior !== undefined && prior !== hash) throw wireError("request_id_conflict");
      if (prior === undefined && contexts.size >= maxBindings && method !== "close")
        throw wireError("wire_request_limit");
      if (method !== "close") contexts.set(requestId, hash);
      if (method === "close") {
        close();
        return { result: { closing: true } };
      }
      if (method === "status") return { result: await service.status() };
      if (method === "diff") return { result: await service.diff(p) };
      if (method === "exportVersion") return { result: await service.exportVersion(p) };
      if (method === "recover") return { result: await service.recover(requestId) };
      const worker = service.forWorker(binding.workerId);
      if (method === "requestScope") {
        const result = await worker.requestScope(p.taskId, requestId);
        const lease = result.lease ?? (result.kind === "replayed" ? result.receipt?.result?.lease : undefined);
        const visible = publicResult(result);
        return lease
          ? {
              result: visible,
              capability: register(lease),
              leaseContext: {
                taskId: lease.taskId,
                attemptId: lease.attemptId,
                ownerEpoch: lease.ownerEpoch,
                leaseEpoch: lease.leaseEpoch
              }
            }
          : { result: visible };
      }
      if (method === "currentLease") {
        const lease = await worker.currentLease(p.taskId);
        return lease
          ? {
              result: { current: true },
              capability: register(lease),
              leaseContext: {
                taskId: lease.taskId,
                attemptId: lease.attemptId,
                ownerEpoch: lease.ownerEpoch,
                leaseEpoch: lease.leaseEpoch
              }
            }
          : { result: { current: false } };
      }
      if (method === "cancel") return { result: await worker.cancel(p.taskId, requestId) };
      const entry = await context(binding, request),
        lease = entry.lease;
      if (method === "freezeInput") return { result: await worker.freezeInput(lease, requestId) };
      if (method === "read") return { result: await worker.read(lease, requestId, p.path) };
      if (method === "edit") return { result: await worker.edit(lease, requestId, p.edits) };
      if (method === "seal") {
        const result = await worker.seal(lease, requestId);
        entry.candidate = result;
        return { result };
      }
      if (method === "check") {
        if (!entry.candidate) throw wireError("wire_candidate_context");
        return { result: await worker.check(lease, requestId, entry.candidate) };
      }
      if (method === "finish") return { result: await worker.finish(lease, requestId) };
      if (method === "release") return { result: await worker.release(lease, requestId) };
      invalid();
    }
  };
}
/** Bounded byte framing; invalid UTF8 is rejected rather than silently changed. */
export async function readJsonLines(input, onMessage, onError, limit = MAX_FRAME_BYTES) {
  let parts = [],
    size = 0;
  const decode = (bytes) => {
    try {
      onMessage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      onError(wireError("wire_invalid_frame"));
    }
  };
  try {
    for await (const raw of input) {
      const chunk = Buffer.from(raw);
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        parts.push(part);
        size += part.length;
        if (size > limit) throw wireError("wire_frame_limit");
        decode(Buffer.concat(parts, size));
        parts = [];
        size = 0;
        start = end + 1;
      }
      const part = chunk.subarray(start);
      parts.push(part);
      size += part.length;
      if (size > limit) throw wireError("wire_frame_limit");
    }
    if (size) onError(wireError("wire_truncated_frame"));
  } catch (error) {
    onError(error);
  }
}
export async function writeJsonLine(output, value) {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw wireError("wire_frame_limit");
  await new Promise((resolve, reject) => output.write(line, (error) => (error ? reject(error) : resolve())));
}
