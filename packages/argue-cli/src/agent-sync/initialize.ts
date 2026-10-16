import {
  createBuildState,
  FrozenBuildPlanSchema,
  freezeBuildValue,
  BuildIdSchema,
  type BuildPlan
} from "@onevcat/argue/agent-sync";
import type { FileBuildWriter } from "../build/file-store.js";
import { initializeManagedProject } from "./kernel/initialize.js";

export interface InitializeAgentSyncProjectOptions {
  plan: BuildPlan;
  runId: string;
  sourceRoot?: string;
  clock?: () => number;
}

/** Strict legacy format wrapper; opening existing runs never reimports source. */
export async function initializeAgentSyncProject(
  writer: FileBuildWriter,
  options: InitializeAgentSyncProjectOptions
): Promise<void> {
  const plan = freezeBuildValue(FrozenBuildPlanSchema.parse(options.plan));
  const runId = BuildIdSchema.parse(options.runId);
  return initializeManagedProject(
    writer,
    { project: plan, runId, sourceRoot: options.sourceRoot, clock: options.clock ?? Date.now },
    {
      missingMessage: `Build session does not exist: ${plan.projectKey}`,
      identityMessage: "Build runtime run/plan identity mismatch",
      sourceMessage: "Build source is required for initial import",
      createState: (version, now) =>
        createBuildState({
          buildSchemaVersion: 1,
          planVersion: "build-plan-v1",
          actionVersion: "build-action-v1",
          budgetVersion: "build-budget-v1",
          checkVersion: "build-check-v1",
          publishVersion: "build-publish-v1",
          resultVersion: "build-result-v1",
          projectKey: plan.projectKey,
          runId: runId,
          revision: 0,
          ownerEpoch: 1,
          plan: plan,
          acceptedVersion: version,
          status: "active",
          startedAt: now,
          deadlineAt: now + plan.budget.runTimeoutMs,
          acceptedTasks: [],
          waiting: [],
          attempts: [],
          calls: [],
          actionReceipts: [],
          checkReceipts: [],
          publishReceipts: []
        })
    }
  );
}
