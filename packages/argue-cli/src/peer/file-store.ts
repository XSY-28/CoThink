import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PeerSessionSchema, type PeerSession, type PeerStore } from "@onevcat/argue";
import { FileSnapshotStore, type SnapshotCodec } from "../storage/snapshot-store.js";

function validateSources(next: PeerSession, current?: PeerSession): void {
  const oldSources = current?.sources ?? [];
  if (next.sources.length < oldSources.length) throw new Error("Existing peer sources cannot be removed");
  for (let index = 0; index < oldSources.length; index++) {
    if (!isDeepStrictEqual(oldSources[index], next.sources[index]))
      throw new Error("Existing peer sources cannot be changed or reordered");
  }
  if (new Set(next.sources.map((source) => source.sourceId)).size !== next.sources.length)
    throw new Error("Peer source IDs must be unique");
  if (next.sources.reduce((total, source) => total + source.content.length, 0) > next.config.limits.maxSourceCharacters)
    throw new Error("Peer source character limit exceeded");
  for (const source of next.sources) {
    const hash = `sha256:${createHash("sha256").update(source.content, "utf8").digest("hex")}`;
    if (source.contentHash !== hash || source.lineCount !== source.content.split("\n").length)
      throw new Error("Peer source content metadata does not match the copy");
  }
  const newSources = next.sources.slice(oldSources.length);
  for (const source of newSources) {
    const targetSegment = current ? next.currentSegmentId : 1;
    if (
      source.segmentId !== targetSegment ||
      (current && targetSegment <= current.currentSegmentId) ||
      !next.segments.some((segment) => segment.segmentId === targetSegment)
    )
      throw new Error("New peer sources must belong to a new current segment");
  }
}

const peerCodec: SnapshotCodec<PeerSession> = {
  formatName: "peer",
  parse: (value) => PeerSessionSchema.parse(value),
  sessionId: (state) => state.config.sessionId,
  revision: (state) => state.revision,
  validateTransition(next, current) {
    if (current && !isDeepStrictEqual(current.config, next.config)) throw new Error("Peer session config is immutable");
    validateSources(next, current);
  }
};

/** Disk-backed peer sessions. Only withWriter's callback receives mutation authority. */
export class FilePeerStore {
  private readonly snapshots: FileSnapshotStore<PeerSession>;

  constructor(root: string) {
    this.snapshots = new FileSnapshotStore(root, peerCodec);
  }

  load(sessionId: string): Promise<PeerSession> {
    return this.snapshots.load(sessionId);
  }

  withWriter<T>(sessionId: string, callback: (store: PeerStore) => Promise<T>): Promise<T> {
    return this.snapshots.withWriter(sessionId, callback);
  }
}
