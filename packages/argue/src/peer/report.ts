import {
  MEMBER_IDS,
  type PeerClaimLabel,
  type PeerResultV1,
  type PeerSession,
  type ReviewPosition
} from "./contracts.js";
import { currentSegment } from "./context.js";
import { activeClaimVersions, pendingPeerMessages } from "./protocol.js";

function label(positions: ReviewPosition[]): PeerClaimLabel {
  if (positions.length !== 2) return "incomplete_review";
  if (positions.some((p) => p.stance === "uncertain")) return "uncertain";
  if (positions.every((p) => p.stance === "accept")) return "jointly_accepted";
  if (positions.every((p) => p.stance === "reject")) return "jointly_rejected";
  return "disputed";
}
/** A deterministic arrangement of committed signed records, never a model summary. */
export function buildPeerReport(state: PeerSession): PeerResultV1 {
  const segment = currentSegment(state);
  const segmentRounds = state.rounds.filter((r) => r.segmentId === segment.segmentId);
  const claims = activeClaimVersions(state).map((version) => {
    const positions = segment.reviews
      .filter(
        (r) =>
          r.reviewSetHash === segment.reviewSetHash &&
          r.segmentId === segment.segmentId &&
          r.positions.length === segment.reviewVersions.length &&
          new Set(r.positions.map((p) => p.versionId)).size === segment.reviewVersions.length &&
          r.positions.every((p) => segment.reviewVersions.includes(p.versionId))
      )
      .flatMap((r) => {
        const position = r.positions.find((p) => p.versionId === version.versionId);
        return position ? [{ memberId: r.memberId, position }] : [];
      });
    return {
      version,
      label:
        new Set(positions.map((p) => p.memberId)).size === 2
          ? label(positions.map((p) => p.position))
          : ("incomplete_review" as const),
      positions
    };
  });
  const conclusions = MEMBER_IDS.flatMap((memberId) => {
    const latest = segmentRounds
      .slice()
      .reverse()
      .flatMap((r) => r.replies)
      .find((r) => r.memberId === memberId);
    return latest ? [{ memberId, conclusion: latest.payload.conclusion, origin: latest.payload.phase }] : [];
  });
  const initialJudgments = state.rounds
    .filter((r) => r.phase === "opening")
    .flatMap((r) =>
      r.replies.flatMap((reply) =>
        reply.payload.phase === "opening"
          ? [{ memberId: reply.memberId, conclusion: reply.payload.conclusion, claims: reply.payload.claims }]
          : []
      )
    );
  const evidenceRequests = state.rounds.flatMap((r) =>
    r.replies.flatMap((reply) =>
      reply.payload.evidenceRequests.map((e) => ({
        ...e,
        memberId: reply.memberId,
        segmentId: r.segmentId,
        phase: r.phase
      }))
    )
  );
  const usage: PeerResultV1["usage"] = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const values = state.attempts.flatMap((a) => (a.runtime?.usage[key] === undefined ? [] : [a.runtime.usage[key]!]));
    if (values.length) usage[key] = values.reduce((n, v) => n + v, 0);
  }
  return structuredClone({
    kind: "peer",
    resultVersion: "peer.v1",
    schemaVersion: 1,
    sessionId: state.config.sessionId,
    question: state.config.question,
    goal: state.config.goal,
    constraints: state.config.constraints,
    members: state.config.members,
    sources: state.sources,
    segmentId: segment.segmentId,
    status: state.status,
    ...(segment.completionReason === undefined ? {} : { completionReason: segment.completionReason }),
    reviewStatus:
      segment.completionReason === "no_active_claims"
        ? "not_called_no_active_claims"
        : segment.completionReason === "reviewed"
          ? "complete"
          : "incomplete_review",
    initialJudgments,
    conclusions,
    claims,
    claimVersions: state.claimVersions,
    messages: state.messages,
    unrespondedMessages: pendingPeerMessages(state),
    evidenceRequests,
    rounds: state.rounds,
    reviews: segment.reviews,
    attempts: state.attempts,
    usage,
    integrity: {
      revision: state.revision,
      committedRounds: state.rounds.length,
      uncommittedJobIds: state.jobs.filter((j) => j.status !== "committed").map((j) => j.jobId),
      ...(state.pauseReason === undefined ? {} : { pauseReason: state.pauseReason })
    }
  });
}
