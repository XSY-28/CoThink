import { DiscussionSessionHeaderSchema, type DiscussionSessionHeader } from "./discussion/index.js";
import { PeerSessionSchema, type PeerSession } from "./peer/contracts.js";

export type StoredSessionIdentity =
  | { kind: "peer"; sessionId: string; revision: number; state: PeerSession }
  | { kind: "discussion"; sessionId: string; revision: number; header: DiscussionSessionHeader };

/** Never infer a format from a prompt alone or fall back after a version error. */
export function identifyStoredSession(raw: unknown): StoredSessionIdentity {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid session snapshot");
  if ("schemaVersion" in raw) {
    if (raw.schemaVersion !== 2) throw new Error(`Unsupported session schemaVersion: ${String(raw.schemaVersion)}`);
    // Legacy config and top-level version markers must never coexist.
    if ("config" in raw) throw new Error("Ambiguous session format: discussion header with legacy config");
    const parsed = DiscussionSessionHeaderSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid discussion version header");
    return {
      kind: "discussion",
      sessionId: parsed.data.sessionId,
      revision: parsed.data.revision,
      header: parsed.data
    };
  }
  if (!("config" in raw) || raw.config === null || typeof raw.config !== "object" || Array.isArray(raw.config))
    throw new Error("Missing session schemaVersion");
  if (!("schemaVersion" in raw.config) || raw.config.schemaVersion !== 1)
    throw new Error("Unsupported peer session schemaVersion");
  const parsed = PeerSessionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid peer session snapshot or promptVersion");
  return { kind: "peer", sessionId: parsed.data.config.sessionId, revision: parsed.data.revision, state: parsed.data };
}
