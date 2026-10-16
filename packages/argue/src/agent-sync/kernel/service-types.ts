import type { z } from "zod";
import type { KernelState, KernelAttempt, RequestHeader, LeaseIdentity, LeaseAllocator, StateWriter } from "./types.js";
import type { ToolResult } from "./ports.js";
export interface AgentSyncDiff {
  fromVersion: string;
  toVersion: string;
  files: readonly { path: string; beforeHash: string | null; afterHash: string | null }[];
}
export interface AgentSyncDiffOptions {
  fromVersion?: string;
  toVersion?: string;
}
export interface AgentSyncExportOptions {
  target: string;
  version?: string;
}
export interface AgentSyncExportResult {
  status: "exported";
  version: string;
  directory: string;
}
export interface AgentSyncHostOperations {
  diff(options?: AgentSyncDiffOptions): Promise<AgentSyncDiff>;
  exportVersion(options: AgentSyncExportOptions): Promise<AgentSyncExportResult>;
  recover(): Promise<void>;
}
export type Edits = readonly { path: string; text: string; expectedContentHash: string | null }[];
export type WorkspaceOperation<L> = { lease: L; requestId: string } & (
  | { operation: "freeze" | "seal" }
  | { operation: "inspect"; path: string }
  | { operation: "edit"; edits: Edits }
);
export interface ServiceState extends KernelState<
  string,
  string,
  RequestHeader & { readonly result: { readonly kind: string; readonly ownerEpoch?: number } | null }
> {
  readonly workspace?: {
    readonly toolReceipts: readonly { readonly requestId: string; readonly request: unknown }[];
    readonly candidates: readonly {
      readonly attemptId: string;
      readonly baseVersion: string;
      readonly version: string;
      readonly overlayHash: string;
      readonly candidateHash: string;
    }[];
  };
  readonly publishReceipts: readonly { readonly requestId: string; readonly requestHash?: string }[];
}
export interface ServicePorts<L, T extends ToolResult, VQ, VR, PR> {
  readonly workspace: {
    freezeInput(lease: L, requestId: string): Promise<Extract<T, { kind: "frozen" }>>;
    inspect(lease: L, requestId: string, path: string): Promise<Extract<T, { kind: "inspected" }>>;
    edit(lease: L, requestId: string, edits: Edits): Promise<Extract<T, { kind: "edited" }>>;
    seal(lease: L, requestId: string): Promise<Extract<T, { kind: "sealed" }>>;
  };
  readonly verifier: { check(request: VQ): Promise<VR> };
  readonly publisher: { finish(lease: L, requestId: string): Promise<PR> };
}
export interface ServiceOptions<M extends string, S, L, T extends ToolResult, VQ, VR, PR> {
  writer: StateWriter<S>;
  ports: ServicePorts<L, T, VQ, VR, PR>;
  expectedPlanHash: string;
  expectedRunId: string;
  expectedOwnerEpoch?: number;
  clock?: () => number;
  allocateLease?: LeaseAllocator<M>;
  host?: AgentSyncHostOperations;
}
export interface ServiceStatus<S extends ServiceState, V extends string> {
  readonly serviceVersion: V;
  readonly projectKey: string;
  readonly runId: string;
  readonly planHash: string;
  readonly acceptedVersion: string;
  readonly status: S["status"];
  readonly tasks: readonly { taskId: string; workerId: string; status: S["coordination"]["taskStates"][string] }[];
  readonly waiting: readonly { taskId: string; sequence: number }[];
}
export type ServiceRecovery<S extends ServiceState, V extends string> = ServiceStatus<S, V> & {
  readonly replayedActions: 0;
  readonly ownerEpoch: number;
};
export interface WorkerClient<L, T extends ToolResult, O, VR, PR> {
  readonly workerId: string;
  requestScope(taskId: string, requestId: string): Promise<O>;
  currentLease(taskId: string): Promise<L | null>;
  freezeInput(lease: L, requestId: string): Promise<Extract<T, { kind: "frozen" }>>;
  read(lease: L, requestId: string, path: string): Promise<Extract<T, { kind: "inspected" }>>;
  edit(lease: L, requestId: string, edits: Edits): Promise<Extract<T, { kind: "edited" }>>;
  seal(lease: L, requestId: string): Promise<Extract<T, { kind: "sealed" }>>;
  check(lease: L, requestId: string, candidate: Extract<T, { kind: "sealed" }>): Promise<VR>;
  finish(lease: L, requestId: string): Promise<PR>;
  release(lease: L, requestId: string): Promise<O>;
  cancel(taskId: string, requestId: string): Promise<O>;
}
export interface ServiceProtocol<
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
  readonly serviceVersion: V;
  readonly id: z.ZodType<string>;
  readonly hash: z.ZodType<string>;
  readonly member: z.ZodType<M>;
  readonly lease: z.ZodType<L>;
  parse(value: unknown): S;
  workspace(request: WorkspaceOperation<L>): W;
  verifier(request: { lease: L; requestId: string; candidate: Extract<T, { kind: "sealed" }> }): VQ;
  publisher(lease: L, requestId: string): void;
  leaseFor(state: S, attempt: KernelAttempt<string>): L;
  validateNow(state: S, now: number): void;
  validateLease(state: S, lease: L, now: number): { valid: true } | { valid: false; code: string };
  reserve(
    state: S,
    workerId: M,
    taskId: string,
    requestId: string,
    now: number,
    allocate: LeaseAllocator<M>
  ): { state: S; result: O };
  cancel(state: S, workerId: M, taskId: string, requestId: string, now: number): { state: S; result: O };
  release(state: S, lease: L, requestId: string, now: number): { state: S; result: O };
  advanceOwner(state: S, requestId: string, now: number): { state: S; result: O };
  epochHash(state: S, requestId: string, ownerEpoch: number): string;
  publishHash(state: S, lease: L, requestId: string): string;
  validateWorkspace(state: S, request: W, result: unknown): T;
  validateVerifier(state: S, request: VQ, result: unknown): VR;
  validatePublisher(before: S, lease: L, id: string, result: unknown, after: S): PR;
  rejected(code: string): O;
  extraRequestIds?(state: S): readonly string[];
  recoverExtension?(state: S, now: number): S;
  resources?(state: S): { maxSessionRequests: number; maxEditsPerRequest: number; maxTextBytes: number };
}
