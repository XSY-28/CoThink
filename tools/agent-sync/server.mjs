import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  createDispatcher,
  readJsonLines,
  writeJsonLine,
  safeError,
  publicResult,
  WIRE_VERSION,
  wireError
} from "./protocol.mjs";
/** Only framing/lifetime. All operation, scheduling, verification and acceptance decisions stay in service. */
export function serve({
  service,
  bindings,
  loadState,
  input = process.stdin,
  output = process.stdout,
  diagnostics,
  maxPending = 32
}) {
  const pending = new Set();
  let resolveClose,
    resolveReleased,
    released = false;
  const closeRequested = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const writerReleased = new Promise((resolve) => {
    resolveReleased = resolve;
  });
  const dispatcher = createDispatcher({
    service,
    bindings,
    loadState,
    onClose: () => {
      input.destroy();
      resolveClose();
    }
  });
  const emit = (value) => writeJsonLine(output, { protocolVersion: WIRE_VERSION, ...value });
  let stopped = false;
  function envelope(raw) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join() !== "connectionId,request,routeId" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.routeId)
    )
      throw wireError("wire_invalid_frame");
    return raw;
  }
  async function handle(raw, receivedAt) {
    let routeId = null,
      requestId = null,
      method = "invalid",
      started = receivedAt;
    try {
      const frame = envelope(raw);
      routeId = frame.routeId;
      requestId =
        typeof frame.request?.requestId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(frame.request.requestId)
          ? frame.request.requestId
          : null;
      method = frame.request?.method;
      started = performance.now();
      const run = () => dispatcher.dispatch(frame.connectionId, frame.request);
      const value = diagnostics ? await diagnostics.operation(method, requestId, run) : await run();
      if (method === "close") {
        await writerReleased;
        value.result = { writerReleased: released, pendingOperations: Math.max(0, pending.size - 1) };
      }
      await emit({
        routeId,
        requestId,
        ok: true,
        ...publicResult(value),
        timing: { queueMs: started - receivedAt, toolMs: performance.now() - started }
      });
    } catch (error) {
      await emit({
        routeId,
        requestId,
        ok: false,
        error: safeError(error),
        timing: { queueMs: started - receivedAt, toolMs: performance.now() - started }
      });
    }
  }
  function track(promise) {
    pending.add(promise);
    void promise.catch(() => dispatcher.close()).finally(() => pending.delete(promise));
  }
  const reader = readJsonLines(
    input,
    (raw) => {
      if (stopped) return;
      if (pending.size >= maxPending) {
        stopped = true;
        track(emit({ routeId: null, requestId: null, ok: false, error: { code: "wire_busy" } }));
        dispatcher.close();
        return;
      }
      track(handle(raw, performance.now()));
    },
    (error) => {
      if (stopped || input.destroyed) return;
      stopped = true;
      track(emit({ routeId: null, requestId: null, ok: false, error: safeError(error) }));
      dispatcher.close();
    }
  );
  void reader.finally(() => {
    stopped = true;
    dispatcher.close();
  });
  return {
    closeRequested,
    close: () => {
      stopped = true;
      dispatcher.close();
    },
    markWriterReleased: () => {
      released = true;
      resolveReleased();
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
      await reader;
    }
  };
}
