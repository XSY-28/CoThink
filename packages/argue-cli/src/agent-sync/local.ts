import {
  AgentSyncService,
  BuildIdSchema,
  FrozenBuildPlanSchema,
  freezeBuildValue,
  type BuildLeaseAllocator,
  type BuildPlan,
  type BuildState
} from "@onevcat/argue/agent-sync";
import { FileBuildStore } from "../build/file-store.js";
import { LocalBuildSyncAdapter } from "../build/local-sync-adapter.js";
import { exportAcceptedVersion, recoverBuild } from "../build/recovery.js";
import { DockerVerifier } from "../build/validator.js";
import { initializeAgentSyncProject } from "./initialize.js";
import { LocalSession } from "./kernel/local-session.js";

export interface LocalAgentSyncOptions {
  workspaceRoot: string;
  plan: BuildPlan;
  runId: string;
  sourceRoot?: string;
  image: string;
  repoRoot?: string;
  clock?: () => number;
  allocateLease?: BuildLeaseAllocator;
}

/** One real writer lease per explicit callback; no worker loop or model configuration. */
export class LocalAgentSync {
  private readonly session: LocalSession<BuildPlan, BuildState, AgentSyncService>;

  constructor(options: LocalAgentSyncOptions) {
    const plan = freezeBuildValue(FrozenBuildPlanSchema.parse(options.plan));
    const runId = BuildIdSchema.parse(options.runId);
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/.test(options.image))
      throw new Error("BUILD_IMAGE_DIGEST");
    const captured = { ...options, plan, runId };
    const clock = options.clock ?? Date.now;
    const store = new FileBuildStore({ workspaceRoot: options.workspaceRoot, projectKey: plan.projectKey, clock });
    this.session = new LocalSession({
      store,
      project: plan,
      runId,
      initialize: (writer) => initializeAgentSyncProject(writer, { ...captured, clock }),
      service: (writer, state, diff) => {
        const verifier = new DockerVerifier(writer, { image: captured.image, repoRoot: captured.repoRoot });
        const adapter = new LocalBuildSyncAdapter(writer, verifier, { clock });
        return new AgentSyncService({
          writer,
          ports: adapter.ports,
          expectedRunId: runId,
          expectedPlanHash: plan.planHash,
          expectedOwnerEpoch: state.ownerEpoch,
          clock,
          allocateLease: captured.allocateLease,
          host: {
            recover: async () => {
              await recoverBuild(writer);
            },
            exportVersion: (input) => exportAcceptedVersion(writer, input),
            diff
          }
        });
      }
    });
  }

  withSession<T>(callback: (service: AgentSyncService) => Promise<T>): Promise<T> {
    return this.session.withSession(callback);
  }
}
