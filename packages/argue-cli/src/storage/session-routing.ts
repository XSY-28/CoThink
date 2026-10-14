import { identifyStoredSession, type StoredSessionIdentity } from "@onevcat/argue";
import { FileSnapshotStore } from "./snapshot-store.js";

/** Read-only format gate. A discussion header is never an executable state validator. */
export function loadStoredSessionIdentity(root: string, sessionId: string): Promise<StoredSessionIdentity> {
  const snapshots = new FileSnapshotStore<StoredSessionIdentity>(root, {
    formatName: "session",
    parse: identifyStoredSession,
    sessionId: (state) => state.sessionId,
    revision: (state) => state.revision,
    validateTransition: () => {
      throw new Error("Session format routing is read-only");
    }
  });
  return snapshots.load(sessionId);
}
