import { freezeSyncValue } from "@onevcat/argue/agent-sync/project";
/** Freeze an already parsed generic value without erasing its specific protocol type. */
export const freeze = <T>(value: T): T => freezeSyncValue(value) as T;
import type { SnapshotProject, ManagedState, StoredFile } from "./storage-types.js";
import type { ToolResult } from "@onevcat/argue/agent-sync/project";
export type { ToolResult };
export interface BackendProject extends SnapshotProject {
  readonly tasks: readonly {
    readonly taskId: string;
    readonly scope: { readonly read: readonly string[]; readonly write: readonly string[] };
  }[];
}
export interface BackendLease {
  readonly attemptId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly ownerEpoch: number;
  readonly leaseEpoch: number;
}
export type WorkspaceRequest<L> = { readonly requestId: string; readonly lease: L } & (
  | { readonly operation: "freeze" | "seal" }
  | { readonly operation: "inspect"; readonly path: string }
  | {
      readonly operation: "edit";
      readonly edits: readonly {
        readonly path: string;
        readonly text: string;
        readonly expectedContentHash: string | null;
      }[];
    }
);
export interface CheckReceipt<G extends string> {
  readonly receiptId: string;
  readonly attemptId: string;
  readonly passed: boolean;
  readonly baseVersion?: string;
  readonly version?: string;
  readonly planHash?: string;
  readonly candidateHash: string;
  readonly checksHash: string;
  readonly groups: readonly G[];
  readonly toolchainHash?: string;
  readonly isolationHash?: string;
  readonly imageDigest?: string;
  readonly configurationHash?: string;
  readonly programsHash?: string;
  readonly argumentsHash?: string;
  readonly sourceHashBefore?: string;
  readonly sourceHashAfter?: string;
}
export interface PublishReceipt {
  readonly receiptId: string;
  readonly requestId: string;
  readonly requestHash?: string;
  readonly attemptId: string;
  readonly checkReceiptId: string;
  readonly baseVersion: string;
  readonly acceptedVersion: string;
  readonly candidateHash: string;
}
export interface BackendState<
  P extends BackendProject,
  L,
  C extends CheckReceipt<string>,
  R extends PublishReceipt,
  T extends ToolResult
> extends ManagedState<P> {
  readonly coordination: ManagedState<P>["coordination"] & {
    readonly taskStates: Readonly<Record<string, string>>;
    readonly locks: readonly { readonly attemptId: string }[];
  };
  readonly workspace?: {
    readonly workspaceVersion: string;
    readonly staging: readonly {
      readonly attemptId: string;
      readonly baseVersion: string;
      readonly files: readonly StoredFile[];
      readonly overlayHash: string;
    }[];
    readonly candidates: readonly {
      readonly attemptId: string;
      readonly baseVersion: string;
      readonly version: string;
      readonly candidateHash: string;
      readonly overlayHash: string;
    }[];
    readonly toolReceipts: readonly {
      readonly requestId: string;
      readonly attemptId: string;
      readonly requestHash: string;
      readonly request: WorkspaceRequest<L>;
      readonly result: T;
    }[];
  };
  readonly checkReceipts: readonly C[];
  readonly publishReceipts: readonly R[];
}
export interface BackendProtocol<
  P extends BackendProject,
  L extends BackendLease,
  C extends CheckReceipt<G>,
  R extends PublishReceipt,
  T extends ToolResult,
  S extends BackendState<P, L, C, R, T>,
  G extends string
> {
  readonly workspaceVersion: string;
  readonly toolMetadata: Readonly<Record<string, string>>;
  readonly candidateMetadata: Readonly<Record<string, string>>;
  readonly publishVersion: string;
  readonly evidenceKeys: readonly (
    | "toolchainHash"
    | "isolationHash"
    | "imageDigest"
    | "configurationHash"
    | "programsHash"
    | "argumentsHash"
  )[];
  readonly allowLegacyChecks: boolean;
  parseState(raw: unknown): S;
  parseLease(raw: unknown): L;
  parseId(raw: unknown): string;
  workspace(raw: WorkspaceRequest<L>): WorkspaceRequest<L>;
  tool(raw: unknown): T;
  parseCheck(raw: unknown): C;
  parsePublish(raw: unknown): R;
  validateLease(state: S, lease: L, now: number): { valid: true } | { valid: false; code: string };
  expire(state: S, now: number): S;
  bind(
    state: S,
    lease: L,
    id: string,
    input: { baseVersion: string; inputHash: string; contentHashes: Record<string, string | null> },
    now: number
  ): { state: S; result: { kind: string } };
  groups(state: S, taskId: string): readonly G[];
  publishHash(state: S, lease: L, id: string, target?: string): string;
  extraRequestIds(state: S): readonly string[];
  validateResources(state: S, request: WorkspaceRequest<L>): void;
  configurationHash(state: S): string | undefined;
  verifierRequest(raw: unknown): VerifierRequest<L, T>;
  validateVerifier(
    state: S,
    request: VerifierRequest<L, T>,
    response: unknown
  ): { readonly requestId: string; readonly receipt: C };
  validatePublisher(
    before: S,
    lease: L,
    id: string,
    response: unknown,
    after: S
  ): { readonly status: "accepted"; readonly receipt: R; readonly export?: unknown };
}
export type VerifierRequest<L, T extends ToolResult> = {
  readonly requestId: string;
  readonly lease: L;
  readonly candidate: Extract<T, { kind: "sealed" }>;
};
