import { z } from "zod";
import type { DiscussionReadonly, DiscussionSession, ReviewEpoch } from "./contracts.js";
import { latestDiscussionAnswers } from "./answers.js";
import { parseDiscussionSession } from "./protocol.js";
import { discussionHash, freezeDiscussionValue } from "./state-utils.js";

const text = z.string().refine((value) => value.trim().length > 0, "Non-whitespace text required");
export const ConstraintCheckSchema = z
  .object({
    checkId: text,
    source: z.literal("host"),
    contextHash: text,
    answerVersionId: text.nullable(),
    status: z.enum(["passed", "failed"]),
    evidence: text
  })
  .strict();
export type ConstraintCheck = DiscussionReadonly<z.infer<typeof ConstraintCheckSchema>>;
export const ImportantDissentSchema = z
  .object({
    objectionId: text,
    authorId: text,
    targetAnswerVersionId: text,
    targetClaimVersionId: text.optional(),
    severity: z.enum(["material", "blocking"]),
    summary: text,
    impact: text,
    evidenceNeeded: text
  })
  .strict();
export type ImportantDissent = DiscussionReadonly<z.infer<typeof ImportantDissentSchema>>;
export const FinalResultSchema = z
  .object({
    resultVersion: z.literal("discussion.result.v1"),
    sessionId: text,
    segmentId: z.number().int().positive(),
    outcome: z.enum(["consensus", "weighted_fallback", "tied_preferences", "incomplete"]),
    answer: z.string(),
    selectedAnswerVersionIds: z.array(text),
    importantDissent: z.array(ImportantDissentSchema),
    limitations: z.array(text),
    alternatives: z
      .array(z.object({ authorId: text, answerVersionId: text, body: text, limitations: z.array(text) }).strict())
      .optional(),
    reviewEpochId: z.number().int().positive().optional(),
    reviewSetHash: text.optional(),
    incompleteReason: z
      .enum([
        "missing_valid_answer",
        "incomplete_review",
        "abnormal_stop",
        "discussion_continues",
        "round_limit_not_reached",
        "constraint_failed"
      ])
      .optional(),
    failedCheckIds: z.array(text).optional(),
    missingAnswerMemberIds: z.array(text).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (new Set(value.selectedAnswerVersionIds).size !== value.selectedAnswerVersionIds.length)
      problem("Duplicate selected answer version");
    if (new Set(value.importantDissent.map((item) => item.objectionId)).size !== value.importantDissent.length)
      problem("Duplicate dissent ID");
    if (value.outcome === "consensus" || value.outcome === "weighted_fallback") {
      if (value.selectedAnswerVersionIds.length !== 1 || !value.answer.trim() || value.alternatives?.length)
        problem("Selected result requires exactly one original answer");
      if (value.incompleteReason !== undefined || value.failedCheckIds?.length)
        problem("Complete result cannot contain failure reasons");
    } else {
      if (value.answer !== "") problem("Unselected result cannot invent a combined answer");
      if (value.outcome === "incomplete") {
        if (value.selectedAnswerVersionIds.length || value.alternatives?.length || !value.incompleteReason)
          problem("Incomplete result cannot select an answer");
      } else {
        const alternatives = value.alternatives ?? [];
        if (
          alternatives.length < 2 ||
          new Set(alternatives.map((item) => item.authorId)).size !== alternatives.length ||
          !sameIds(
            value.selectedAnswerVersionIds,
            alternatives.map((item) => item.answerVersionId)
          )
        )
          problem("Tied result requires all distinct alternatives");
        if (value.incompleteReason !== undefined || value.failedCheckIds?.length)
          problem("Tied result cannot contain failure reasons");
      }
    }
    if (value.outcome !== "incomplete" && (!value.reviewEpochId || !value.reviewSetHash))
      problem("Complete result requires its source review");
    if (
      value.missingAnswerMemberIds &&
      (value.incompleteReason !== "missing_valid_answer" ||
        !value.missingAnswerMemberIds.length ||
        new Set(value.missingAnswerMemberIds).size !== value.missingAnswerMemberIds.length)
    )
      problem("Missing answer members require an incomplete missing-answer result");
  });
export type FinalResult = DiscussionReadonly<z.infer<typeof FinalResultSchema>>;
export type SelectionStopReason =
  | "checkpoint"
  | "round_limit"
  | "budget_limit"
  | "interrupted"
  | "deadline"
  | "model_failure";
