import { editLimitViolation } from "./resources.js";
import { z } from "zod";
import { hashJson } from "../../peer/hash.js";
import { SyncVersionIdSchema, SyncPathSchema, SyncHashSchema, freezeSyncValue } from "./primitives.js";
import type { StateWriter, LeaseAllocator, LeaseIdentity } from "./types.js";
import { isActiveAttempt } from "./invariants.js";
import type { ToolResult } from "./ports.js";
import type {
  AgentSyncDiff,
  AgentSyncDiffOptions,
  AgentSyncExportOptions,
  AgentSyncExportResult,
  AgentSyncHostOperations,
  ServiceState,
  ServiceStatus,
  ServiceRecovery,
  ServiceOptions,
  ServiceProtocol,
  ServicePorts,
  WorkspaceOperation,
  WorkerClient
} from "./service-types.js";
export type {
  AgentSyncDiff,
  AgentSyncDiffOptions,
  AgentSyncExportOptions,
  AgentSyncExportResult,
  AgentSyncHostOperations
} from "./service-types.js";
/** Safe, stable service failures. Backend diagnostics remain available only as a cause. */
export class AgentSyncError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown
  ) {
    super(`Agent sync operation rejected (${code})`, cause === undefined ? undefined : { cause });
    this.name = "AgentSyncError";
  }
}
function fail(code: string): never {
  throw new AgentSyncError(code);
}
const diffOptionsSchema = z
  .object({ fromVersion: SyncVersionIdSchema.optional(), toVersion: SyncVersionIdSchema.optional() })
  .strict();
const exportOptionsSchema = z.object({ target: z.string().min(1), version: SyncVersionIdSchema.optional() }).strict();
const diffSchema = z
  .object({
    fromVersion: SyncVersionIdSchema,
    toVersion: SyncVersionIdSchema,
    files: z.array(
      z
        .object({
          path: SyncPathSchema,
          beforeHash: SyncHashSchema.nullable(),
          afterHash: SyncHashSchema.nullable()
        })
        .strict()
    )
  })
  .strict();
const exportSchema = z
  .object({ status: z.literal("exported"), version: SyncVersionIdSchema, directory: z.string().min(1) })
  .strict();
/** Values here are owned parser outputs or freshly built projections. Freezing does
 * not change their protocol type, including literal versions and generic results. */
function freezeOwned<T>(value: T): T {
  freezeSyncValue(value);
  return value;
}
function copy<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return freezeOwned(schema.parse(value));
  } catch (cause) {
    throw new AgentSyncError("invalid_input", cause);
  }
}
/** Callable coordination over existing reducers and ports; no worker loop or model transport. */
export class SharedAgentSyncService<
  M extends string,
  S extends ServiceState,
  L extends LeaseIdentity<M>,
  W extends WorkspaceOperation<L>,
  T extends ToolResult,
  VQ extends { lease: L; requestId: string; candidate: Extract<T, { kind: "sealed" }> },
  VR,
  PR,
  O extends { kind: string },
  V extends string
