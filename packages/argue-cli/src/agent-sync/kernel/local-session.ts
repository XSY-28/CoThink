import { AgentSyncError, type AgentSyncDiff, type AgentSyncDiffOptions } from "@onevcat/argue/agent-sync/project";
import type { ManagedState, ManagedWriter, SnapshotProject } from "./storage-types.js";

/** Internal composition seam; public format wrappers never accept replacement backends. */
export class LocalSession<P extends SnapshotProject, S extends ManagedState<P>, Service extends { close(): void }> {
  private active = false;
  constructor(
    private readonly format: {
      store: { withWriter<T>(callback: (writer: ManagedWriter<P, S>) => Promise<T>): Promise<T> };
      project: P;
      runId: string;
      preflight?: () => Promise<void>;
      initialize: (writer: ManagedWriter<P, S>) => Promise<void>;
      service: (
        writer: ManagedWriter<P, S>,
        state: S,
        diff: (options?: AgentSyncDiffOptions) => Promise<AgentSyncDiff>
      ) => Service;
    }
  ) {}

  async withSession<T>(callback: (service: Service) => Promise<T>): Promise<T> {
    if (this.active) throw new AgentSyncError("session_active");
    this.active = true;
    try {
      await this.format.preflight?.();
      return await this.format.store.withWriter(async (writer) => {
        await this.format.initialize(writer);
        const state = await writer.load();
        this.identity(state, state.ownerEpoch);
        const service = this.format.service(writer, state, (options) => this.diff(writer, options));
        try {
          return await callback(service);
        } finally {
          service.close();
        }
      });
    } finally {
      this.active = false;
    }
  }

  private identity(state: S, ownerEpoch: number): void {
    if (state.runId !== this.format.runId) throw new AgentSyncError("run_id_mismatch");
    if (state.plan.planHash !== this.format.project.planHash) throw new AgentSyncError("plan_hash_mismatch");
    if (state.ownerEpoch !== ownerEpoch) throw new AgentSyncError("owner_epoch_mismatch");
  }

  private async diff(writer: ManagedWriter<P, S>, options: AgentSyncDiffOptions = {}): Promise<AgentSyncDiff> {
    // The service guards its captured owner before/after this host hook, including an
    // explicitly authorized recovery. This hook also rejects owner shifts during I/O.
    const state = await writer.load();
    this.identity(state, state.ownerEpoch);
    const base = state.publishReceipts[0]?.baseVersion ?? state.acceptedVersion;
    const fromVersion = options.fromVersion ?? base;
    const toVersion = options.toVersion ?? state.acceptedVersion;
    const accepted = new Set([base, state.acceptedVersion, ...state.publishReceipts.map((r) => r.acceptedVersion)]);
    if (!accepted.has(fromVersion) || !accepted.has(toVersion)) throw new AgentSyncError("version_not_accepted");
    const [before, after] = await Promise.all([writer.git.readFiles(fromVersion), writer.git.readFiles(toVersion)]);
    const files = [...state.plan.manifest]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(({ path }) => ({ path, beforeHash: before[path]!.contentHash, afterHash: after[path]!.contentHash }))
      .filter((file) => file.beforeHash !== file.afterHash);
    await writer.assertOwner();
    this.identity(await writer.load(), state.ownerEpoch);
    return { fromVersion, toVersion, files };
  }
}
