import process from "node:process";
// Acceptance caller process. Its parent assigns the trusted connection; stdout is only inner protocol frames.
import { createStreamClient } from "../tools/agent-sync/client.mjs";
import { randomUUID } from "node:crypto";
const client = createStreamClient(process.stdin, process.stdout),
  contexts = new Map();
const originalCall = client.call.bind(client);
client.call = async (...args) => {
  const reply = await originalCall(...args);
  process.send?.({ event: "timing", method: args[0], timing: reply.timing });
  return reply;
};
process.on("message", async (message) => {
  const { commandId, mode } = message;
  try {
    let result;
    if (mode === "scope") {
      const granted = await client.requestScope(message.taskId, message.requestId);
      let contextId;
      if (granted.task) {
        contextId = randomUUID();
        contexts.set(contextId, granted.task);
      }
      result = { result: granted.result, contextId, descriptor: granted.task?.descriptor() };
    } else if (mode === "restore") {
      const contextId = randomUUID();
      contexts.set(contextId, client.restoreTask(message.descriptor));
      result = { contextId };
    } else if (mode === "task") {
      const task = contexts.get(message.contextId);
      if (!task) throw Object.assign(Error("client_context"), { code: "client_context" });
      const methods = new Set(["freezeInput", "read", "edit", "seal", "check", "finish", "release", "runAction"]);
      if (!methods.has(message.method)) throw Object.assign(Error("invalid"), { code: "wire_invalid_action" });
      result = await task[message.method](...message.args);
    } else if (mode === "raw") result = (await client.call(message.method, message.params, message.requestId)).result;
    else if (mode === "shutdown") {
      client.disconnect();
      result = { disconnected: true };
    } else throw Object.assign(Error("invalid"), { code: "wire_invalid_action" });
    process.send?.({ commandId, ok: true, result });
    if (mode === "shutdown") process.disconnect();
  } catch (error) {
    process.send?.({ commandId, ok: false, error: { code: error.code ?? "client_failed", timing: error.timing } });
  }
});
process.on("disconnect", () => {
  client.disconnect();
  process.stdin.destroy();
});