> {
  private projection(s: S): ServiceStatus<S, V> {
    return freezeOwned({
      serviceVersion: this.protocol.serviceVersion,
      projectKey: s.projectKey,
      runId: s.runId,
      planHash: s.plan.planHash,
      acceptedVersion: s.acceptedVersion,
      status: s.status,
      tasks: s.plan.tasks.map((t) => ({
        taskId: t.taskId,
        workerId: t.workerId,
        status: s.coordination.taskStates[t.taskId]! as S["coordination"]["taskStates"][string]
      })),
      waiting: s.waiting.map(({ taskId, sequence }) => ({ taskId, sequence }))
    });
  }

  private closed = false;
  private ownerEpoch: number | undefined;
  private readonly ready: Promise<void>;
  private readonly writer: StateWriter<S>;
  private readonly ports: ServicePorts<L, T, VQ, VR, PR>;
  private readonly host?: AgentSyncHostOperations;
  private readonly planHash: string;
  private readonly runId: string;
  private readonly clock: () => number;
  private readonly allocate: LeaseAllocator<M>;
  // Standalone checks have session-local query semantics in existing backends.
  // This only closes same-session cross-operation/concurrent ID reuse; it is not a durable journal.
  private readonly bindings = new Map<string, string>();
  private readonly admittedIds = new Set<string>();
  private limits?: { maxSessionRequests: number; maxEditsPerRequest: number; maxTextBytes: number };
  private capture<T>(parse: () => T): T {
    try {
      return freezeOwned(parse());
    } catch (cause) {
      throw new AgentSyncError("invalid_input", cause);
    }
  }
  private async admit(id: string): Promise<void> {
    this.open();
    await this.ready;
    this.open();
    if (!this.limits || this.admittedIds.has(id)) return;
    if (this.admittedIds.size >= this.limits.maxSessionRequests) fail("session_request_limit");
    this.admittedIds.add(id);
  }

  constructor(
    options: ServiceOptions<M, S, L, T, VQ, VR, PR>,
    private readonly protocol: ServiceProtocol<M, S, L, W, T, VQ, VR, PR, O, V>
  ) {
    this.writer = options.writer;
    this.ports = options.ports;
    this.host = options.host;
    this.planHash = copy(protocol.hash, options.expectedPlanHash);
    this.runId = copy(protocol.id, options.expectedRunId);
    this.ownerEpoch =
      options.expectedOwnerEpoch === undefined
        ? undefined
        : copy(z.number().int().positive().safe(), options.expectedOwnerEpoch);
    this.clock = options.clock ?? (() => Date.now());
    this.allocate = options.allocateLease ?? (() => ({ attemptId: crypto.randomUUID(), token: crypto.randomUUID() }));
    // Capture this owner's initial epoch once, never silently adopt an external replacement.
    this.ready = this.writer.load().then((raw) => {
      const state = this.guard(raw, false);
      this.ownerEpoch ??= state.ownerEpoch;
      this.limits = this.protocol.resources?.(state);
    });
    // A caller may close without ever awaiting readiness; retain rejection for the next operation.
    void this.ready.catch(() => {});
  }
  private open(): void {
    if (this.closed) fail("service_closed");
  }
  private guard(raw: S, requireOwner = true): S {
    this.open();
    const s = this.protocol.parse(raw);
    if (s.runId !== this.runId) fail("run_id_mismatch");
    if (s.plan.planHash !== this.planHash) fail("plan_hash_mismatch");
    if ((requireOwner || this.ownerEpoch !== undefined) && s.ownerEpoch !== this.ownerEpoch)
      fail("owner_epoch_mismatch");
    return s;
  }
  private async load(): Promise<S> {
    this.open();
    await this.ready;
    this.open();
    return this.guard(await this.writer.load());
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.open();
      return await operation();
    } catch (cause) {
      if (cause instanceof AgentSyncError) throw cause;
      throw new AgentSyncError("port_rejected", cause);
    }
  }
  private now(s: S): number {
    const now = this.clock();
    try {
      this.protocol.validateNow(s, now);
    } catch (cause) {
      throw new AgentSyncError("invalid_clock", cause);
    }
    return now;
  }
  private task(s: S, workerId: string, taskId: string): void {
    if (!s.plan.memberIds.includes(workerId)) fail("unknown_worker");
    const task = s.plan.tasks.find((t) => t.taskId === taskId);
    if (!task) fail("unknown_task");
    if (task.workerId !== workerId) fail("worker_task_mismatch");
  }
  private identity(s: S, workerId: string, lease: L): void {
    this.task(s, workerId, lease.taskId);
    if (lease.workerId !== workerId) fail("worker_task_mismatch");
    const attempt = s.attempts.find((a) => a.attemptId === lease.attemptId);
    if (!attempt || hashJson(this.protocol.leaseFor(s, attempt)) !== hashJson(lease)) fail("identity_mismatch");
  }
  private current(s: S, lease: L): void {
    const valid = this.protocol.validateLease(s, lease, this.now(s));
    if (!valid.valid) fail(valid.code);
  }
  private bind(requestId: string, context: unknown): boolean {
    const hash = hashJson(context),
      prior = this.bindings.get(requestId);
    if (prior !== undefined && prior !== hash) return false;
    this.bindings.set(requestId, hash);
    return true;
  }
  private controlCollision(s: S, requestId: string, context: unknown): boolean {
    return !!(
      s.workspace?.toolReceipts.some((r) => r.requestId === requestId) ||
      s.publishReceipts.some((r) => r.requestId === requestId) ||
      this.protocol.extraRequestIds?.(s).includes(requestId) ||
      !this.bind(requestId, context)
    );
  }
  private portCollision(s: S, requestId: string, context: unknown, kind: "workspace" | "check" | "publish"): void {
    if (
      s.coordination.requests.some((r) => r.requestId === requestId) ||
      this.protocol.extraRequestIds?.(s).includes(requestId) ||
      (kind !== "workspace" && s.workspace?.toolReceipts.some((r) => r.requestId === requestId)) ||
      (kind !== "publish" && s.publishReceipts.some((r) => r.requestId === requestId)) ||
      !this.bind(requestId, context)
    )
      fail("request_id_conflict");
  }
  private async control(
    workerId: M,
    operation: "reserve" | "cancel" | "release",
    taskId: string,
    requestId: string,
    lease?: L
  ): Promise<O> {
    await this.admit(requestId);
    await this.load();
    return this.writer.transaction(async (raw) => {
      const s = this.guard(raw);
      this.task(s, workerId, taskId);
      if (lease) this.identity(s, workerId, lease);
      // Rejections have no durable receipt: retain their trusted epoch in this session's binding.
      // Release remains bound to its original exact lease so historical success stays replayable.
      const context = { operation, workerId, taskId, ...(lease ? { lease } : { ownerEpoch: s.ownerEpoch }) };
      if (this.controlCollision(s, requestId, context)) return { value: this.protocol.rejected("request_id_conflict") };
      const now = this.now(s);
      if (
        operation === "reserve" &&
        !s.coordination.requests.some((r) => r.requestId === requestId) &&
        s.coordination.taskStates[taskId] === "cancelled"
      )
        return { value: this.protocol.rejected("task_cancelled") };
      // Replay first: querying an old receipt must never resume a paused run.
      const resuming =
        operation === "reserve" &&
        s.status === "paused" &&
        now < s.deadlineAt &&
        !s.coordination.requests.some((r) => r.requestId === requestId);
      const initial = resuming ? this.protocol.parse({ ...s, status: "active" }) : s;
      const transition =
        operation === "reserve"
          ? this.protocol.reserve(initial, workerId, taskId, requestId, now, this.allocate)
          : operation === "cancel"
            ? this.protocol.cancel(s, workerId, taskId, requestId, now)
            : this.protocol.release(s, lease!, requestId, now);
      // A composed pure transition still commits exactly one durable writer revision.
      const changed = transition.state.revision !== initial.revision;
      const state = changed ? this.protocol.parse({ ...transition.state, revision: s.revision + 1 }) : undefined;
      return { state, value: freezeOwned(transition.result) };
    });
  }
  forWorker(workerId: string): WorkerClient<L, T, O, VR, PR> {
    this.open();
    const parsed = this.protocol.member.safeParse(workerId);
    if (!parsed.success) fail("unknown_worker");
    const worker = parsed.data;
    return Object.freeze({
      workerId: worker,
      requestScope: (taskId: string, requestId: string) =>
        this.safe(async () => {
          const task = copy(this.protocol.id, taskId),
            id = copy(this.protocol.id, requestId);
          return this.control(worker, "reserve", task, id);
        }),
      currentLease: (taskId: string) =>
        this.safe(async () => {
          const task = copy(this.protocol.id, taskId),
            s = await this.load();
          this.task(s, worker, task);
          const now = this.now(s);
          const attempt = s.attempts.find((a) => a.taskId === task && a.workerId === worker && isActiveAttempt(a));
          if (!attempt) return null;
          const lease = this.protocol.leaseFor(s, attempt);
          return this.protocol.validateLease(s, lease, now).valid ? lease : null;
        }),
      freezeInput: (lease: L, requestId: string) =>
        this.workspace(worker, { operation: "freeze", lease, requestId }) as Promise<Extract<T, { kind: "frozen" }>>,
      read: (lease: L, requestId: string, path: string) =>
        this.workspace(worker, { operation: "inspect", lease, requestId, path }) as Promise<
          Extract<T, { kind: "inspected" }>
        >,
      edit: (
        lease: L,
        requestId: string,
        edits: readonly { path: string; text: string; expectedContentHash: string | null }[]
      ) =>
        this.workspace(worker, { operation: "edit", lease, requestId, edits }) as Promise<
          Extract<T, { kind: "edited" }>
        >,
      seal: (lease: L, requestId: string) =>
        this.workspace(worker, { operation: "seal", lease, requestId }) as Promise<Extract<T, { kind: "sealed" }>>,
      check: (lease: L, requestId: string, candidate: Extract<T, { kind: "sealed" }>) =>
        this.check(worker, lease, requestId, candidate),
      finish: (lease: L, requestId: string) => this.finish(worker, lease, requestId),
      release: (lease: L, requestId: string) =>
        this.safe(async () => {
          const identity = copy(this.protocol.lease, lease),
            id = copy(this.protocol.id, requestId);
          return this.control(worker, "release", identity.taskId, id, identity);
        }),
      cancel: (taskId: string, requestId: string) =>
        this.safe(async () => {
          const task = copy(this.protocol.id, taskId),
            id = copy(this.protocol.id, requestId);
          return this.control(worker, "cancel", task, id);
        })
    });
  }
  private workspace(workerId: string, raw: WorkspaceOperation<L>): Promise<T> {
    return this.safe(async () => {
      if (this.protocol.resources) {
        const code = editLimitViolation(raw, { maxEditsPerRequest: 128, maxTextBytes: 1048576 });
        if (code) fail(code);
      }
      const request = this.capture(() => this.protocol.workspace(raw));
      await this.admit(request.requestId);
      if (this.limits) {
        // An admitted request remains immutable even when project limits reject it.
        // Claim before any further IO, so changed retries cannot bypass the rejection.
        if (!this.bind(request.requestId, { operation: "workspace", request })) fail("request_id_conflict");
        const code = editLimitViolation(request, this.limits);
        if (code) fail(code);
      }
      const s = await this.load();
      this.identity(s, workerId, request.lease);
      this.portCollision(s, request.requestId, { operation: "workspace", request }, "workspace");
      const old = s.workspace?.toolReceipts.find((r) => r.requestId === request.requestId);
      if (old && hashJson(old.request) !== hashJson(request)) fail("request_id_conflict");
      if (!old) {
        this.current(s, request.lease);
        const task = s.plan.tasks.find((t) => t.taskId === request.lease.taskId)!;
        if (request.operation === "inspect" && ![...task.scope.read, ...task.scope.write].includes(request.path))
          fail("scope_violation");
        if (request.operation === "edit" && request.edits.some((e) => !task.scope.write.includes(e.path)))
          fail("scope_violation");
      }
      const w = this.ports.workspace;
      const result =
        request.operation === "freeze"
          ? await w.freezeInput(request.lease, request.requestId)
          : request.operation === "inspect"
            ? await w.inspect(request.lease, request.requestId, request.path)
            : request.operation === "edit"
              ? await w.edit(request.lease, request.requestId, request.edits)
              : await w.seal(request.lease, request.requestId);
      const after = await this.load();
      if (!old) this.current(after, request.lease);
      return this.protocol.validateWorkspace(after, request, result);
    });
  }
  private check(workerId: string, lease: L, requestId: string, candidate: Extract<T, { kind: "sealed" }>): Promise<VR> {
    return this.safe(async () => {
      const request = this.capture(() => this.protocol.verifier({ lease, requestId, candidate }));
      await this.admit(request.requestId);
      const s = await this.load();
      this.identity(s, workerId, request.lease);
      this.portCollision(s, request.requestId, { operation: "check", request }, "check");
      this.current(s, request.lease);
      const { kind: _kind, ...sealed } = request.candidate;
      void _kind;
      if (
        !s.workspace?.candidates.some(
          (c) => hashJson(c) === hashJson({ attemptId: request.lease.attemptId, ...sealed })
        )
      )
        fail("candidate_mismatch");
      const response = await this.ports.verifier.check(request);
      const after = await this.load();
      this.current(after, request.lease);
      return this.protocol.validateVerifier(after, request, response);
    });
  }
  private finish(workerId: string, rawLease: L, rawRequestId: string): Promise<PR> {
    return this.safe(async () => {
      const lease = copy(this.protocol.lease, rawLease),
        requestId = copy(this.protocol.id, rawRequestId);
      this.capture(() => this.protocol.publisher(lease, requestId));
      await this.admit(requestId);
      const before = await this.load();
      this.identity(before, workerId, lease);
      this.portCollision(before, requestId, { operation: "publish", lease, requestId }, "publish");
      const old = before.publishReceipts.find((r) => r.requestId === requestId);
      if (old) {
        const hash = this.protocol.publishHash(before, lease, requestId);
        if (old.requestHash !== hash) fail("request_id_conflict");
      } else this.current(before, lease);
      const response = await this.ports.publisher.finish(lease, requestId);
      const after = await this.load();
      const valid = this.protocol.validatePublisher(before, lease, requestId, response, after);
      if (!old && after.status !== "completed" && after.plan.tasks.every((t) => after.acceptedTasks.includes(t.taskId)))
        await this.writer.transaction(async (raw) => {
          const s = this.guard(raw);
          if (s.status === "completed" || !s.plan.tasks.every((t) => s.acceptedTasks.includes(t.taskId)))
            return { value: undefined };
          return {
            state: this.protocol.parse({ ...s, status: "completed", revision: s.revision + 1 }),
            value: undefined
          };
        });
      return valid;
    });
  }
  status(): Promise<ServiceStatus<S, V>> {
    return this.safe(async () => this.projection(await this.load()));
  }
  recover(rawRequestId: string): Promise<ServiceRecovery<S, V>> {
    return this.safe(async () => {
      const requestId = copy(this.protocol.id, rawRequestId);
      await this.admit(requestId);
      const initial = await this.load();
      const prior = initial.coordination.requests.find((r) => r.requestId === requestId);
      const replayed = (s: S): boolean => {
        const receipt = s.coordination.requests.find((r) => r.requestId === requestId);
        return (
          receipt?.operation === "epoch" &&
          receipt.status === "succeeded" &&
          receipt.result?.kind === "epoch_advanced" &&
          receipt.result.ownerEpoch === s.ownerEpoch &&
          receipt.payloadHash === this.protocol.epochHash(s, requestId, s.ownerEpoch - 1)
        );
      };
      if (prior) {
        if (!replayed(initial)) fail("request_id_conflict");
        return freezeOwned({
          ...this.projection(initial),
          replayedActions: 0 as const,
          ownerEpoch: initial.ownerEpoch
        });
      }
      if (this.controlCollision(initial, requestId, { operation: "recover" })) fail("request_id_conflict");
      // Host validation may itself use the writer: never invoke it under a writer transaction.
      if (this.host) await this.host.recover();
      const next = await this.writer.transaction(async (raw) => {
        const s = this.guard(raw);
        if (s.coordination.requests.some((r) => r.requestId === requestId)) {
          if (!replayed(s)) fail("request_id_conflict");
          return { value: s };
        }
        if (this.controlCollision(s, requestId, { operation: "recover" })) fail("request_id_conflict");
        const now = this.now(s),
          charged = this.protocol.recoverExtension?.(s, now) ?? s;
        const transition = this.protocol.advanceOwner(charged, requestId, now);
        if (transition.result.kind !== "epoch_advanced") fail("request_id_conflict");
        const state = this.protocol.parse({
          ...transition.state,
          revision: s.revision + 1,
          status:
            s.status === "completed" || s.status === "cancelled"
              ? s.status
              : s.plan.tasks.every((t) => s.acceptedTasks.includes(t.taskId))
                ? "completed"
                : "paused"
        });
        return { state, value: state };
      });
      // Adopt exactly the shift this guarded transaction authorized, after successful commit.
      this.ownerEpoch = next.ownerEpoch;
      return freezeOwned({ ...this.projection(next), replayedActions: 0 as const, ownerEpoch: next.ownerEpoch });
    });
  }
  diff(rawOptions?: AgentSyncDiffOptions): Promise<AgentSyncDiff> {
    return this.safe(async () => {
      const options = copy(diffOptionsSchema, rawOptions ?? {});
      await this.load();
      if (!this.host) fail("host_operation_unavailable");
      const result = await this.host.diff(options);
      await this.load();
      return freezeOwned(diffSchema.parse(result));
    });
  }
  exportVersion(rawOptions: AgentSyncExportOptions): Promise<AgentSyncExportResult> {
    return this.safe(async () => {
      const options = copy(exportOptionsSchema, rawOptions);
      await this.load();
      if (!this.host) fail("host_operation_unavailable");
      const result = await this.host.exportVersion(options);
      await this.load();
      return freezeOwned(exportSchema.parse(result));
    });
  }
  close(): void {
    this.closed = true;
  }
}
