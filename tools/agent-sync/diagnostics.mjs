import process from "node:process";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { basename } from "node:path";
/** Optional fixed-subsystem observations; never record arguments, input/output, environment, text or authority. */
export function installDiagnostics(output = process.stderr) {
  const storage = new AsyncLocalStorage();
  const containerNames = new Map();
  let sequence = 0;
  const emit = (event) =>
    output.write(
      JSON.stringify({ diagnosticVersion: 1, pid: process.pid, monotonicMs: performance.now(), ...event }) + "\n"
    );
  const subsystem = (command) =>
    basename(String(command)) === "git"
      ? "git"
      : basename(String(command)) === "docker"
        ? "docker"
        : command === process.execPath
          ? "oracle"
          : "other";
  const originalSpawn = cp.spawn,
    originalSync = cp.spawnSync;
  function start(command) {
    const event = {
      event: "child-start",
      spanId: ++sequence,
      parentSpanId: storage.getStore()?.spanId ?? null,
      subsystem: subsystem(command)
    };
    return { ...event, started: performance.now() };
  }
  cp.spawn = function (command, args, options) {
    const span = start(command);
    const child = originalSpawn.call(this, command, args, options);
    emit({
      event: "child-start",
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      subsystem: span.subsystem,
      childPid: child.pid
    });
    child.once("close", (status, signal) =>
      emit({
        event: "child-end",
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        subsystem: span.subsystem,
        childPid: child.pid,
        status,
        signal,
        durationMs: performance.now() - span.started
      })
    );
    return child;
  };
  cp.spawnSync = function (command, args, options) {
    const span = start(command);
    let result;
    emit({ event: "child-start", spanId: span.spanId, parentSpanId: span.parentSpanId, subsystem: span.subsystem });
    try {
      result = originalSync.call(this, command, args, options);
      return result;
    } finally {
      emit({
        event: "child-end",
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        subsystem: span.subsystem,
        status: result?.status ?? null,
        durationMs: performance.now() - span.started
      });
      if (span.subsystem === "docker" && Array.isArray(args)) {
        if (args.includes("create")) {
          const id = String(result?.stdout ?? "").trim();
          if (/^[a-f0-9]{64}$/.test(id)) {
            const at = args.indexOf("--name"),
              name = at >= 0 ? args[at + 1] : undefined;
            if (typeof name === "string" && /^cothink-check-[a-f0-9-]{36}$/.test(name)) containerNames.set(name, id);
            emit({ event: "container-created", spanId: span.spanId, parentSpanId: span.parentSpanId, containerId: id });
          }
        }
        if (args.includes("rm"))
          for (const target of args.filter(
            (a) => typeof a === "string" && (/^[a-f0-9]{64}$/.test(a) || containerNames.has(a))
          )) {
            const id = containerNames.get(target) ?? target;
            emit({
              event: "container-remove-ended",
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              containerId: id,
              status: result?.status ?? null
            });
            if (result?.status === 0) containerNames.delete(target);
          }
      }
    }
  };
  syncBuiltinESMExports();
  return {
    async operation(method, requestId, fn) {
      const spanId = ++sequence,
        start = performance.now();
      const operation = [
        "requestScope",
        "currentLease",
        "freezeInput",
        "read",
        "edit",
        "seal",
        "check",
        "finish",
        "release",
        "cancel",
        "status",
        "diff",
        "exportVersion",
        "recover",
        "close"
      ].includes(method)
        ? method
        : "invalid";
      emit({
        event: "operation-start",
        spanId,
        operation,
        requestHash: createHash("sha256").update(String(requestId)).digest("hex")
      });
      return storage.run({ spanId }, async () => {
        try {
          const result = await fn();
          emit({
            event: "operation-end",
            spanId,
            operation,
            result: "returned",
            durationMs: performance.now() - start
          });
          return result;
        } catch (error) {
          emit({
            event: "operation-end",
            spanId,
            operation,
            result: "rejected",
            durationMs: performance.now() - start
          });
          throw error;
        }
      });
    }
  };
}
