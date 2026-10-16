import { hashJson } from "@onevcat/argue/agent-sync/project";
import type { GitSnapshotFile, ManifestGitSnapshots } from "./git-snapshots.js";
import type { ManagedState, SnapshotProject } from "./storage-types.js";

/** Formal publication is an ordered accepted chain of completed tasks. */
export function validateCommittedMetadata(state: ManagedState<SnapshotProject>): void {
  let previous: string | undefined;
  for (const receipt of state.publishReceipts) {
    const attempt = state.attempts.find((a) => a.attemptId === receipt.attemptId);
    if (!attempt || attempt.status !== "completed" || !state.acceptedTasks.includes(attempt.taskId))
      throw new Error("Build publication does not reference an accepted completed task");
    if (previous !== undefined && receipt.baseVersion !== previous)
      throw new Error("Build publication history has a disconnected accepted version");
    previous = receipt.acceptedVersion;
  }
  if (previous !== undefined && previous !== state.acceptedVersion)
    throw new Error("Build accepted version differs from committed publication history");
}

/** Shared physical proof for storage, recovery and export. Fresh per-operation views only.
 * Legacy callers must explicitly opt into missing-version check receipts. */
export async function validateCommittedAssets(
  git: Pick<ManifestGitSnapshots, "readFiles">,
  state: ManagedState<SnapshotProject>,
  options: { readonly allowLegacyChecks: boolean }
): Promise<void> {
  validateCommittedMetadata(state);
  const views = new Map<string, Promise<Readonly<Record<string, GitSnapshotFile>>>>();
  const view = (version: string) => {
    let pending = views.get(version);
    if (!pending) {
      pending = git.readFiles(version);
      views.set(version, pending);
    }
    return pending;
  };
  const records = (files: Readonly<Record<string, GitSnapshotFile>>) =>
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, file]) => ({ path, contentHash: file.contentHash }));
  for (const check of state.checkReceipts) {
    if (check.version !== undefined) {
      if (check.baseVersion === undefined || check.planHash !== state.plan.planHash)
        throw new Error("Build recorded check plan/base binding mismatch");
      await view(check.baseVersion);
      const files = records(await view(check.version));
      if (check.candidateHash !== hashJson({ baseVersion: check.baseVersion, files }))
        throw new Error("Build recorded check candidate content hash mismatch");
      const actual = hashJson(files);
      if (check.sourceHashBefore !== actual || check.sourceHashAfter !== actual)
        throw new Error("Build recorded check source content hash mismatch");
    } else if (!options.allowLegacyChecks) {
      throw new Error("Agent sync check requires an immutable version");
    } else if (
      !state.publishReceipts.some((r) => r.checkReceiptId === check.receiptId) &&
      !state.workspace?.candidates.some(
        (c) => c.attemptId === check.attemptId && c.candidateHash === check.candidateHash
      )
    ) {
      throw new Error("Build legacy check references an unknown candidate");
    }
  }
  for (const receipt of state.publishReceipts) {
    await view(receipt.baseVersion);
    const files = records(await view(receipt.acceptedVersion));
    if (hashJson({ baseVersion: receipt.baseVersion, files }) !== receipt.candidateHash)
      throw new Error("Build published candidate content hash mismatch");
  }
}
