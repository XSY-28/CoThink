import type { AnswerVersion, DiscussionSession, ImportantObjection, ReviewEpoch } from "./contracts.js";
import { activeDiscussionClaims, latestDiscussionAnswers } from "./answers.js";
import { parseDiscussionSession } from "./protocol.js";
import {
  currentReviewSource,
  discussionConstraintContextHash,
  failedChecksForAnswer,
  validateConstraintChecks,
  type ConstraintCheck
} from "./result.js";
import { discussionHash, freezeDiscussionValue } from "./state-utils.js";

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(right).size === right.length && left.every((id) => right.includes(id));
}

/** Called only after strict replay has verified all versions and exact review coverage. */
function completeReview(state: DiscussionSession): ReviewEpoch | undefined {
  const epoch = currentReviewSource(state);
  if (
    !epoch ||
    epoch.segmentId !== state.segmentId ||
    epoch.contextVersion !== state.contextVersion ||
    epoch.contextHash !== discussionConstraintContextHash(state) ||
    !sameMembers(state.memberIds, epoch.expectedMembers) ||
    !sameMembers(
      state.memberIds,
      epoch.reviews.map((review) => review.memberId)
    ) ||
    discussionHash(epoch.answerVersions) !== discussionHash(latestDiscussionAnswers(state)) ||
    discussionHash(epoch.claimVersions) !== discussionHash(activeDiscussionClaims(state))
  )
    return undefined;
  return epoch;
}

/** A completed older epoch never confirms a later discussion or a pending half-batch. */
export function currentCompleteReview(state: DiscussionSession): ReviewEpoch | undefined {
  return completeReview(parseDiscussionSession(state));
}

function relevantObjection(state: DiscussionSession, answer: AnswerVersion, objection: ImportantObjection): boolean {
  if (answer.segmentId !== state.segmentId || objection.segmentId !== state.segmentId) return false;
  if (answer.unresolvedObjectionIds.includes(objection.objectionId)) return true;
  const answers = new Map(state.answerVersions.map((version) => [version.answerVersionId, version]));
  let ancestor: AnswerVersion | undefined = answer;
  const visitedAnswers = new Set<string>();
  while (
    ancestor &&
    ancestor.authorId === answer.authorId &&
    ancestor.segmentId === answer.segmentId &&
    !visitedAnswers.has(ancestor.answerVersionId)
  ) {
    if (objection.targetAnswerVersionId === ancestor.answerVersionId) return true;
    visitedAnswers.add(ancestor.answerVersionId);
    ancestor = ancestor.previousVersionId ? answers.get(ancestor.previousVersionId) : undefined;
  }
  if (!objection.targetClaimVersionId) return false;
  const claims = new Map(state.claimVersions.map((version) => [version.versionId, version]));
  for (const basisId of answer.basisVersionIds) {
    const basis = claims.get(basisId);
    let claim = basis;
    const visitedClaims = new Set<string>();
    while (
      basis &&
      claim &&
      claim.segmentId === answer.segmentId &&
      claim.claimId === basis.claimId &&
      claim.authorId === basis.authorId &&
      !visitedClaims.has(claim.versionId)
    ) {
      if (claim.versionId === objection.targetClaimVersionId) return true;
      visitedClaims.add(claim.versionId);
      claim = claim.previousVersionId ? claims.get(claim.previousVersionId) : undefined;
    }
  }
  return false;
}

/** Relevance follows saved version links; similar text or ID prefixes carry no authority. */
export function isRelevantObjection(
  state: DiscussionSession,
  answer: AnswerVersion,
  objection: ImportantObjection
): boolean {
  const checked = parseDiscussionSession(state);
  const savedAnswer = checked.answerVersions.find((item) => item.answerVersionId === answer.answerVersionId);
  const savedObjection = checked.objections.find((item) => item.objectionId === objection.objectionId);
  if (
    !savedAnswer ||
    !savedObjection ||
    discussionHash(answer) !== discussionHash(savedAnswer) ||
    discussionHash(objection) !== discussionHash(savedObjection)
  )
    return false;
  return relevantObjection(checked, savedAnswer, savedObjection);
}

/** Return independently confirmed candidates, without ranking, rewriting or finalizing them. */
export function evaluateConsensus(
  state: DiscussionSession,
  checks: readonly ConstraintCheck[] = []
): readonly AnswerVersion[] {
  const checked = parseDiscussionSession(state);
  const scopedChecks = validateConstraintChecks(checked, checks);
  const epoch = completeReview(checked);
  if (
    !epoch ||
    epoch.claimVersions.length === 0 ||
    checked.messages.some(
      (message) =>
        message.segmentId === checked.segmentId && message.kind !== "reply" && message.respondedBy.length === 0
    )
  )
    return freezeDiscussionValue([]);
  const activeIds = new Set(epoch.claimVersions.map((claim) => claim.versionId));
  return freezeDiscussionValue(
    epoch.answerVersions.filter((answer) => {
      if (
        answer.basisVersionIds.length === 0 ||
        answer.basisVersionIds.some((id) => !activeIds.has(id)) ||
        failedChecksForAnswer(scopedChecks, answer.answerVersionId).length
      )
        return false;
      const accepted = epoch.reviews.every((review) => {
        const answerPosition = review.turn.positions.find(
          (position) => position.kind === "answer" && position.answerVersionId === answer.answerVersionId
        );
        return (
          answerPosition?.stance === "accept" &&
          answer.basisVersionIds.every((id) =>
            review.turn.positions.some(
              (position) => position.kind === "claim" && position.versionId === id && position.stance === "accept"
            )
          )
        );
      });
      if (!accepted) return false;
      return epoch.objections.every((objection) => {
        if (!relevantObjection(checked, answer, objection)) return true;
        const position = epoch.reviews
          .find((review) => review.memberId === objection.authorId)
          ?.turn.positions.find((item) => item.kind === "objection" && item.objectionId === objection.objectionId);
        return position?.kind === "objection" && (position.status === "resolved" || position.status === "withdrawn");
      });
    })
  );
}
