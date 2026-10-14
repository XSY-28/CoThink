import type { DiscussionSemanticSnapshot, DiscussionSession } from "./contracts.js";
import { discussionHash, freezeDiscussionValue } from "./state-utils.js";
import { activeDiscussionClaims, latestDiscussionAnswers, activeDiscussionObjections } from "./answers.js";

/** Shared committed semantics; partial seals and policy weights are never model context. */
export function sharedDiscussionSnapshot(state: DiscussionSession): DiscussionSemanticSnapshot {
  const currentEpoch = state.phase === "review" ? state.reviewEpochs.at(-1) : undefined;
  const latestAnswers = latestDiscussionAnswers(state);
  const activeClaims = activeDiscussionClaims(state);
  const activeObjections = activeDiscussionObjections(state);
  const targetIds = new Set([
    ...activeObjections.map((objection) => objection.targetAnswerVersionId),
    ...state.messages.flatMap((message) => (message.target?.kind === "answer" ? [message.target.answerVersionId] : []))
  ]);
  const historicalAnswerVersions = state.answerVersions.filter(
    (answer) =>
      targetIds.has(answer.answerVersionId) &&
      !latestAnswers.some((latest) => latest.answerVersionId === answer.answerVersionId)
  );
  const basisIds = new Set([
    ...latestAnswers.flatMap((answer) => answer.basisVersionIds),
    ...historicalAnswerVersions.flatMap((answer) => answer.basisVersionIds),
    ...activeObjections.flatMap((objection) =>
      objection.targetClaimVersionId ? [objection.targetClaimVersionId] : []
    ),
    ...state.messages.flatMap((message) => (message.target?.kind === "claim" ? [message.target.versionId] : []))
  ]);
  const lastCommittedEpoch = state.reviewEpochs.filter((epoch) => epoch.status === "committed").at(-1);
  return freezeDiscussionValue(
    structuredClone({
      schemaVersion: 2 as const,
      sessionId: state.sessionId,
      segmentId: state.segmentId,
      contextVersion: state.contextVersion,
      phase: state.phase,
      roundIndex: state.roundIndex,
      committedSeq: state.committedSeq,
      question: state.question,
      constraints: state.constraints,
      memberIds: state.memberIds,
      sources: state.sources,
      claimVersions: activeClaims,
      answerVersions: latestAnswers,
      objections: activeObjections,
      historicalClaimVersions: state.claimVersions.filter(
        (claim) => basisIds.has(claim.versionId) && !activeClaims.some((active) => active.versionId === claim.versionId)
      ),
      historicalAnswerVersions,
      messages: state.messages.filter((item) => item.segmentId === state.segmentId),
      ...(currentEpoch ? { reviewEpoch: currentEpoch } : {}),
      lastReviews: lastCommittedEpoch?.reviews ?? []
    })
  );
}
export const discussionSnapshotId = (state: DiscussionSession): string =>
  discussionHash(sharedDiscussionSnapshot(state));
