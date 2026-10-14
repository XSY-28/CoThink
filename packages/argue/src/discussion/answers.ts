import { DiscussionAnswerDraftSchema, OpeningAnswerDraftSchema } from "./contracts.js";
import type { AnswerVersion, DiscussionClaimVersion, DiscussionSession, ImportantObjection } from "./contracts.js";
import { freezeDiscussionValue } from "./state-utils.js";

/** Only committed versions in the current segment participate in semantic views. */
export function latestDiscussionAnswers(state: DiscussionSession): readonly AnswerVersion[] {
  const latest = new Map<string, AnswerVersion>();
  for (const answer of state.answerVersions) {
    if (answer.segmentId === state.segmentId) latest.set(answer.authorId, answer);
  }
  const answers = state.memberIds.flatMap((memberId) => {
    const answer = latest.get(memberId);
    return answer === undefined ? [] : [answer];
  });
  return freezeDiscussionValue(structuredClone(answers));
}

export function activeDiscussionClaims(state: DiscussionSession): readonly DiscussionClaimVersion[] {
  const latest = new Map<string, DiscussionClaimVersion>();
  for (const claim of state.claimVersions) {
    if (claim.segmentId !== state.segmentId) continue;
    const previous = latest.get(claim.claimId);
    if (previous === undefined || claim.version >= previous.version) latest.set(claim.claimId, claim);
  }
  return freezeDiscussionValue(structuredClone([...latest.values()].filter((claim) => !claim.withdrawn)));
}

/** An absent owner status is unresolved; another member cannot dismiss an objection. */
export function activeDiscussionObjections(state: DiscussionSession): readonly ImportantObjection[] {
  const active = state.objections.filter((objection) => {
    if (objection.segmentId !== state.segmentId) return false;
    let latest: DiscussionSession["objectionResolutions"][number] | undefined;
    for (const resolution of state.objectionResolutions) {
      if (resolution.objectionId !== objection.objectionId || resolution.authorId !== objection.authorId) continue;
      if (latest === undefined || resolution.epochId >= latest.epochId) latest = resolution;
    }
    return latest === undefined || latest.status === "retained";
  });
  return freezeDiscussionValue(structuredClone(active));
}

function requireMemberAndPhase(state: DiscussionSession, memberId: string, phase: "opening" | "discussion"): void {
  if (!state.memberIds.includes(memberId)) throw new Error(`Unknown discussion member: ${memberId}`);
  if (state.phase !== phase) throw new Error(`Answer changes require the ${phase} phase`);
}

function requireUnique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicate references`);
}

function requireBody(body: string): void {
  if (body.trim().length === 0) throw new Error("Answer body must not be empty or whitespace");
}

export function validateOpeningAnswer(
  state: DiscussionSession,
  memberId: string,
  draft: unknown,
  claimCount: number
): void {
  requireMemberAndPhase(state, memberId, "opening");
  if (latestDiscussionAnswers(state).some((answer) => answer.authorId === memberId)) {
    throw new Error("An opening cannot replace an existing owner answer");
  }
  if (!Number.isSafeInteger(claimCount) || claimCount < 0)
    throw new Error("Opening claim count must be a nonnegative safe integer");
  const parsed = OpeningAnswerDraftSchema.parse(draft);
  requireBody(parsed.body);
  requireUnique(parsed.basisDraftIndices, "Opening basisDraftIndices");
  if (parsed.basisDraftIndices.some((index) => index >= claimCount)) {
    throw new Error("Opening answer basis index is outside the member's own drafts");
  }
  if (parsed.unresolvedObjectionIds.length !== 0)
    throw new Error("Opening must explicitly declare no unresolved objections");
}

export function validateDiscussionAnswer(state: DiscussionSession, memberId: string, draft: unknown): void {
  requireMemberAndPhase(state, memberId, "discussion");
  const parsed = DiscussionAnswerDraftSchema.parse(draft);
  requireBody(parsed.body);
  const ownLatest = latestDiscussionAnswers(state).find((answer) => answer.authorId === memberId);
  if (ownLatest === undefined || parsed.previousVersionId !== ownLatest.answerVersionId) {
    throw new Error("An answer revision must cite its author's latest answer in the current segment");
  }
  requireUnique(parsed.basisVersionIds, "Answer basisVersionIds");
  const activeIds = new Set(activeDiscussionClaims(state).map((claim) => claim.versionId));
  if (parsed.basisVersionIds.some((versionId) => !activeIds.has(versionId))) {
    throw new Error("Answer basis must cite active latest claims in the frozen snapshot");
  }
  requireUnique(parsed.unresolvedObjectionIds, "Answer unresolvedObjectionIds");
  const objectionIds = new Set(activeDiscussionObjections(state).map((objection) => objection.objectionId));
  if (parsed.unresolvedObjectionIds.some((objectionId) => !objectionIds.has(objectionId))) {
    throw new Error("Answer unresolved objections must exist and remain active in the frozen snapshot");
  }
}

function answerVersionId(state: DiscussionSession, memberId: string): string {
  const ordinal =
    state.answerVersions.filter((answer) => answer.segmentId === state.segmentId && answer.authorId === memberId)
      .length + 1;
  return `${state.sessionId}:s${state.segmentId}:member:${encodeURIComponent(memberId)}:answer:v${ordinal}`;
}

/** Resolve only caller-local opening references after the whole opening claim batch is prepared. */
export function createOpeningAnswerVersion(
  state: DiscussionSession,
  memberId: string,
  draft: unknown,
  ownClaimVersionIds: readonly string[]
): AnswerVersion {
  validateOpeningAnswer(state, memberId, draft, ownClaimVersionIds.length);
  requireUnique(ownClaimVersionIds, "Opening ownClaimVersionIds");
  for (const versionId of ownClaimVersionIds) {
    const claim = state.claimVersions.find((value) => value.versionId === versionId);
    if (
      claim === undefined ||
      claim.authorId !== memberId ||
      claim.segmentId !== state.segmentId ||
      claim.roundIndex !== 0 ||
      claim.withdrawn
    ) {
      throw new Error("Opening local basis must resolve to the author's own same-batch claims");
    }
  }
  const parsed = OpeningAnswerDraftSchema.parse(draft);
  const basisVersionIds = parsed.basisDraftIndices.map((index) => {
    const versionId = ownClaimVersionIds[index];
    if (versionId === undefined) throw new Error("Opening basis index has no corresponding claim version");
    return versionId;
  });
  return freezeDiscussionValue({
    answerVersionId: answerVersionId(state, memberId),
    authorId: memberId,
    segmentId: state.segmentId,
    roundIndex: state.roundIndex,
    body: parsed.body,
    basisVersionIds,
    limitations: parsed.limitations,
    unresolvedObjectionIds: parsed.unresolvedObjectionIds
  });
}

/** Validation deliberately uses the original frozen state, never same-batch proposed claims. */
export function createRevisedAnswerVersion(state: DiscussionSession, memberId: string, draft: unknown): AnswerVersion {
  validateDiscussionAnswer(state, memberId, draft);
  const parsed = DiscussionAnswerDraftSchema.parse(draft);
  return freezeDiscussionValue({
    answerVersionId: answerVersionId(state, memberId),
    authorId: memberId,
    previousVersionId: parsed.previousVersionId,
    segmentId: state.segmentId,
    roundIndex: state.roundIndex,
    body: parsed.body,
    basisVersionIds: parsed.basisVersionIds,
    limitations: parsed.limitations,
    unresolvedObjectionIds: parsed.unresolvedObjectionIds
  });
}
