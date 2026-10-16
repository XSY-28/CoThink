import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { WIRE_VERSION, parseMessage, readJsonLines, writeJsonLine, wireError, safeError } from "./protocol.mjs";
import { hashJson } from "@onevcat/argue/agent-sync/project";
export function safeChildEnvironment() {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SystemRoot", "ComSpec"]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]])
  );
}
/** One connection's correlation only. Completed responses are never cached. */
export function createClient(send) {
  let closed = false;
  return {
    async call(method, params = {}, requestId = randomUUID()) {
      if (closed) throw wireError("client_closed");
      const request = parseMessage({ protocolVersion: WIRE_VERSION, requestId, method, params });
      const response = await send(request);
      if (!response.ok)
        throw Object.assign(wireError(response.error?.code ?? "wire_response"), { timing: response.timing });
      return response;
    },
    async requestScope(taskId, requestId) {
      const response = await this.call("requestScope", { taskId }, requestId);
      return {
        result: response.result,
        task: response.capability
          ? taskContext(this, { taskId, capability: response.capability, ...response.leaseContext })
          : undefined
      };
    },
    restoreTask(descriptor) {
      return taskContext(this, descriptor);
    },
    disconnect() {
      closed = true;
    }
  };
}
export function taskContext(client, raw) {
  const descriptor = Object.freeze(globalThis.structuredClone(raw)),
    { taskId, capability } = descriptor;
  const call = async (method, requestId, extra = {}) =>
    (await client.call(method, { taskId, capability, ...extra }, requestId)).result;
  const task = {
    descriptor: () => ({ ...descriptor }),
    freezeInput: (requestId) => call("freezeInput", requestId),
    read: (path, requestId) => call("read", requestId, { path }),
    edit: (edits, requestId) => call("edit", requestId, { edits }),
    seal: (requestId) => call("seal", requestId),
    check: (requestId) => call("check", requestId),
    finish: (requestId) => call("finish", requestId),
    release: (requestId) => call("release", requestId),
    async runAction(action, requestId) {
      const allowed = {
        inspect: ["kind", "path"],
        edit: ["kind", "path", "text", "expectedContentHash"],
        check: ["kind"],
        finish: ["kind"],
        abort: ["kind", "reason"]
      };
      if (
        !action ||
        typeof action !== "object" ||
        !Object.hasOwn(allowed, action.kind) ||
        Object.keys(action).length !== allowed[action.kind].length ||
        Object.keys(action).some((k) => !allowed[action.kind].includes(k))
      )
        throw wireError("wire_invalid_action");
      if (action.kind === "inspect") return task.read(action.path, requestId);
      if (action.kind === "edit")
        return task.edit(
          [{ path: action.path, text: action.text, expectedContentHash: action.expectedContentHash }],
          requestId
        );
      if (action.kind === "check") {
        await task.seal("seal-" + hashJson({ requestId, taskId, capability }).slice(7, 39));
        return task.check(requestId);
      }
      if (action.kind === "finish") return task.finish(requestId);
      if (typeof action.reason !== "string" || !action.reason.length || action.reason.length > 2048)
        throw wireError("wire_invalid_action");
      return task.release(requestId);
    }
  };
  return Object.freeze(task);
}
/** Client process uses only its two pipes. No identity is accepted in the inner frame. */
export function createStreamClient(input, output) {
  const pending = new Map();
  let stopped = false;
  const fail = () => {
    stopped = true;
    for (const item of pending.values()) item.reject(wireError("connection_closed"));
    pending.clear();
  };
  const client = createClient(
    (request) =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(wireError("connection_closed"));
          return;
        }
        const routeId = randomUUID();
        pending.set(routeId, { resolve, reject });
        void writeJsonLine(output, { routeId, request }).catch((error) => {
          pending.delete(routeId);
          reject(error);
        });
      })
  );
  const reader = readJsonLines(
    input,
    (frame) => {
      if (frame.protocolVersion !== WIRE_VERSION) {
        fail();
        return;
      }
      const item = pending.get(frame.routeId);
      if (!item) return;
      pending.delete(frame.routeId);
      item.resolve(frame);
    },
    fail
  );
  void reader.finally(fail);
  return {
    ...client,
    disconnect() {
      client.disconnect();
      fail();
      input.destroy();
    },
    reader
  };
}
/** Explicit tool host: a fixed route from each client pipe to one trusted connection. No task/model logic. */
export class ToolHost {
  constructor({ entry, configFile, cwd, trace = false, execArgv = [], onDiagnostic = () => {} }) {
    this.pending = new Map();
    this.clients = new Set();
    this.closed = false;
    let readyResolve, readyReject, exitResolve;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    this.exited = new Promise((resolve) => {
      exitResolve = resolve;
    });
    this.child = spawn(process.execPath, [...execArgv, entry, "--config", configFile, ...(trace ? ["--trace"] : [])], {
      cwd,
      env: safeChildEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    void readJsonLines(
      this.child.stdout,
      (frame) => {
        if (frame.protocolVersion !== WIRE_VERSION) {
          this.closed = true;
          readyReject(wireError("wire_response"));
          this.abortRoutes();
          this.child.stdin.end();
          return;
        }
        if (frame.event === "ready") {
          this.readyFrame = frame;
          readyResolve(frame);
          return;
        }
        const item = this.pending.get(frame.routeId);
        if (!item) return;
        this.pending.delete(frame.routeId);
        item.deliver(frame);
      },
      () => this.abortRoutes()
    );
    void readJsonLines(this.child.stderr, onDiagnostic, () => onDiagnostic({ event: "unstructured-stderr-redacted" }));
    this.child.once("error", () => {
      readyReject(wireError("tool_startup_failed"));
      this.abortRoutes();
    });
    this.child.once("close", (code, signal) => {
      this.closed = true;
      readyReject(wireError("tool_closed"));
      this.abortRoutes();
      exitResolve({ code, signal });
    });
  }
  abortRoutes() {
    for (const item of this.pending.values()) item.fail?.();
    this.pending.clear();
  }
  async route(connectionId, request, deliver, fail) {
    await this.ready;
    if (this.closed) throw wireError("tool_closed");
    const routeId = randomUUID();
    this.pending.set(routeId, { deliver, fail });
    try {
      await writeJsonLine(this.child.stdin, { connectionId, routeId, request });
    } catch (error) {
      this.pending.delete(routeId);
      throw error;
    }
  }
  client(connectionId) {
    const client = createClient(
      (request) =>
        new Promise((resolve, reject) => {
          void this.route(connectionId, request, resolve, () => reject(wireError("connection_closed"))).catch(reject);
        })
    );
    this.clients.add(client);
    return client;
  }
  attachProcess(child, connectionId) {
    // The host selects connectionId for this pipe. Child/model-provided identity fields cannot replace it.
    return readJsonLines(
      child.stdout,
      (raw) => {
        if (!raw || Object.keys(raw).sort().join() !== "request,routeId") {
          void writeJsonLine(child.stdin, {
            protocolVersion: WIRE_VERSION,
            routeId: typeof raw?.routeId === "string" ? raw.routeId : null,
            ok: false,
            error: { code: "wire_invalid_frame" }
          }).catch(() => {});
          return;
        }
        const route = raw.routeId;
        void this.route(
          connectionId,
          raw.request,
          (frame) => {
            void writeJsonLine(child.stdin, { ...frame, routeId: route }).catch(() => {});
          },
          () => {
            void writeJsonLine(child.stdin, {
              protocolVersion: WIRE_VERSION,
              routeId: route,
              ok: false,
              error: { code: "connection_closed" }
            }).catch(() => {});
          }
        ).catch((error) => {
          void writeJsonLine(child.stdin, {
            protocolVersion: WIRE_VERSION,
            routeId: route,
            ok: false,
            error: safeError(error)
          }).catch(() => {});
        });
      },
      () => {}
    );
  }
}
