import {
  BuildDriver,
  BuildIdSchema,
  FrozenBuildPlanSchema,
  freezeBuildValue,
  type BuildDriverEvent,
  type BuildModelProfile,
  type BuildPlan,
  type BuildResult,
  type BuildRunOptions,
  type ModelTransport
} from "@onevcat/argue";
import { initializeAgentSyncProject } from "../agent-sync/initialize.js";
import { FileBuildStore, type FileBuildWriter } from "./file-store.js";
import { LocalBuildSyncAdapter } from "./local-sync-adapter.js";
import { DockerVerifier } from "./validator.js";

export interface LocalBuildRuntimeOptions {
  workspaceRoot: string;
  plan: BuildPlan;
  runId: string;
  /** Required only to import the first immutable V0; never re-imported on recovery. */
  sourceRoot?: string;
  image: string;
  /** Trusted development checkout; keeps bundled local CLI toolchain resolution explicit. */
  repoRoot?: string;
  transport: ModelTransport;
  models: Readonly<Record<string, BuildModelProfile>>;
  clock?: () => number;
  onEvent?: (event: BuildDriverEvent) => void | Promise<void>;
}

/** Programmatic local composition only. No CLI parsing, credentials loading or model provider selection. */
export class LocalBuildRuntime {
  private readonly plan: BuildPlan;
  private readonly runId: string;
  private readonly store: FileBuildStore;
  private readonly clock: () => number;
  private recovered = false;
  private driver: BuildDriver | undefined;
  constructor(private readonly options: LocalBuildRuntimeOptions) {
    this.plan = freezeBuildValue(FrozenBuildPlanSchema.parse(options.plan));
    this.runId = BuildIdSchema.parse(options.runId);
    // Validate the immutable image reference before creating a managed directory.
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/.test(options.image))
      throw new Error("BUILD_IMAGE_DIGEST");
    this.clock = options.clock ?? Date.now;
    this.store = new FileBuildStore({
      workspaceRoot: options.workspaceRoot,
      projectKey: this.plan.projectKey,
      clock: this.clock
    });
  }
  private async initialize(writer: FileBuildWriter): Promise<void> {
    await initializeAgentSyncProject(writer, {
      plan: this.plan,
      runId: this.runId,
      sourceRoot: this.options.sourceRoot,
      clock: this.clock
    });
  }
  private async withDriver(
    action: (driver: BuildDriver, verifier: DockerVerifier) => Promise<BuildResult>,
    initialize = false
  ): Promise<BuildResult> {
    if (this.driver) throw new Error("Build runtime is running");
    return this.store.withWriter(async (writer) => {
      if (initialize) await this.initialize(writer);
      else {
        const state = await writer.load();
        if (state.runId !== this.runId || state.plan.planHash !== this.plan.planHash)
          throw new Error("Build runtime run/plan identity mismatch");
      }
      const verifier = new DockerVerifier(writer, { image: this.options.image, repoRoot: this.options.repoRoot });
      const adapter = new LocalBuildSyncAdapter(writer, verifier, { clock: this.clock });
      const driver = new BuildDriver({
        writer,
        ports: adapter.ports,
        transport: this.options.transport,
        models: this.options.models,
        clock: this.clock,
        onEvent: this.options.onEvent,
        expectedPlanHash: this.plan.planHash
      });
      this.driver = driver;
      try {
        return await action(driver, verifier);
      } finally {
        this.driver = undefined;
      }
    });
  }
  run(options: BuildRunOptions = {}): Promise<BuildResult> {
    return this.withDriver(async (driver, verifier) => {
      // Capability only: no source execution, no fallback to host if Docker/image is absent.
      await verifier.describe(["common"]);
      return driver.run(options);
    }, true);
  }
  async recover(options: { initialize?: boolean } = {}): Promise<BuildResult> {
    const result = await this.withDriver((driver) => driver.recover(), options.initialize ?? false);
    this.recovered = true;
    return result;
  }
  /** The first request is recovery only. A second explicit call resumes with a fresh owner/lease. */
  async retry(options: BuildRunOptions = {}): Promise<BuildResult> {
    if (!this.recovered) return this.recover();
    return this.withDriver(async (driver, verifier) => {
      await driver.recover();
      await verifier.describe(["common"]);
      return driver.retry(options);
    });
  }
  async cancel(): Promise<BuildResult> {
    if (this.driver) return this.driver.cancel();
    return this.withDriver((driver) => driver.cancel());
  }
}
