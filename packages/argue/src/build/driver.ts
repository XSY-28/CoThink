import { hashJson } from "../peer/hash.js";
import {
  ModelTransportFailure,
  type ModelCall,
  type ModelMetadata,
  type ModelReply,
  type ModelTransport
} from "../transport/contracts.js";
import { freezeBuildValue, type BuildLease, type BuildToolResult, type BuildWorkspaceRequest } from "./contracts.js";
import { recoverBuildCalls, reserveBuildCall, settleBuildCall } from "./budget.js";
import { decodeAuthorizedBuildReply, prepareBuildModelRequest } from "./requests.js";
import { buildResult, type BuildResult } from "./result.js";
import { reserveBuildScope, releaseBuildScope } from "./scope.js";
import { scheduleBuildTasks } from "./scheduler.js";
import {
  advanceBuildOwnerEpoch,
  leaseFromBuildAttempt,
  cancelBuildTask,
  expireBuildState,
  parseBuildState,
  validateBuildLease,
  type BuildLeaseAllocator,
  type BuildState
} from "./state.js";
import type { BuildStateWriter } from "./store.js";
import {
  validateWorkspacePortResult,
  validateVerifierPortResult,
  validatePublisherPortResult,
  type BuildSyncPorts
} from "./sync-port.js";

