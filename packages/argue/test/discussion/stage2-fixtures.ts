import {
  createDiscussionSession,
  applyDiscussionBatch,
  freezeDiscussionReview
} from "../../src/discussion/protocol.js";
import { discussionSnapshotId } from "../../src/discussion/context.js";
import { latestDiscussionAnswers, activeDiscussionClaims } from "../../src/discussion/answers.js";
import type {
  DiscussionSession,
  DiscussionReply,
  DiscussionAction,
  DiscussionProtocolTurn
} from "../../src/discussion/contracts.js";
export function stage2Session(memberIds: readonly string[] = ["a", "b"]): DiscussionSession {
  return createDiscussionSession({
    sessionId: "discussion-test",
    question: "Which proposal?",
    memberIds,
    policy: { effort: "standard" },
    constraints: ["Local only"],
    sources: [{ sourceId: "source-1", content: "Proposal A\nA caveat" }]
  });
}
export function openingTurn(): Extract<DiscussionProtocolTurn, { phase: "opening" }> {
  return {
    phase: "opening",
    claims: [{ statement: "A claim", rationale: "An independent reason", assumptions: [], sourceRefs: [] }],
    answer: { body: "An independent answer", basisDraftIndices: [0], limitations: [], unresolvedObjectionIds: [] },
    complexity: "moderate",
    complexityRationale: "Needs discussion",
    evidenceRequests: []
  };
}
export function exchangeTurn(
  state: DiscussionSession,
  memberId: string,
  actions: readonly DiscussionAction[] = []
): Extract<DiscussionProtocolTurn, { phase: "discussion" }> {
  return {
    phase: "discussion",
    actions,
    answer: {
      previousVersionId: latestDiscussionAnswers(state).find((item) => item.authorId === memberId)!.answerVersionId,
      body: `Answer ${memberId} at round ${state.roundIndex}`,
      basisVersionIds: activeDiscussionClaims(state).map((item) => item.versionId),
      limitations: [],
      unresolvedObjectionIds: []
    },
    readyToReview: true,
    evidenceRequests: []
  };
}
export function reviewTurn(
  state: DiscussionSession,
  memberId: string
): Extract<DiscussionProtocolTurn, { phase: "review" }> {
  const epoch = state.reviewEpochs.at(-1)!;
  return {
    phase: "review",
    reviewSetHash: epoch.reviewSetHash,
    positions: [
      ...epoch.claimVersions.map((item) => ({
        kind: "claim" as const,
        versionId: item.versionId,
        stance: "accept" as const,
        rationale: "Independent review",
        sourceRefs: []
      })),
      ...epoch.answerVersions.map((item) => ({
        kind: "answer" as const,
        answerVersionId: item.answerVersionId,
        stance: "accept" as const,
        rationale: "Independent review",
        sourceRefs: []
      })),
      ...epoch.objections.map((item) => ({
        kind: "objection" as const,
        objectionId: item.objectionId,
        stance: "uncertain" as const,
        rationale: "Independent objection review",
        sourceRefs: [],
        ...(item.authorId === memberId
          ? {
              status: "retained" as const,
              summary: item.summary,
              impact: item.impact,
              evidenceNeeded: item.evidenceNeeded
            }
          : {})
      }))
    ],
    evidenceRequests: []
  };
}
export function discussionEnvelope(state: DiscussionSession, memberId: string, payload: unknown): DiscussionReply {
  return { memberId, snapshotId: discussionSnapshotId(state), payload };
}
export function openedSession(memberIds: readonly string[] = ["a", "b"]): DiscussionSession {
  const state = stage2Session(memberIds);
  return applyDiscussionBatch(
    state,
    memberIds.map((id) => discussionEnvelope(state, id, openingTurn()))
  );
}
export function exchangedSession(memberIds: readonly string[] = ["a", "b"]): DiscussionSession {
  const state = openedSession(memberIds);
  return applyDiscussionBatch(
    state,
    memberIds.map((id) => discussionEnvelope(state, id, exchangeTurn(state, id)))
  );
}
export const reviewSession = (memberIds: readonly string[] = ["a", "b"]): DiscussionSession =>
  freezeDiscussionReview(exchangedSession(memberIds));
