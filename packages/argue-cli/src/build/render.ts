import { buildResult, type BuildResult, type BuildState } from "@onevcat/argue";
import type { GitSnapshotFile } from "./git-snapshots.js";
import type { BuildIntegrationRequest, BuildIntegrationResult } from "./discussion-link.js";

export interface PublicBuildResult extends BuildResult {
  requestId: string;
  recoveryRequired: boolean;
  workspace: { directory: string; files: { path: string; contentHash: string | null }[] };
  diff: {
    baseVersion: string;
    version: string;
    files: { path: string; beforeHash: string | null; afterHash: string | null }[];
  };
  error?: string;
  export?: { status: "exported"; version: string; directory: string };
  cancellationRequested?: boolean;
  cancellation?: "requested" | "revoked" | "already_completed";
  integrationResult?: BuildIntegrationResult;
  origin?: BuildIntegrationRequest["origin"];
}

/** Only program-owned reasons and immutable file hashes enter this public projection. */
export function publicBuildResult(input: {
  state: BuildState;
  result?: BuildResult;
  requestId: string;
  directory: string;
  recoveryRequired: boolean;
  files: Readonly<Record<string, GitSnapshotFile>>;
  baseline: Readonly<Record<string, GitSnapshotFile>>;
  baseVersion: string;
}): PublicBuildResult {
  const result = input.result ?? buildResult(input.state);
  const allowedReasons = new Set([
    "worker_aborted",
    "budget_exhausted",
    "deadline_exceeded",
    "request_rejected",
    "recovery_required"
  ]);
  const tasks = result.tasks.map((task) => ({
    taskId: task.taskId,
    status: task.status,
    reason: allowedReasons.has(task.reason) ? task.reason : task.status
  }));
  return {
    resultVersion: result.resultVersion,
    runId: result.runId,
    planHash: result.planHash,
    status: result.status,
    acceptedVersion: result.acceptedVersion,
    tasks,
    budget: { ...result.budget },
    recovery: buildResult(input.state).recovery,
    requestId: input.requestId,
    recoveryRequired: input.recoveryRequired,
    workspace: {
      directory: input.directory,
      files: Object.entries(input.files).map(([path, file]) => ({ path, contentHash: file.contentHash }))
    },
    diff: {
      baseVersion: input.baseVersion,
      version: result.acceptedVersion,
      files: Object.entries(input.files).flatMap(([path, file]) =>
        file.contentHash === input.baseline[path]?.contentHash
          ? []
          : [{ path, beforeHash: input.baseline[path]?.contentHash ?? null, afterHash: file.contentHash }]
      )
    }
  };
}

export function renderBuildResult(result: PublicBuildResult): string {
  return [
    `Build ${result.runId}: ${result.status}`,
    `Official version: ${result.acceptedVersion}`,
    `Workspace: ${result.workspace.directory}`,
    `Diff: ${result.diff.files.length} changed file(s) from ${result.diff.baseVersion}`,
    ...result.tasks.map((task) => `${task.taskId}: ${task.status} (${task.reason})`),
    `Calls: ${result.budget.calls}/${result.budget.maxCalls}; allocated output: ${result.budget.allocatedOutputTokens}/${result.budget.maxAllocatedOutputTokens}`,
    ...(result.error ? [result.error] : []),
    ...(result.export ? [`Exported ${result.export.version}: ${result.export.directory}`] : []),
    ...(result.cancellation
      ? [
          result.cancellation === "requested"
            ? "Cancellation requested; waiting for the active host to confirm revocation."
            : result.cancellation === "revoked"
              ? "Cancellation completed; active authority is revoked."
              : "Build already completed; no active work remains."
        ]
      : []),
    result.recovery
  ].join("\n");
}
