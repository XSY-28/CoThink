import { randomUUID, createHash } from "node:crypto";
import { ACTION_VERSION, actionInstruction, decodeAction } from "./protocol.js";
import type { CallerOptions, Inspected } from "./types.js";

const id = () => randomUUID();
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const pick = (v: unknown, keys: string[]) =>
  Object.fromEntries(Object.entries(object(v)).filter(([k]) => keys.includes(k)));
function feedback(value: unknown): Record<string, unknown> {
  const v = object(value);
  return {
    ...pick(v, ["kind", "status", "code", "path", "text", "contentHash"]),
    ...(v.receipt
      ? { receipt: pick(v.receipt, ["passed", "exitCode", "groups", "acceptedVersion", "checkReceiptId"]) }
      : {}),
    ...(Array.isArray(v.files) ? { files: v.files.map((f) => pick(f, ["path", "contentHash"])) } : {})
  };
}
/** Caller policy only. Every lease, scope, check and publication decision belongs to agent-sync. */
export async function runSyncCaller(options: CallerOptions): Promise<void> {
  const stop = new AbortController(),
    signal = AbortSignal.any([
      options.signal,
      stop.signal,
      AbortSignal.timeout(Math.max(1, options.deadlineAt - Date.now()))
    ]);
  let usedCalls = options.usedCalls,
    generation = 0;
  let firstError: unknown;
  const waiters = new Set<() => void>();
  const wake = () => {
    generation++;
    for (const fn of waiters) fn();
    waiters.clear();
  };
  const live = () => {
    if (signal.aborted) throw Error("SYNC_CANCELLED");
    if (Date.now() >= options.deadlineAt) throw Error("SYNC_DEADLINE");
  };
  const awaitLive = <T>(action: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        reject(Error(Date.now() >= options.deadlineAt ? "SYNC_DEADLINE" : "SYNC_CANCELLED"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      Promise.resolve()
        .then(() => {
          live();
          return action();
        })
        .then(
          (value) => {
            signal.removeEventListener("abort", aborted);
            resolve(value);
          },
          (error) => {
            signal.removeEventListener("abort", aborted);
            reject(error);
          }
        );
    });
  const changed = (before: number) =>
    new Promise<void>((resolve, reject) => {
      if (generation !== before) return resolve();
      const done = () => {
        waiters.delete(done);
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        waiters.delete(done);
        signal.removeEventListener("abort", aborted);
        reject(Error("SYNC_CANCELLED"));
      };
      waiters.add(done);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  async function taskLoop(task: CallerOptions["project"]["tasks"][number]) {
    const client = options.clients[task.workerId]!;
    while (true) {
      live();
      const before = generation;
      const status = await awaitLive(() => options.status());
      if (status.tasks.some((t) => t.taskId === task.taskId && t.status === "completed")) return;
      const grant = await awaitLive(() => client.requestScope(task.taskId, id()));
      live();
      if (!grant.task) {
        if (grant.result.kind !== "waiting") throw Error("SYNC_SCOPE_REJECTED");
        options.record({ event: "waiting", taskId: task.taskId });
        await changed(before);
        continue;
      }
      // Keep this task object forever: never rebind a late response to another lease.
      const context = grant.task,
        input = await awaitLive(() => context.freezeInput(id()));
      const files: Inspected[] = [];
      for (const path of [...task.scope.read, ...task.scope.write]) {
        const file = await awaitLive(() => context.read(path, id()));
        const hash = file.text === null ? null : "sha256:" + createHash("sha256").update(file.text).digest("hex");
        if (
          file.baseVersion !== input.baseVersion ||
          hash !== file.contentHash ||
          file.contentHash !== input.contentHashes[path]
        )
          throw Error("SYNC_INPUT_MISMATCH");
        files.push(file);
      }
      options.record({
        event: "input-frozen",
        taskId: task.taskId,
        baseVersion: input.baseVersion,
        inputHash: input.inputHash
      });
      let previous: unknown;
      while (true) {
        live();
        const profile = options.profiles[task.workerId]!;
        const requestId = id();
        const messages = [
          { role: "system" as const, content: actionInstruction },
          {
            role: "user" as const,
            content: JSON.stringify({
              actionVersion: ACTION_VERSION,
              requestId,
              task: { taskId: task.taskId, scope: task.scope, goal: options.instructions[task.taskId] },
              input: { baseVersion: input.baseVersion, inputHash: input.inputHash, files },
              previousToolResult: previous
            })
          }
        ];
        if (messages.reduce((sum, m) => sum + m.content.length, 0) > profile.maxInputCharacters)
          throw Error("SYNC_INPUT_LIMIT");
        if (
          usedCalls >= options.budget.maxCalls ||
          (usedCalls + 1) * options.budget.maxOutputTokensPerCall > options.budget.maxAllocatedOutputTokens
        )
          throw Error("SYNC_BUDGET_EXHAUSTED");
        // This synchronous durable reservation precedes dispatch, including concurrent tasks.
        options.record({
          event: "call-reserved",
          requestId,
          taskId: task.taskId,
          allocatedOutputTokens: options.budget.maxOutputTokensPerCall
        });
        usedCalls++;
        const callController = new AbortController(),
          callSignal = AbortSignal.any([signal, callController.signal]);
        const timeout = setTimeout(
          () => callController.abort(),
          Math.min(options.budget.callTimeoutMs, options.deadlineAt - Date.now())
        );
        let removeAbort = () => {};
        try {
          const aborted = new Promise<never>((_, reject) => {
            const fn = () => reject(Error("SYNC_MODEL_ABORTED"));
            callSignal.addEventListener("abort", fn, { once: true });
            removeAbort = () => callSignal.removeEventListener("abort", fn);
            if (callSignal.aborted) fn();
          });
          const { maxInputCharacters: _limit, ...model } = profile;
          void _limit;
          const reply = await Promise.race([
            options.transport.respond(
              { ...model, messages, maxOutputTokens: options.budget.maxOutputTokensPerCall },
              callSignal
            ),
            aborted
          ]);
          clearTimeout(timeout);
          live();
          if (callSignal.aborted) throw Error("SYNC_MODEL_ABORTED");
          options.record({
            event: "call-returned",
            requestId,
            taskId: task.taskId,
            usage: reply.usage,
            finishReason: reply.finishReason
          });
          if (reply.finishReason !== "stop") throw Error("SYNC_MODEL_INCOMPLETE");
          const action = decodeAction(reply.rawContent, requestId, task);
          live();
          const result = await awaitLive(() => context.runAction(action, id()));
          live();
          previous = feedback(result);
          options.record({
            event: "tool-result",
            taskId: task.taskId,
            requestId,
            action: action.kind,
            result: previous
          });
          if (action.kind === "abort") throw Error("SYNC_MODEL_ABORTED_TASK");
          if (action.kind === "finish") {
            if (object(result).status !== "accepted") throw Error("SYNC_ACCEPTANCE_REJECTED");
            return;
          }
          if (action.kind === "inspect") {
            const item = object(result);
            const index = files.findIndex((f) => f.path === action.path);
            files[index] = {
              path: action.path,
              text: item.text as string | null,
              contentHash: item.contentHash as string | null,
              baseVersion: input.baseVersion
            };
          }
          if (action.kind === "edit") {
            const file = files.find((f) => f.path === action.path)!;
            file.text = action.text;
            file.contentHash = "sha256:" + createHash("sha256").update(action.text).digest("hex");
          }
        } finally {
          clearTimeout(timeout);
          removeAbort();
        }
      }
    }
  }
  const results = await Promise.allSettled(
    options.project.tasks.map(async (task) => {
      try {
        await taskLoop(task);
      } catch (e) {
        firstError ??= e;
        stop.abort();
        throw e;
      } finally {
        wake();
      }
    })
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw firstError ?? failed.reason;
}