export type BuildModelProfile = Omit<ModelCall, "messages" | "maxOutputTokens">;
export interface BuildDriverEvent {
  readonly type: string;
  readonly at: number;
  readonly observedAt: number;
  readonly taskId?: string;
  readonly workerId?: string;
  readonly attemptId?: string;
  readonly callId?: string;
  readonly requestId?: string;
  readonly details?: unknown;
}
export interface BuildDriverOptions {
  writer: BuildStateWriter;
  ports: BuildSyncPorts;
  transport: ModelTransport;
  models: Readonly<Record<string, BuildModelProfile>>;
  clock?: () => number;
  allocateLease?: BuildLeaseAllocator;
  nextId?: (kind: "call" | "request" | "control") => string;
  onEvent?: (event: BuildDriverEvent) => void | Promise<void>;
  expectedPlanHash?: string;
}
export interface BuildRunOptions {
  taskOrder?: readonly string[];
  signal?: AbortSignal;
}
type Inspected = Extract<BuildToolResult, { kind: "inspected" }>;
type Outcome = { kind: "reply"; reply: ModelReply } | { kind: "failed" | "unknown" | "cancelled" };
const runningWriters = new WeakSet<BuildStateWriter>();
const active = (status: string) => ["running", "checking", "publishing"].includes(status);
// A real macrotask boundary is required even when every injected Promise resolves immediately.
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One finite coordinator. No concrete workspace, disk, Git, Docker or provider implementation enters core. */
export class BuildDriver {
  private readonly clock: () => number;
  private readonly nextId: (kind: "call" | "request" | "control") => string;
  private readonly allocate: BuildLeaseAllocator;
  private planHash: string | undefined;
  private ownerEpoch: number | undefined;
  private recovered = false;
  private stopping: "cancelled" | "deadline" | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private readonly reasons: Record<string, string> = {};
  constructor(private readonly options: BuildDriverOptions) {
    this.clock = options.clock ?? Date.now;
    this.nextId = options.nextId ?? ((kind) => `${kind}-${globalThis.crypto.randomUUID()}`);
    this.allocate =
      options.allocateLease ??
      (() => ({ attemptId: `attempt-${globalThis.crypto.randomUUID()}`, token: globalThis.crypto.randomUUID() }));
    this.planHash = options.expectedPlanHash;
  }
  private async load(): Promise<BuildState> {
    const s = parseBuildState(await this.options.writer.load());
    this.planHash ??= s.plan.planHash;
    if (s.plan.planHash !== this.planHash) throw new Error("Build plan changed; old authorization rejected");
    this.ownerEpoch ??= s.ownerEpoch;
    if (s.ownerEpoch !== this.ownerEpoch) throw new Error("Build owner changed; old authorization rejected");
    return s;
  }
  /** A replacement authority is never writable by an old coordinator, including cleanup. */
  private async transaction<T>(
    operation: (state: BuildState) => Promise<{
      state?: BuildState;
      value: T;
      beforeCommit?: (latest: BuildState) => void | Promise<void>;
    }>
  ): Promise<T> {
    const result = await this.options.writer.transaction(async (state) => {
      this.planHash ??= state.plan.planHash;
      this.ownerEpoch ??= state.ownerEpoch;
      if (state.plan.planHash !== this.planHash) throw new Error("Build plan changed; old authorization rejected");
      if (state.ownerEpoch !== this.ownerEpoch) throw new Error("Build owner changed; old authorization rejected");
      const next = await operation(state);
      // Pure reducers may be no-ops or be composed. One durable transaction is
      // either readonly, or exactly one CAS revision, independent of reducer count.
      const changed = next.state && hashJson(next.state) !== hashJson(state) ? next.state : undefined;
      const committed = changed ? parseBuildState({ ...changed, revision: state.revision + 1 }) : undefined;
      return {
        ...next,
        state: committed,
        value: { value: next.value, ownerEpoch: committed?.ownerEpoch ?? state.ownerEpoch }
      };
    });
    this.ownerEpoch = result.ownerEpoch;
    return result.value;
  }
  private emit(type: string, lease?: BuildLease, extra: Partial<BuildDriverEvent> = {}) {
    const event = freezeBuildValue({
      type,
      at: this.clock(),
      observedAt: Date.now(),
      ...(lease ? { taskId: lease.taskId, workerId: lease.workerId, attemptId: lease.attemptId } : {}),
      ...extra
    });
    // Observers get data only. Their failure cannot alter authority, budget or scheduling.
    try {
      const p = this.options.onEvent?.(event);
      if (p) void p.catch(() => {});
    } catch {
      /* observation failure is isolated */
    }
  }
  private assertLease(s: BuildState, lease: BuildLease) {
    if (this.stopping) throw new Error("Build stopped");
    if (s.plan.planHash !== this.planHash) throw new Error("Build plan changed");
    const valid = validateBuildLease(s, lease, this.clock());
    if (!valid.valid) throw new Error(valid.code);
  }
  private async pause(lease: BuildLease, reason: string) {
    this.reasons[lease.taskId] = reason;
    await this.transaction(async (s) => {
      // A newer owner or completed publication must never be overwritten by an old worker.
      const attempt = s.attempts.find((a) => a.attemptId === lease.attemptId);
      if (!attempt || !active(attempt.status) || attempt.ownerEpoch !== s.ownerEpoch) return { value: undefined };
      const expired = expireBuildState(s, { ownerEpoch: s.ownerEpoch }, this.clock()).state;
      if (!active(expired.attempts.find((a) => a.attemptId === lease.attemptId)!.status))
        return { state: parseBuildState({ ...expired, revision: s.revision + 1 }), value: undefined };
      const t = releaseBuildScope(expired, lease, this.nextId("control"), this.clock());
      return { state: parseBuildState({ ...t.state, revision: s.revision + 1 }), value: undefined };
    });
    this.emit("task_paused", lease, { details: { reason } });
  }
  private async settle(callId: string, status: "succeeded" | "failed" | "cancelled" | "unknown") {
    await this.transaction(async (s) => {
      const row = s.calls.find((c) => c.callId === callId);
      if (!row || row.status !== "reserved") return { value: undefined };
      return { state: settleBuildCall(s, callId, status, this.clock()), value: undefined };
    });
  }
  private stop(reason: "cancelled" | "deadline"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = reason;
    for (const c of this.controllers.values()) c.abort();
    this.stopPromise = this.transaction(async (s) => {
      if (s.status === "completed") return { value: undefined };
      let next = recoverBuildCalls(s, this.clock());
      if (reason === "deadline") next = expireBuildState(next, { ownerEpoch: next.ownerEpoch }, this.clock()).state;
      else {
        for (const task of next.plan.tasks)
          if (!next.acceptedTasks.includes(task.taskId)) {
            next = cancelBuildTask(
              next,
              {
                taskId: task.taskId,
                workerId: task.workerId,
                ownerEpoch: next.ownerEpoch,
                requestId: this.nextId("control")
              },
              this.clock()
            ).state;
          }
        next = parseBuildState({ ...next, revision: s.revision + 1, status: "cancelled" });
      }
      return { state: parseBuildState({ ...next, revision: s.revision + 1 }), value: undefined };
    });
    return this.stopPromise;
  }
  async cancel(): Promise<BuildResult> {
    await this.stop("cancelled");
    return buildResult(await this.load(), this.reasons);
  }
  /** Recovery never dispatches transport or tools. Reserved requests become unknown and old authority is revoked. */
  async recover(): Promise<BuildResult> {
    if (runningWriters.has(this.options.writer)) throw new Error("Build driver is running");
    await this.transaction(async (s) => {
      this.planHash ??= s.plan.planHash;
      if (s.plan.planHash !== this.planHash) throw new Error("Build plan changed");
      const charged = recoverBuildCalls(s, this.clock());
      if (charged.status === "completed" || charged.status === "cancelled")
        return {
          state: charged.revision === s.revision ? undefined : charged,
          value: undefined
        };
      const revoked = advanceBuildOwnerEpoch(
        charged,
        { ownerEpoch: charged.ownerEpoch },
        this.nextId("control"),
        this.clock()
      ).state;
      return {
        state: parseBuildState({ ...revoked, revision: s.revision + 1, status: "paused" }),
        value: undefined
      };
    });
    this.recovered = true;
    this.emit("recovered");
    return buildResult(await this.load(), this.reasons);
  }
  async retry(options: BuildRunOptions = {}): Promise<BuildResult> {
    if (!this.recovered) return this.recover();
    return this.execute(options, true);
  }
  async run(options: BuildRunOptions = {}): Promise<BuildResult> {
    return this.execute(options, false);
  }

