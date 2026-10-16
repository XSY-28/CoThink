import type { ManagedState, ManagedWriter, SnapshotProject } from "./storage-types.js";

/** One import/commit lifecycle. Format parsing and state construction belong to fixed adapters. */
export async function initializeManagedProject<P extends SnapshotProject, S extends ManagedState<P>>(
  writer: ManagedWriter<P, S>,
  options: { project: P; runId: string; sourceRoot?: string; clock: () => number },
  format: {
    missingMessage: string;
    identityMessage: string;
    sourceMessage: string;
    createState: (version: string, now: number) => S;
  }
): Promise<void> {
  try {
    const state = await writer.load();
    if (state.runId !== options.runId || state.plan.planHash !== options.project.planHash)
      throw new Error(format.identityMessage);
    return;
  } catch (error) {
    if (!(error instanceof Error && error.message === format.missingMessage)) throw error;
  }
  if (!options.sourceRoot) throw new Error(format.sourceMessage);
  const now = options.clock();
  const git = writer.gitFor(options.project);
  await git.initialize();
  const version = await git.importSource(options.sourceRoot);
  await writer.commit(-1, format.createState(version, now));
}
