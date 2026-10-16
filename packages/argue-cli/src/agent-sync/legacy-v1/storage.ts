import {
  advanceBuildOwnerEpoch,
  FrozenBuildPlanSchema,
  freezeBuildValue,
  parseBuildState,
  type BuildPlan,
  type BuildState
} from "@onevcat/argue/agent-sync/legacy-v1";
import { isDeepStrictEqual } from "node:util";
import { ManagedFileStore, createManagedSnapshotCodec, immutable, appendOnly } from "../kernel/file-store.js";
import { ManifestGitSnapshots, type GitSnapshotsOptions } from "../kernel/git-snapshots.js";
import type { ManagedWriter, StorageIdentity, StorageProtocol } from "../kernel/storage-types.js";
import type { SnapshotCodec } from "../../storage/snapshot-store.js";
const identity: StorageIdentity = Object.freeze({
  controlDirectory: ".cothink-build",
  projectIdentityVersion: "build-project-v1",
  gitIdentityVersion: "build-git-v1",
  formatName: "build",
  label: "Build",
  commitMessage: "CoThink immutable build snapshot\n",
  authorName: "CoThink",
  authorEmail: "build@localhost",
  commitDate: "2000-01-01T00:00:00Z",
  refNamespace: "cothink"
});
const protocol: StorageProtocol<BuildPlan, BuildState> = Object.freeze({
  identity,
  validateCommittedOnAccess: false,
  parseProject: (value: unknown) => freezeBuildValue(FrozenBuildPlanSchema.parse(value)),
  parseState: parseBuildState,
  advanceOwner: (state: BuildState, requestId: string, now: number) =>
    advanceBuildOwnerEpoch(state, { ownerEpoch: state.ownerEpoch }, requestId, now),
  validateExtension(next: BuildState, current: BuildState) {
    immutable(next.calls.length >= current.calls.length, "reserved calls");
    for (let i = 0; i < current.calls.length; i++) {
      const old = current.calls[i]!;
      const item = next.calls[i]!;
      const { status: oldStatus, ...oldBudget } = old;
      const { status: nextStatus, ...nextBudget } = item;
      immutable(isDeepStrictEqual(oldBudget, nextBudget), "reserved call allocation");
      if (oldStatus !== "reserved") immutable(nextStatus === oldStatus, "settled call");
    }
    appendOnly(next.actionReceipts, current.actionReceipts, "action receipts");
  },
  requestBinding(state: BuildState, index: number) {
    const request = state.coordination.requests[index]!;
    return {
      requestId: request.requestId,
      payloadHash: request.payloadHash,
      operation: request.operation,
      attemptId: request.attemptId,
      binding: request.binding
    };
  }
});
export function createBuildSnapshotCodec(projectKey: string): SnapshotCodec<BuildState> {
  return createManagedSnapshotCodec(projectKey, protocol);
}
export type FileBuildWriter = ManagedWriter<BuildPlan, BuildState>;
export interface FileBuildStoreOptions {
  workspaceRoot: string;
  projectKey: string;
  controlDirectory?: string;
  clock?: () => number;
}
export class FileBuildStore extends ManagedFileStore<BuildPlan, BuildState> {
  constructor(options: FileBuildStoreOptions) {
    super(options, protocol);
  }
}
/** Legacy constructor validates the unchanged complete frozen Build plan. */
export class GitSnapshots extends ManifestGitSnapshots {
  constructor(
    controlRoot: string,
    plan: BuildPlan,
    assertOwner: () => Promise<void>,
    options: GitSnapshotsOptions = {}
  ) {
    super(controlRoot, protocol.parseProject(plan), assertOwner, identity, options);
  }
}
export type { GitSnapshotEdit, GitSnapshotFile, GitSnapshotsOptions } from "../kernel/git-snapshots.js";
