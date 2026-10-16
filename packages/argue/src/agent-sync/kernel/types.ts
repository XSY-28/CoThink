export type SyncMutable<T> = T extends readonly (infer U)[]
  ? SyncMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: SyncMutable<T[K]> }
    : T;
/** The only assertion removes readonly after an owned deep clone; it never changes a protocol. */
export function cloneMutable<T>(value: T): SyncMutable<T> {
  return structuredClone(value) as SyncMutable<T>;
}
export type ControlOperation = "reserve" | "release" | "revoke" | "epoch" | "bind" | "cancel";
export type AttemptStatus = "running" | "checking" | "publishing" | "completed" | "paused" | "cancelled";
export type SharedTaskStatus = AttemptStatus | "waiting";
export type RequestStatus = "pending" | "succeeded" | "invalidated";
export interface LeaseIdentity<M extends string = string> {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: M;
  readonly ownerEpoch: number;
  readonly leaseEpoch: number;
  readonly token: string;
}
export interface ProjectIdentity {
  readonly projectKey: string;
  readonly runId: string;
  readonly plan: { readonly planHash: string };
}
export interface KernelTask<M extends string> {
  readonly taskId: string;
  readonly workerId: M;
  readonly scope: { readonly read: readonly string[]; readonly write: readonly string[] };
  readonly dependsOn: readonly string[];
}
export interface KernelAttempt<M extends string> {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: M;
  readonly ownerEpoch: number;
  readonly leaseEpoch?: number;
  readonly token: string;
  readonly baseVersion: string;
  readonly inputHash: string | null;
  readonly contentHashes: Readonly<Record<string, string | null>>;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly status: AttemptStatus;
}
export type MutableKernelAttempt<M extends string> = { -readonly [K in keyof KernelAttempt<M>]: KernelAttempt<M>[K] };
export interface RequestHeader {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly operation: string;
  readonly status: RequestStatus;
  readonly attemptId: string | null;
}
export interface LockRange {
  readonly path: string;
  readonly mode: "R" | "W";
}
export interface Lock extends LockRange {
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseEpoch: number;
}
export type WaitReason =
  | { readonly kind: "dependency"; readonly taskIds: readonly string[] }
  | { readonly kind: "queue"; readonly taskIds: readonly string[] }
  | { readonly kind: "worker"; readonly attemptIds: readonly string[] }
  | { readonly kind: "lock"; readonly paths: readonly string[]; readonly attemptIds: readonly string[] };
export type ControlResult<L extends LeaseIdentity> =
  | { readonly kind: "granted"; readonly lease: L }
  | { readonly kind: "waiting"; readonly taskId: string; readonly reasons: readonly WaitReason[] }
  | { readonly kind: "released"; readonly attemptId: string }
  | { readonly kind: "revoked"; readonly attemptId: string }
  | { readonly kind: "bound"; readonly attemptId: string }
  | { readonly kind: "cancelled"; readonly taskId: string }
  | { readonly kind: "epoch_advanced"; readonly ownerEpoch: number };
export interface KernelState<M extends string, I extends string, Q extends RequestHeader> extends ProjectIdentity {
  readonly revision: number;
  readonly ownerEpoch: number;
  readonly acceptedVersion: string;
  readonly status: "active" | "paused" | "completed" | "cancelled";
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly plan: {
    readonly planHash: string;
    readonly memberIds: readonly M[];
    readonly tasks: readonly KernelTask<M>[];
  };
  readonly acceptedTasks: readonly string[];
  readonly waiting: readonly { taskId: string; sequence: number }[];
  readonly attempts: readonly KernelAttempt<M>[];
  readonly coordination: {
    readonly lastNow: number;
    readonly nextSequence: number;
    readonly taskEpochs: Readonly<Record<string, number>>;
    readonly taskStates: Readonly<Record<string, I | SharedTaskStatus>>;
    readonly locks: readonly Lock[];
    readonly requests: readonly Q[];
  };
}
/** A writable view onto the same full clone, never a projected replacement state. */
export interface KernelDraft<M extends string, I extends string, Q extends RequestHeader> extends KernelState<M, I, Q> {
  revision: number;
  ownerEpoch: number;
  status: "active" | "paused" | "completed" | "cancelled";
  waiting: { taskId: string; sequence: number }[];
  attempts: MutableKernelAttempt<M>[];
  coordination: {
    lastNow: number;
    nextSequence: number;
    taskEpochs: Record<string, number>;
    taskStates: Record<string, I | SharedTaskStatus>;
    locks: Lock[];
    requests: Q[];
  };
}
export type LeaseAllocator<M extends string> = (
  context: Readonly<{ taskId: string; workerId: M; ownerEpoch: number; leaseEpoch: number; baseVersion: string }>
) => { attemptId: string; token: string };
export type OperationResult<L extends LeaseIdentity, R> =
  | ControlResult<L>
  | { readonly kind: "rejected"; readonly code: string }
  | { readonly kind: "replayed"; readonly receipt: R }
  | { readonly kind: "expired"; readonly attemptIds: readonly string[] };
export type Transition<S, L extends LeaseIdentity, R> = { readonly state: S; readonly result: OperationResult<L, R> };
export type Schedule<S, L extends LeaseIdentity> = {
  readonly state: S;
  readonly grants: readonly L[];
  readonly waiting: readonly { readonly taskId: string; readonly reasons: readonly WaitReason[] }[];
  readonly rejected?: string;
};
export interface Snapshot {
  readonly baseVersion: string;
  readonly inputHash: string;
  readonly contentHashes: Readonly<Record<string, string | null>>;
}
export type ParsedControl<L extends LeaseIdentity, M extends string> = {
  readonly requestId: string;
  readonly hashPayload: unknown;
} & (
  | { operation: "reserve"; ownerEpoch: number; taskId: string; workerId: M }
  | { operation: "cancel"; ownerEpoch: number; taskId: string; workerId: M }
  | { operation: "epoch"; ownerEpoch: number }
  | { operation: "release"; lease: L }
  | { operation: "revoke"; lease: L }
  | { operation: "bind"; lease: L; snapshot: Snapshot }
);
export interface RecordView<L extends LeaseIdentity, R> {
  readonly hasResult: boolean;
  readonly control: ControlResult<L> | null;
  readonly replay: R | null;
  readonly allowsPending: boolean;
}
export interface SuccessfulControl<L extends LeaseIdentity> {
  requestId: string;
  payloadHash: string;
  operation: ControlOperation;
  attemptId: string | null;
  result: ControlResult<L>;
}
export interface KernelProtocol<
  M extends string,
  I extends string,
  Q extends RequestHeader,
  L extends LeaseIdentity<M>,
  S extends KernelState<M, I, Q>,
  R
> {
  parseShape(value: unknown): S;
  validateExtension(state: S): void;
  draft(state: S): SyncMutable<S>;
  core(value: SyncMutable<S>): KernelDraft<M, I, Q>;
  parseLease(value: unknown): L;
  leaseFor(state: ProjectIdentity, attempt: KernelAttempt<M>): L;
  parseControl(value: unknown): ParsedControl<L, M>;
  encodeControl(record: SuccessfulControl<L>): Q;
  inspectRecord(record: Q): RecordView<L, R>;
  taskTimeoutMs(state: SyncMutable<S>): number;
}
export interface StateWriter<S> {
  load(): Promise<S>;
  commit(expectedRevision: number, state: S): Promise<void>;
  transaction<T>(
    operation: (current: S) => Promise<{ state?: S; value: T; beforeCommit?: (latest: S) => void | Promise<void> }>
  ): Promise<T>;
}
