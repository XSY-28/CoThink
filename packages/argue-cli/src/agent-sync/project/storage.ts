import {
  advanceAgentSyncOwnerEpoch,
  AGENT_SYNC_REQUEST_VERSION,
  FrozenAgentSyncProjectSchema,
  freezeSyncValue,
  SyncIdSchema,
  SyncHashSchema,
  parseAgentSyncState,
  type AgentSyncProject,
  type AgentSyncState
} from "@onevcat/argue/agent-sync/project";
import { ManagedFileStore, createManagedSnapshotCodec } from "../kernel/file-store.js";
import type { ManagedWriter, StorageIdentity, StorageProtocol } from "../kernel/storage-types.js";
import type { SnapshotCodec } from "../../storage/snapshot-store.js";
const identity: StorageIdentity = Object.freeze({
  controlDirectory: ".agent-sync",
  projectIdentityVersion: "agent-sync-project-storage-v1",
  gitIdentityVersion: "agent-sync-git-v1",
  formatName: "agent-sync-project",
  label: "Agent sync",
  commitMessage: "Agent sync immutable snapshot\n",
  authorName: "Agent Sync",
  authorEmail: "agent-sync@localhost",
  commitDate: "2000-01-01T00:00:00Z",
  refNamespace: "agent-sync"
});
const protocol: StorageProtocol<AgentSyncProject, AgentSyncState> = Object.freeze({
  identity,
  validateCommittedOnAccess: true,
  parseProject: (value: unknown) => freezeSyncValue(FrozenAgentSyncProjectSchema.parse(value)),
  parseState: parseAgentSyncState,
  advanceOwner: (state: AgentSyncState, requestId: string, now: number) =>
    advanceAgentSyncOwnerEpoch(
      state,
      {
        requestVersion: AGENT_SYNC_REQUEST_VERSION,
        operation: "epoch",
        ownerEpoch: state.ownerEpoch,
        requestId
      },
      now
    ),
  validateExtension() {},
  requestBinding(state: AgentSyncState, index: number) {
    // Preserve the complete versioned binding; only status/result can settle.
    return Object.fromEntries(
      Object.entries(state.coordination.requests[index]!).filter(([key]) => key !== "status" && key !== "result")
    );
  }
});
export function createAgentSyncSnapshotCodec(projectKey: string): SnapshotCodec<AgentSyncState> {
  return createManagedSnapshotCodec(projectKey, protocol);
}
export type FileAgentSyncWriter = ManagedWriter<AgentSyncProject, AgentSyncState>;
export interface FileAgentSyncStoreOptions {
  workspaceRoot: string;
  projectKey: string;
  clock?: () => number;
  /** Reject a mismatched existing project before acquiring a new owner epoch. */
  expectedPlanHash?: string;
  expectedRunId?: string;
}
export class FileAgentSyncStore extends ManagedFileStore<AgentSyncProject, AgentSyncState> {
  constructor(options: FileAgentSyncStoreOptions) {
    // Optional expected identity is trusted host configuration, validated once and
    // captured by the shared backend before any directory or owner mutation.
    if (options.expectedPlanHash !== undefined) SyncHashSchema.parse(options.expectedPlanHash);
    if (options.expectedRunId !== undefined) SyncIdSchema.parse(options.expectedRunId);
    super(options, protocol);
  }
}
