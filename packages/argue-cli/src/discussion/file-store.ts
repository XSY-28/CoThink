import {
  parseDiscussionRun,
  validateDiscussionRunTransition,
  type DiscussionRun,
  type DiscussionRunStore
} from "@onevcat/argue";
import { FileSnapshotStore } from "../storage/snapshot-store.js";

/** Runtime format integrity is independent of atomic disk mechanics and writer ownership. */
export class FileDiscussionStore {
  private readonly snapshots: FileSnapshotStore<DiscussionRun>;
  constructor(root: string) {
    this.snapshots = new FileSnapshotStore(root, {
      formatName: "discussion",
      parse: parseDiscussionRun,
      sessionId: (state) => state.sessionId,
      revision: (state) => state.revision,
      validateTransition: validateDiscussionRunTransition
    });
  }
  load(sessionId: string): Promise<DiscussionRun> {
    return this.snapshots.load(sessionId);
  }
  withWriter<T>(sessionId: string, callback: (store: DiscussionRunStore) => Promise<T>): Promise<T> {
    return this.snapshots.withWriter(sessionId, callback);
  }
}