export interface FinalSelectionInput {
  readonly session: DiscussionSession;
  readonly stopReason: SelectionStopReason;
  /** Host-owned evidence only; a model payload cannot provide constraint checks. */
  readonly constraintChecks?: readonly ConstraintCheck[];
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(right).size === right.length && left.every((id) => right.includes(id));
}
export function discussionConstraintContextHash(state: DiscussionSession): string {
  return discussionHash({
    question: state.question,
    constraints: state.constraints,
    sources: state.sources,
    memberIds: state.memberIds,
    segmentId: state.segmentId,
    contextVersion: state.contextVersion
  });
}
/** Validate explicit evidence scope; never apply stale checks to a new answer. */
export function validateConstraintChecks(
  state: DiscussionSession,
  raw: readonly ConstraintCheck[]
): readonly ConstraintCheck[] {
  const checks = z.array(ConstraintCheckSchema).parse(raw);
  if (new Set(checks.map((check) => check.checkId)).size !== checks.length)
    throw new Error("Duplicate constraint check ID");
  const ids = new Set(latestDiscussionAnswers(state).map((answer) => answer.answerVersionId));
  const contextHash = discussionConstraintContextHash(state);
  for (const check of checks)
    if (check.contextHash !== contextHash || (check.answerVersionId !== null && !ids.has(check.answerVersionId)))
      throw new Error("Stale or unknown constraint check scope");
  return freezeDiscussionValue(checks);
}
export function failedChecksForAnswer(
  checks: readonly ConstraintCheck[],
  answerVersionId: string
): readonly ConstraintCheck[] {
  return checks.filter(
    (check) =>
      check.status === "failed" && (check.answerVersionId === null || check.answerVersionId === answerVersionId)
  );
}
/** Source verification does not infer consensus or verify facts. Selection owns those rules. */
export function parseFinalResultSources(raw: unknown, session: DiscussionSession): FinalResult {
  const state = parseDiscussionSession(session),
    result = FinalResultSchema.parse(raw);
  if (result.sessionId !== state.sessionId || result.segmentId !== state.segmentId)
    throw new Error("Final result session mismatch");
  const epoch = state.reviewEpochs.at(-1);
  if (result.reviewEpochId !== undefined || result.reviewSetHash !== undefined) {
    if (
      !epoch ||
      epoch.status !== "committed" ||
      epoch.epochId !== result.reviewEpochId ||
      epoch.reviewSetHash !== result.reviewSetHash
    )
      throw new Error("Final result review source mismatch");
  }
  const answers = latestDiscussionAnswers(state);
  if (result.incompleteReason === "missing_valid_answer") {
    const highest = Math.max(...state.memberIds.map((id) => state.policy.weights[id]!.decisionWeight));
    const missing = state.memberIds.filter(
      (id) => state.policy.weights[id]!.decisionWeight === highest && !answers.some((answer) => answer.authorId === id)
    );
    if (!missing.length || !sameIds(result.missingAnswerMemberIds ?? [], missing))
      throw new Error("Missing answer members must match saved state and decision preferences");
  }
  for (const id of result.selectedAnswerVersionIds)
    if (!answers.some((answer) => answer.answerVersionId === id))
      throw new Error("Final answer source is stale or missing");
  if (result.outcome === "consensus" || result.outcome === "weighted_fallback") {
    const answer = answers.find((item) => item.answerVersionId === result.selectedAnswerVersionIds[0])!;
    if (result.answer !== answer.body || discussionHash(result.limitations) !== discussionHash(answer.limitations))
      throw new Error("Final answer content must match its saved version");
  }
  for (const alternative of result.alternatives ?? []) {
    const answer = answers.find((item) => item.answerVersionId === alternative.answerVersionId);
    if (
      !answer ||
      answer.authorId !== alternative.authorId ||
      answer.body !== alternative.body ||
      discussionHash(answer.limitations) !== discussionHash(alternative.limitations)
    )
      throw new Error("Alternative must match its saved version");
  }
  for (const dissent of result.importantDissent) {
    if (!epoch || epoch.status !== "committed") throw new Error("Dissent needs a complete source review");
    const objection = epoch.objections.find((item) => item.objectionId === dissent.objectionId);
    const turn = epoch.reviews.find((review) => review.memberId === objection?.authorId)?.turn;
    const position = turn?.positions.find(
      (item) => item.kind === "objection" && item.objectionId === dissent.objectionId
    );
    if (
      !objection ||
      !position ||
      position.kind !== "objection" ||
      position.status !== "retained" ||
      dissent.authorId !== objection.authorId ||
      dissent.targetAnswerVersionId !== objection.targetAnswerVersionId ||
      dissent.targetClaimVersionId !== objection.targetClaimVersionId ||
      dissent.severity !== objection.severity ||
      dissent.summary !== position.summary ||
      dissent.impact !== position.impact ||
      dissent.evidenceNeeded !== position.evidenceNeeded
    )
      throw new Error("Dissent must come from its original author's current retained review");
  }
  return freezeDiscussionValue(result);
}
/** The checked current epoch is useful to future scheduling, never a dispatch instruction. */
export function currentReviewSource(state: DiscussionSession): ReviewEpoch | undefined {
  const epoch = state.reviewEpochs.at(-1);
  return state.phase === "review" && !state.pendingBatch && epoch?.status === "committed" ? epoch : undefined;
}
