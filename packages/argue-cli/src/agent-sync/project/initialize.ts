import {
  FrozenAgentSyncProjectSchema,
  freezeSyncValue,
  SyncIdSchema,
  createAgentSyncState,
  type AgentSyncProject
} from "@onevcat/argue/agent-sync/project";
import { freezeTrustedCheckConfig, validateProjectChecks, type TrustedCheckConfig } from "../checks/config.js";
import { initializeManagedProject } from "../kernel/initialize.js";
import type { FileAgentSyncWriter } from "./storage.js";

export interface InitializeAgentSyncProjectOptions {
  project: AgentSyncProject;
  runId: string;
  sourceRoot?: string;
  clock?: () => number;
  config: TrustedCheckConfig;
}

/** Trusted building block for an already acquired writer; validates before initializer I/O. */
export function initializeAgentSyncProject(
  writer: FileAgentSyncWriter,
  options: InitializeAgentSyncProjectOptions
): Promise<void> {
  const project = freezeSyncValue(FrozenAgentSyncProjectSchema.parse(options.project));
  const runId = SyncIdSchema.parse(options.runId);
  const config = freezeTrustedCheckConfig(options.config);
  validateProjectChecks(config, project);
  return initializeManagedProject(
    writer,
    { project, runId, sourceRoot: options.sourceRoot, clock: options.clock ?? Date.now },
    {
      missingMessage: `Agent-sync-project session does not exist: ${project.projectKey}`,
      identityMessage: "Agent sync runtime run/plan identity mismatch",
      sourceMessage: "Agent sync source is required for initial import",
      createState: (version, now) => createAgentSyncState({ project, runId, acceptedVersion: version, now })
    }
  );
}
