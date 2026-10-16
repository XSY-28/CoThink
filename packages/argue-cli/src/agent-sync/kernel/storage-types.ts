import type { ManifestGitSnapshots } from "./git-snapshots.js";
/** Trusted format identity, fixed by each adapter rather than by a worker request. */
export interface StorageIdentity {
  readonly controlDirectory: ".cothink-build" | ".agent-sync";
  readonly projectIdentityVersion: string;
  readonly gitIdentityVersion: string;
  readonly formatName: string;
  readonly label: string;
  readonly commitMessage: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly commitDate: string;
  readonly refNamespace: string;
}
export interface SnapshotProject {
  readonly projectKey: string;
  readonly planHash: string;
  readonly manifest: readonly {
    readonly path: string;
    readonly access: "read-only" | "writable";
    readonly contentHash: string | null;
  }[];
}
export interface StoredFile {
  readonly path: string;
  readonly blobId: string;
  readonly contentHash: string;
}
export interface StoredRequest {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly operation: string;
  readonly status: string;
  readonly attemptId: string | null;
  readonly result: { readonly kind: string; readonly ownerEpoch?: number } | null;
}
export interface ManagedState<P extends SnapshotProject> {
  readonly projectKey: string;
  readonly runId: string;
  readonly plan: P;
  readonly revision: number;
  readonly ownerEpoch: number;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly acceptedVersion: string;
  readonly acceptedTasks: readonly string[];
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly taskId: string;
    readonly workerId: string;
    readonly token: string;
    readonly ownerEpoch: number;
    readonly leaseEpoch?: number;
    readonly baseVersion: string;
    readonly startedAt: number;
    readonly deadlineAt: number;
    readonly status: string;
    readonly inputHash: string | null;
    readonly contentHashes: Readonly<Record<string, string | null>>;
  }[];
  readonly coordination: {
    readonly lastNow: number;
    readonly nextSequence: number;
    readonly taskEpochs: Readonly<Record<string, number>>;
    readonly requests: readonly StoredRequest[];
  };
  readonly workspace?: {
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
      readonly attemptId: string;
      readonly request:
        | {
            readonly operation: "edit";
            readonly edits: readonly {
              readonly path: string;
              readonly expectedContentHash: string | null;
              readonly text: string;
            }[];
          }
        | { readonly operation: "freeze" | "inspect" | "seal" };
      readonly result:
        | { readonly kind: "frozen"; readonly baseVersion: string }
        | {
            readonly kind: "inspected";
            readonly baseVersion: string;
            readonly path: string;
            readonly text: string | null;
            readonly contentHash: string | null;
          }
        | {
            readonly kind: "edited";
            readonly baseVersion: string;
            readonly overlayHash: string;
            readonly files: readonly StoredFile[];
          }
        | { readonly kind: "sealed"; readonly baseVersion: string; readonly overlayHash: string };
    }[];
  };
  readonly checkReceipts: readonly {
    readonly receiptId: string;
    readonly attemptId: string;
    readonly version?: string;
    readonly baseVersion?: string;
    readonly planHash?: string;
    readonly candidateHash: string;
    readonly sourceHashBefore?: string;
    readonly sourceHashAfter?: string;
  }[];
  readonly publishReceipts: readonly {
    readonly attemptId: string;
    readonly checkReceiptId: string;
    readonly baseVersion: string;
    readonly acceptedVersion: string;
    readonly candidateHash: string;
  }[];
}
export interface StorageProtocol<P extends SnapshotProject, S extends ManagedState<P>> {
  readonly identity: StorageIdentity;
  readonly validateCommittedOnAccess: boolean;
  parseProject(value: unknown): P;
  parseState(value: unknown): S;
  advanceOwner(
    state: S,
    requestId: string,
    now: number
  ): { readonly state: S; readonly result: { readonly kind: string } };
  validateExtension(next: S, current: S): void;
  requestBinding(state: S, index: number): unknown;
}
export interface ManagedWriter<P extends SnapshotProject, S extends ManagedState<P>> {
  readonly projectKey: string;
  readonly controlRoot: string;
  readonly git: ManifestGitSnapshots;
  gitFor(plan: P): ManifestGitSnapshots;
  assertOwner(): Promise<void>;
  load(): Promise<S>;
  commit(expectedRevision: number, state: S): Promise<void>;
  transaction<T>(
    callback: (current: S) => Promise<{ state?: S; value: T; beforeCommit?: (latest: S) => void | Promise<void> }>
  ): Promise<T>;
}
export interface ManagedFileStoreOptions {
  workspaceRoot: string;
  projectKey: string;
  controlDirectory?: string;
  clock?: () => number;
  expectedPlanHash?: string;
  expectedRunId?: string;
}
