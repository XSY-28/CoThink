import { z } from "zod";
import type { AnswerVersion, DiscussionSession, ReviewEpoch } from "./contracts.js";
import { latestDiscussionAnswers } from "./answers.js";
import { parseDiscussionSession } from "./protocol.js";
import { resolveRoundLimit } from "./policy.js";
import { currentCompleteReview, evaluateConsensus, isRelevantObjection } from "./consensus.js";
import { discussionHash } from "./state-utils.js";
import {
  ConstraintCheckSchema,
  validateConstraintChecks,
  failedChecksForAnswer,
  parseFinalResultSources,
  type FinalSelectionInput,
  type FinalResult,
  type ImportantDissent
} from "./result.js";
const stopSchema = z.enum(["checkpoint", "round_limit", "budget_limit", "interrupted", "deadline", "model_failure"]);
const inputSchema = z
  .object({
    session: z.unknown(),
    stopReason: stopSchema,
    constraintChecks: z.array(ConstraintCheckSchema).default([])
  })
  .strict();
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
/** Policy v1 tie-break: decision preference, then canonical saved content hash.
 * IDs are a final tie-break only when all content and endorsements are equivalent. */
export function consensusAnswerContentHash(answer: AnswerVersion): string {
  return discussionHash({
    body: answer.body,
    basisVersionIds: [...answer.basisVersionIds].sort(compareText),
    limitations: answer.limitations,
    unresolvedObjectionIds: [...answer.unresolvedObjectionIds].sort(compareText)
  });
}
function dissentFor(
  state: DiscussionSession,
  epoch: ReviewEpoch,
  selected: readonly AnswerVersion[]
): ImportantDissent[] {
  const dissent: ImportantDissent[] = [];
  for (const objection of epoch.objections) {
    const position = epoch.reviews
      .find((review) => review.memberId === objection.authorId)!
      .turn.positions.find((item) => item.kind === "objection" && item.objectionId === objection.objectionId)!;
    if (position.kind !== "objection" || position.status !== "retained") continue;
    if (objection.severity !== "blocking" && !selected.some((answer) => isRelevantObjection(state, answer, objection)))
      continue;
    dissent.push({
      objectionId: objection.objectionId,
      authorId: objection.authorId,
      targetAnswerVersionId: objection.targetAnswerVersionId,
      ...(objection.targetClaimVersionId === undefined ? {} : { targetClaimVersionId: objection.targetClaimVersionId }),
      severity: objection.severity,
      summary: position.summary!,
      impact: position.impact!,
      evidenceNeeded: position.evidenceNeeded!
    });
  }
  return dissent.sort((left, right) => compareText(left.objectionId, right.objectionId));
}
/** No model, rewriting, transport or scheduling. The host supplies the stop reason.
 * budget_limit must be established by the future budget-owning driver. */
export function selectFinalResult(raw: FinalSelectionInput): FinalResult {
  const input = inputSchema.parse(raw),
    state = parseDiscussionSession(input.session);
  const checks = validateConstraintChecks(state, input.constraintChecks);
  const base = {
    resultVersion: "discussion.result.v1" as const,
    sessionId: state.sessionId,
    segmentId: state.segmentId
  };
  const epoch = currentCompleteReview(state);
  const source = epoch ? { reviewEpochId: epoch.epochId, reviewSetHash: epoch.reviewSetHash } : {};
  const incomplete = (
    reason: NonNullable<FinalResult["incompleteReason"]>,
    failedCheckIds?: string[],
    missingAnswerMemberIds?: string[]
  ): FinalResult =>
    parseFinalResultSources(
      {
        ...base,
        ...source,
        outcome: "incomplete",
        answer: "",
        selectedAnswerVersionIds: [],
        importantDissent: [],
        limitations: [],
        incompleteReason: reason,
        ...(failedCheckIds?.length ? { failedCheckIds } : {}),
        ...(missingAnswerMemberIds?.length ? { missingAnswerMemberIds } : {})
      },
      state
    );
  if (input.stopReason === "interrupted" || input.stopReason === "deadline" || input.stopReason === "model_failure")
    return incomplete("abnormal_stop");
  const globalFailures = checks.filter((check) => check.status === "failed" && check.answerVersionId === null);
  if (globalFailures.length)
    return incomplete(
      "constraint_failed",
      globalFailures.map((check) => check.checkId)
    );
  const maximum = Math.max(...state.memberIds.map((id) => state.policy.weights[id]!.decisionWeight));
  const preferred = state.memberIds.filter((id) => state.policy.weights[id]!.decisionWeight === maximum);
  const answers = latestDiscussionAnswers(state);
  // Never replace a missing highest-preference author with a lower one.
  const missing = preferred.filter((id) => !answers.some((answer) => answer.authorId === id));
  if (missing.length) return incomplete("missing_valid_answer", undefined, missing);
  if (!epoch) return incomplete("incomplete_review");
  const consensus = evaluateConsensus(state, checks);
  if (consensus.length) {
    const selected = [...consensus].sort(
      (left, right) =>
        state.policy.weights[right.authorId]!.decisionWeight - state.policy.weights[left.authorId]!.decisionWeight ||
        compareText(consensusAnswerContentHash(left), consensusAnswerContentHash(right)) ||
        compareText(left.answerVersionId, right.answerVersionId)
    )[0]!;
    return parseFinalResultSources(
      {
        ...base,
        ...source,
        outcome: "consensus",
        answer: selected.body,
        selectedAnswerVersionIds: [selected.answerVersionId],
        importantDissent: [],
        limitations: [...selected.limitations]
      },
      state
    );
  }
  if (input.stopReason === "checkpoint") return incomplete("discussion_continues");
  if (input.stopReason === "round_limit" && epoch.roundIndex < resolveRoundLimit(state.policy, state.complexities))
    return incomplete("round_limit_not_reached");
  const selected = preferred
    .map((id) => answers.find((answer) => answer.authorId === id)!)
    .sort((left, right) => compareText(left.authorId, right.authorId));
  const failures = selected.flatMap((answer) => failedChecksForAnswer(checks, answer.answerVersionId));
  if (failures.length) return incomplete("constraint_failed", [...new Set(failures.map((check) => check.checkId))]);
  const importantDissent = dissentFor(state, epoch, selected);
  if (selected.length > 1)
    return parseFinalResultSources(
      {
        ...base,
        ...source,
        outcome: "tied_preferences",
        answer: "",
        selectedAnswerVersionIds: selected.map((answer) => answer.answerVersionId),
        importantDissent,
        limitations: [],
        alternatives: selected.map((answer) => ({
          authorId: answer.authorId,
          answerVersionId: answer.answerVersionId,
          body: answer.body,
          limitations: [...answer.limitations]
        }))
      },
      state
    );
  return parseFinalResultSources(
    {
      ...base,
      ...source,
      outcome: "weighted_fallback",
      answer: selected[0]!.body,
      selectedAnswerVersionIds: [selected[0]!.answerVersionId],
      importantDissent,
      limitations: [...selected[0]!.limitations]
    },
    state
  );
}