  private async invoke(
    call: ModelCall,
    lease: BuildLease,
    callId: string,
    requestId: string,
    deadline: number
  ): Promise<Outcome> {
    const c = new AbortController();
    this.controllers.set(callId, c);
    let timedOut = false,
      settled = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        c.abort();
      },
      Math.max(0, deadline - this.clock())
    );
    let abort!: () => void;
    const cancelled = new Promise<Outcome>((resolve) => {
      abort = () => resolve({ kind: timedOut ? "unknown" : "cancelled" });
      c.signal.addEventListener("abort", abort, { once: true });
      if (this.stopping) c.abort();
    });
    const metadata = (reply: ModelMetadata) => ({
      modelId: reply.modelId,
      protocol: reply.protocol,
      generationOptions: structuredClone(reply.generationOptions),
      usage: structuredClone(reply.usage),
      finishReason: reply.finishReason
    });
    this.emit("model_started", lease, { callId, requestId });
    const pending = Promise.resolve()
      .then(() => this.options.transport.respond(call, c.signal))
      .then<Outcome, Outcome>(
        (reply) => {
          if (settled) this.emit("model_late", lease, { callId, requestId, details: { runtime: metadata(reply) } });
          return { kind: "reply", reply };
        },
        (error) => {
          if (settled) this.emit("model_late", lease, { callId, requestId, details: { status: "failed" } });
          return {
            kind:
              error instanceof ModelTransportFailure &&
              !["timeout", "aborted", "network_error", "transport_error", "unknown"].includes(error.error.code)
                ? "failed"
                : "unknown"
          } as Outcome;
        }
      );
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      settled = true;
      clearTimeout(timer);
      c.signal.removeEventListener("abort", abort);
      this.controllers.delete(callId);
    }
  }
  private async workspace(request: BuildWorkspaceRequest): Promise<BuildToolResult> {
    const w = this.options.ports.workspace;
    let result: BuildToolResult;
    switch (request.operation) {
      case "freeze":
        result = await w.freezeInput(request.lease, request.requestId);
        break;
      case "inspect":
        result = await w.inspect(request.lease, request.requestId, request.path);
        break;
      case "edit":
        result = await w.edit(request.lease, request.requestId, request.edits);
        break;
      case "seal":
        result = await w.seal(request.lease, request.requestId);
        break;
    }
    const after = await this.load();
    this.assertLease(after, request.lease);
    return validateWorkspacePortResult(after, request, result);
  }
  private async work(lease: BuildLease): Promise<void> {
    let outstandingCall: string | undefined;
    try {
      let state = await this.load();
      this.assertLease(state, lease);
      const frozen = await this.workspace({ operation: "freeze", lease, requestId: this.nextId("request") });
      if (frozen.kind !== "frozen") throw new Error("Wrong frozen result");
      this.emit("input_frozen", lease, {
        details: { baseVersion: frozen.baseVersion, inputHash: frozen.inputHash, contentHashes: frozen.contentHashes }
      });
      state = await this.load();
      const task = state.plan.tasks.find((t) => t.taskId === lease.taskId)!;
      const materials: Inspected[] = [];
      for (const path of [...task.scope.read, ...task.scope.write]) {
        const r = await this.workspace({ operation: "inspect", lease, requestId: this.nextId("request"), path });
        if (r.kind !== "inspected") throw new Error("Wrong inspect result");
        materials.push(r);
      }
      let previous: unknown;
      while (!this.stopping) {
        await yieldTurn();
        state = await this.load();
        this.assertLease(state, lease);
        const callId = this.nextId("call"),
          requestId = this.nextId("request");
        const reserved = await this.transaction(async (s) => {
          this.assertLease(s, lease);
          const r = reserveBuildCall(s, lease, callId, this.clock());
          return { state: r.state, value: r.call };
        });
        outstandingCall = callId;
        state = await this.load();
        const prepared = prepareBuildModelRequest(state, lease, callId, requestId, materials, previous);
        const profile = this.options.models[lease.workerId];
        const call = freezeBuildValue({
          ...structuredClone(profile),
          messages: prepared.messages,
          maxOutputTokens: reserved.allocatedOutputTokens
        }) as unknown as ModelCall;
        const outcome = await this.invoke(call, lease, callId, requestId, reserved.deadlineAt);
        if (outcome.kind === "reply" && this.clock() >= reserved.deadlineAt) {
          await this.settle(callId, "unknown");
          this.emit("model_finished", lease, {
            callId,
            requestId,
            details: { status: "unknown", reason: "call_deadline" }
          });
          await this.pause(lease, "call_deadline_exceeded");
          return;
        }
        if (outcome.kind !== "reply") {
          await this.settle(callId, outcome.kind);
          this.emit("model_finished", lease, { callId, requestId, details: { status: outcome.kind } });
          await this.pause(lease, `model_${outcome.kind}`);
          return;
        }
        let authorized;
        try {
          authorized = decodeAuthorizedBuildReply(state.plan, prepared.context, outcome.reply.rawContent);
        } catch {
          await this.settle(callId, "failed");
          this.emit("model_finished", lease, { callId, requestId, details: { status: "invalid_response" } });
          await this.pause(lease, "invalid_response");
          return;
        }
        await this.settle(callId, "succeeded");
        this.emit("model_finished", lease, {
          callId,
          requestId,
          details: { status: "succeeded", runtime: metadataOf(outcome.reply) }
        });
        await yieldTurn();
        state = await this.load();
        this.assertLease(state, lease);
        const action = authorized.action;
        if (action.kind === "abort") {
          await this.pause(lease, "worker_aborted");
          return;
        }
        if (action.kind === "finish") {
          const before = await this.load();
          this.assertLease(before, lease);
          const response = await this.options.ports.publisher.finish(lease, requestId);
          const after = await this.load();
          validatePublisherPortResult(before, lease, requestId, response, after);
          delete this.reasons[lease.taskId];
          this.emit("published", lease, {
            requestId,
            details: { acceptedVersion: response.receipt.acceptedVersion, receipt: response.receipt }
          });
          return;
        }
        if (action.kind === "check") {
          const sealed = await this.workspace({ operation: "seal", lease, requestId: this.nextId("request") });
          if (sealed.kind !== "sealed") throw new Error("Wrong seal result");
          const request = { requestId, lease, candidate: sealed };
          const result = await this.options.ports.verifier.check(request);
          state = await this.load();
          this.assertLease(state, lease);
          const valid = validateVerifierPortResult(state, request, result);
          previous = {
            kind: "checked",
            passed: valid.receipt.passed,
            exitCode: valid.receipt.exitCode,
            groups: valid.receipt.groups
          };
        } else if (action.kind === "inspect") {
          const r = await this.workspace({ operation: "inspect", lease, requestId, path: action.path });
          if (r.kind !== "inspected") throw new Error("Wrong inspect result");
          previous = r;
        } else {
          const r = await this.workspace({
            operation: "edit",
            lease,
            requestId,
            edits: [{ path: action.path, text: action.text, expectedContentHash: action.expectedContentHash }]
          });
          if (r.kind !== "edited") throw new Error("Wrong edit result");
          const hash = r.files.find((f) => f.path === action.path)?.contentHash;
          if (!hash) throw new Error("Edited file hash missing");
          const index = materials.findIndex((f) => f.path === action.path);
          materials[index] = {
            kind: "inspected",
            baseVersion: r.baseVersion,
            path: action.path,
            text: action.text,
            contentHash: hash
          };
          previous = { kind: "edited", files: r.files.map(({ path, contentHash }) => ({ path, contentHash })) };
        }
        this.emit("tool_succeeded", lease, { requestId, details: { kind: action.kind } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (outstandingCall) await this.settle(outstandingCall, "unknown");
      await this.pause(
        lease,
        message.includes("budget")
          ? "budget_exhausted"
          : message.includes("deadline")
            ? "deadline_exceeded"
            : "request_rejected"
      );
    }
  }
  private async execute(options: BuildRunOptions, resume: boolean): Promise<BuildResult> {
    if (runningWriters.has(this.options.writer)) throw new Error("Build driver is running");
    runningWriters.add(this.options.writer);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      void this.stop("cancelled").catch(() => {});
    };
    try {
      let state = await this.load();
      if (state.status === "completed" || state.status === "cancelled") return buildResult(state, this.reasons);
      if (
        !resume &&
        (state.attempts.length > 0 || state.calls.some((c) => c.status === "reserved" || c.status === "unknown"))
      )
        return this.recoveryRequired(state);
      for (const member of state.plan.memberIds) {
        const p = this.options.models[member];
        if (
          !p ||
          !p.protocol ||
          !p.modelId ||
          !p.baseUrl ||
          !p.apiKeyEnv ||
          !["json_object", "prompt_json"].includes(p.outputMode)
        )
          throw new Error("Invalid build model profile");
      }
      const order = [...(options.taskOrder ?? state.plan.tasks.map((t) => t.taskId))];
      if (
        new Set(order).size !== state.plan.tasks.length ||
        order.length !== state.plan.tasks.length ||
        order.some((id) => !state.plan.tasks.some((t) => t.taskId === id))
      )
        throw new Error("Task order must name each frozen task once");
      this.stopping = undefined;
      this.stopPromise = undefined;
      if (options.signal?.aborted) {
        await this.stop("cancelled");
        return buildResult(await this.load(), this.reasons);
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      if (this.clock() >= state.deadlineAt) {
        await this.stop("deadline");
        return buildResult(await this.load(), this.reasons);
      }
      deadlineTimer = setTimeout(
        () => {
          void this.stop("deadline").catch(() => {});
        },
        Math.max(0, state.deadlineAt - this.clock())
      );
      if (resume)
        await this.transaction(async (s) => ({
          state: parseBuildState({ ...s, revision: s.revision + 1, status: "active" }),
          value: undefined
        }));
      const initial: BuildLease[] = [];
      for (const taskId of order) {
        const granted = await this.transaction(async (s) => {
          if (this.stopping || s.acceptedTasks.includes(taskId)) return { value: [] as BuildLease[] };
          const task = s.plan.tasks.find((t) => t.taskId === taskId)!;
          const t = reserveBuildScope(
            s,
            { taskId, workerId: task.workerId, ownerEpoch: s.ownerEpoch, requestId: this.nextId("control") },
            this.clock(),
            this.allocate
          );
          // A reservation drains the whole queue: it can grant an older waiter
          // while returning "waiting" for this task. Consume every new lease.
          const previous = new Set(s.attempts.map((attempt) => attempt.attemptId));
          const grants = t.state.attempts
            .filter((attempt) => !previous.has(attempt.attemptId) && active(attempt.status))
            .map(leaseFromBuildAttempt);
          if (t.result.kind !== "granted")
            this.emit("scope_waiting", undefined, { taskId, workerId: task.workerId, details: t.result });
          return { state: t.state, value: grants };
        });
        for (const lease of granted) {
          initial.push(lease);
          delete this.reasons[lease.taskId];
          this.emit("scope_granted", lease);
        }
      }
      const jobs = new Map<string, Promise<void>>();
      const launch = (lease: BuildLease) => {
        const job = this.work(lease).finally(() => jobs.delete(lease.attemptId));
        jobs.set(lease.attemptId, job);
      };
      for (const grant of initial) launch(grant);
      while (jobs.size) {
        await Promise.race(jobs.values());
        if (this.stopping) {
          await Promise.all(jobs.values());
          break;
        }
        const next = await this.transaction(async (s) => {
          const r = scheduleBuildTasks(s, { ownerEpoch: s.ownerEpoch }, this.clock(), this.allocate);
          return { state: r.state, value: r.grants };
        });
        for (const lease of next) {
          delete this.reasons[lease.taskId];
          this.emit("scope_granted", lease);
          launch(lease);
        }
      }
      await this.stopPromise;
      await this.transaction(async (s) => {
        if (s.status === "cancelled") return { value: undefined };
        const complete = s.plan.tasks.every((t) => s.acceptedTasks.includes(t.taskId));
        let next = expireBuildState(s, { ownerEpoch: s.ownerEpoch }, this.clock()).state;
        if (!complete && next.attempts.some((a) => active(a.status)))
          next = advanceBuildOwnerEpoch(
            next,
            { ownerEpoch: next.ownerEpoch },
            this.nextId("control"),
            this.clock()
          ).state;
        return {
          state: parseBuildState({ ...next, revision: s.revision + 1, status: complete ? "completed" : "paused" }),
          value: undefined
        };
      });
      return buildResult(await this.load(), this.reasons);
    } finally {
      // Exceptional exit must stop sibling transport work without writing to a replacement owner.
      for (const controller of this.controllers.values()) controller.abort();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", abort);
      runningWriters.delete(this.options.writer);
    }
  }
  private recoveryRequired(state: BuildState): BuildResult {
    for (const t of state.plan.tasks)
      if (!state.acceptedTasks.includes(t.taskId)) this.reasons[t.taskId] = "recovery_required";
    return buildResult(state, this.reasons);
  }
}
function metadataOf(reply: ModelReply): ModelMetadata {
  return {
    modelId: reply.modelId,
    protocol: reply.protocol,
    generationOptions: structuredClone(reply.generationOptions),
    usage: structuredClone(reply.usage),
    finishReason: reply.finishReason
  };
}
