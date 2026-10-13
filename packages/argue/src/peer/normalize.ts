import { PeerTurnSchema, type PeerTurn } from "./contracts.js";

const EMPTY_METADATA_ARRAYS = new Set(["assumptions", "sourceRefs", "evidenceRequests"]);
const normalizedKey = (key: string) => key.replace(/[-_\s]/g, "").toLowerCase();
/** Misplaced protocol fields are errors, not disposable commentary. */
const RESERVED_FIELDS = new Set(
  [
    "phase",
    "conclusion",
    "evidenceRequests",
    "claims",
    "actions",
    "readyToReview",
    "reviewSetHash",
    "positions",
    "statement",
    "rationale",
    "assumptions",
    "sourceRefs",
    "alternativeToVersionId",
    "kind",
    "targetVersionId",
    "targetMessageId",
    "target",
    "replyTo",
    "request",
    "versionId",
    "messageId",
    "stance",
    "sourceId",
    "startLine",
    "endLine",
    "memberId",
    "authorId",
    "recipientId",
    "peerAccepted",
    "consensus",
    "acceptedBy",
    "claimId",
    "previousVersionId",
    "version",
    "withdrawn",
    "withdrawalReason",
    "respondedBy",
    "jobId",
    "attemptId",
    "snapshotId",
    "sharedSnapshotId",
    "inputHash",
    "sessionId",
    "segmentId",
    "roundIndex",
    "modelId",
    "protocol",
    "role"
  ].map(normalizedKey)
);

/**
 * Tolerate only schema-identified cosmetic defects at the model boundary.
 * Persisted schemas stay strict, raw responses stay untouched, and all protocol
 * semantics are validated by the caller against the same frozen peer snapshot.
 */
export function normalizePeerTurn(raw: unknown): PeerTurn {
  const result = PeerTurnSchema.safeParse(raw);
  if (result.success) return result.data;
  const cosmeticOnly = result.error.issues.every((issue) => {
    if (issue.code === "unrecognized_keys") return issue.keys.every((key) => !RESERVED_FIELDS.has(normalizedKey(key)));
    return (
      issue.code === "invalid_type" &&
      issue.expected === "array" &&
      issue.received === "undefined" &&
      EMPTY_METADATA_ARRAYS.has(String(issue.path.at(-1)))
    );
  });
  if (!cosmeticOnly) throw result.error;

  const normalized = structuredClone(raw);
  for (const issue of result.error.issues) {
    const path = issue.code === "unrecognized_keys" ? issue.path : issue.path.slice(0, -1);
    // Zod has already verified that each issue's parent is a schema object.
    let parent = normalized as Record<string | number, unknown>;
    for (const key of path) parent = parent[key] as Record<string | number, unknown>;
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) delete parent[key];
    } else {
      parent[String(issue.path.at(-1))] = [];
    }
  }
  return PeerTurnSchema.parse(normalized);
}
