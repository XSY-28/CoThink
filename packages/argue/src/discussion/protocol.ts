import {
  DISCUSSION_SCHEMA_VERSION,
  DISCUSSION_PROMPT_VERSION,
  DISCUSSION_CODEC_VERSION,
  DISCUSSION_POLICY_VERSION,
  DiscussionSessionSchema,
  DiscussionProtocolTurnSchema,
  DiscussionReplySchema,
  SealedDiscussionReplySchema,
  AnswerVersionSchema,
  ReviewEpochSchema,
  DiscussionReviewTurnSchema,
  type DiscussionSession,
  type DiscussionSessionInput,
  type DiscussionReply,
  type SealedDiscussionReply,
  type DiscussionProtocolTurn,
  type DiscussionReviewTurn,
  type ReviewEpoch,
  type DiscussionSourceRef,
  type DiscussionClaimVersion
} from "./contracts.js";
import { normalizeDiscussionPolicy } from "./policy.js";
import {
  activeDiscussionClaims,
  latestDiscussionAnswers,
  activeDiscussionObjections,
  validateOpeningAnswer,
  validateDiscussionAnswer,
  createOpeningAnswerVersion,
  createRevisedAnswerVersion
} from "./answers.js";
import { sharedDiscussionSnapshot, discussionSnapshotId } from "./context.js";
import { discussionHash, discussionSha256, freezeDiscussionValue } from "./state-utils.js";

type MutableSession = ReturnType<typeof DiscussionSessionSchema.parse>;
const copy = (state: DiscussionSession): MutableSession => DiscussionSessionSchema.parse(structuredClone(state));
function same(left: unknown, right: unknown): boolean {
  return discussionHash(left) === discussionHash(right);
}
function exactRoster(ids: readonly string[], actual: readonly string[]): void {
  if (ids.length !== actual.length || new Set(actual).size !== actual.length || ids.some((id) => !actual.includes(id)))
    throw new Error("Complete batch requires every expected member exactly once");
}
function contextHash(state: DiscussionSession): string {
  return discussionHash({
    question: state.question,
    constraints: state.constraints,
    sources: state.sources,
    memberIds: state.memberIds,
    segmentId: state.segmentId,
    contextVersion: state.contextVersion
  });
}
export function discussionReviewSetHash(
  sessionId: string,
  epoch: Omit<ReviewEpoch, "reviewSetHash" | "status" | "reviews">
): string {
  return discussionHash({
    sessionId,
    epochId: epoch.epochId,
    contextHash: epoch.contextHash,
    segmentId: epoch.segmentId,
    contextVersion: epoch.contextVersion,
    roundIndex: epoch.roundIndex,
    expectedMembers: epoch.expectedMembers,
    claimVersions: epoch.claimVersions,
    answerVersions: epoch.answerVersions,
    objections: epoch.objections
  });
}
function initial(input: DiscussionSessionInput): DiscussionSession {
  const policy = normalizeDiscussionPolicy(input.policy, input.memberIds);
  const state = DiscussionSessionSchema.parse({
    schemaVersion: DISCUSSION_SCHEMA_VERSION,
    promptVersion: DISCUSSION_PROMPT_VERSION,
    codecVersion: DISCUSSION_CODEC_VERSION,
    policyVersion: DISCUSSION_POLICY_VERSION,
    sessionId: input.sessionId,
    revision: 0,
    policy,
    policyHash: discussionHash(policy),
    question: input.question,
    constraints: input.constraints ?? [],
    memberIds: input.memberIds,
    sources: (input.sources ?? []).map((source) => ({
      ...source,
      contentHash: discussionSha256(source.content),
      lineCount: source.content.split("\n").length
    })),
    segmentId: input.segmentId ?? 1,
    contextVersion: input.contextVersion ?? 1,
    phase: "opening",
    roundIndex: 0,
    committedSeq: 0,
    claimVersions: [],
    answerVersions: [],
    objections: [],
    messages: [],
    reviewEpochs: [],
    objectionResolutions: [],
    complexities: {},
    committedBatches: []
  });
  if (new Set(state.sources.map((source) => source.sourceId)).size !== state.sources.length)
    throw new Error("Duplicate source IDs");
  if (state.sources.reduce((total, source) => total + source.content.length, 0) > 20000)
    throw new Error("Source character limit exceeded");
  return freezeDiscussionValue(state);
}
export function createDiscussionSession(input: DiscussionSessionInput): DiscussionSession {
  return initial(input);
}
function validateRefs(state: DiscussionSession, refs: readonly DiscussionSourceRef[]): void {
  for (const ref of refs) {
    const source = state.sources.find((item) => item.sourceId === ref.sourceId);
    if (!source || ref.startLine > ref.endLine || ref.endLine > source.lineCount)
      throw new Error("Invalid copied source reference");
  }
}
function activeClaim(state: DiscussionSession, id: string): DiscussionClaimVersion {
  const claim = activeDiscussionClaims(state).find((item) => item.versionId === id);
  if (!claim) throw new Error("Unknown, withdrawn or stale claim reference");
  return claim;
}
function validateReview(
  state: DiscussionSession,
  memberId: string,
  turn: DiscussionReviewTurn,
  epoch: ReviewEpoch
): void {
  if (turn.reviewSetHash !== epoch.reviewSetHash) throw new Error("Review set hash mismatch");
  const expected = [
    ...epoch.claimVersions.map((item) => `claim:${item.versionId}`),
    ...epoch.answerVersions.map((item) => `answer:${item.answerVersionId}`),
    ...epoch.objections.map((item) => `objection:${item.objectionId}`)
  ];
  const actual = turn.positions.map((position) =>
    position.kind === "claim"
      ? `claim:${position.versionId}`
      : position.kind === "answer"
        ? `answer:${position.answerVersionId}`
        : `objection:${position.objectionId}`
  );
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((id) => !expected.includes(id))
  )
    throw new Error("Review coverage must include every frozen item exactly once");
  for (const position of turn.positions) {
    validateRefs(state, position.sourceRefs);
    if (position.kind === "objection") {
      const objection = epoch.objections.find((item) => item.objectionId === position.objectionId)!;
      if (objection.authorId === memberId) {
        if (!position.status || !position.summary || !position.impact || !position.evidenceNeeded)
          throw new Error("Objection author must provide explicit status and dissent summary");
      } else if (
        position.status !== undefined ||
        position.summary !== undefined ||
        position.impact !== undefined ||
        position.evidenceNeeded !== undefined
      )
        throw new Error("Only the objection author may resolve or rewrite their dissent");
    }
  }
}
function validated(state: DiscussionSession, candidate: DiscussionReply): SealedDiscussionReply {
  const envelope = DiscussionReplySchema.parse(candidate);
  if (!state.memberIds.includes(envelope.memberId)) throw new Error("Unknown discussion member");
  if (envelope.snapshotId !== discussionSnapshotId(state)) throw new Error("Stale shared semantic snapshot");
  const turn = DiscussionProtocolTurnSchema.parse(envelope.payload);
  if (turn.phase !== state.phase) throw new Error("Wrong phase for frozen snapshot");
  if (turn.phase === "opening") {
    for (const claim of turn.claims) validateRefs(state, claim.sourceRefs);
    validateOpeningAnswer(state, envelope.memberId, turn.answer, turn.claims.length);
  }
  if (turn.phase === "discussion") {
    const modified = new Set<string>(),
      replied = new Set<string>();
    if (turn.actions.filter((action) => action.kind === "propose").length > 1)
      throw new Error("At most one new claim per member per batch");
    if (turn.actions.filter((action) => action.kind === "object").length > 1)
      throw new Error("At most one important objection per member per batch");
    if (turn.actions.filter((action) => action.kind === "ask" || action.kind === "challenge").length > 2)
      throw new Error("At most two directed asks/challenges per member per batch");
    for (const action of turn.actions) {
      if ("sourceRefs" in action) validateRefs(state, action.sourceRefs);
      if (action.kind === "propose" || action.kind === "revise") validateRefs(state, action.claim.sourceRefs);
      if (action.kind === "revise" || action.kind === "withdraw") {
        const target = activeClaim(state, action.targetVersionId);
        if (target.authorId !== envelope.memberId) throw new Error("Only the claim author may revise or withdraw it");
        if (modified.has(target.claimId)) throw new Error("Duplicate claim modification");
        modified.add(target.claimId);
      }
      if (action.kind === "ask" || action.kind === "challenge") {
        const reference = action.target;
        const target =
          reference.kind === "claim"
            ? activeClaim(state, reference.versionId)
            : latestDiscussionAnswers(state).find((item) => item.answerVersionId === reference.answerVersionId);
        if (!target) throw new Error("Unknown or stale answer target");
        if (target.authorId === envelope.memberId || action.recipientId !== target.authorId)
          throw new Error("Directed message must address the other target author");
      }
      if (action.kind === "reply") {
        const target = state.messages.find((item) => item.messageId === action.replyTo);
        if (
          !target ||
          target.kind === "reply" ||
          target.recipientId !== envelope.memberId ||
          target.respondedBy.length ||
          replied.has(target.messageId)
        )
          throw new Error("Reply must answer an unseen pending directed message exactly once");
        replied.add(target.messageId);
      }
      if (action.kind === "object") {
        if (
          !latestDiscussionAnswers(state).some(
            (item) => item.answerVersionId === action.objection.targetAnswerVersionId
          )
        )
          throw new Error("Unknown or stale objection answer target");
        if (action.objection.targetClaimVersionId) activeClaim(state, action.objection.targetClaimVersionId);
      }
    }
    if (
      state.messages.some(
        (item) =>
          item.kind !== "reply" &&
          item.recipientId === envelope.memberId &&
          !item.respondedBy.length &&
          !replied.has(item.messageId)
      )
    )
      throw new Error("Every pending directed message requires a reply");
    validateDiscussionAnswer(state, envelope.memberId, turn.answer);
  }
  if (turn.phase === "review") {
    const epoch = state.reviewEpochs.at(-1);
    if (!epoch || epoch.status !== "pending") throw new Error("Review checkpoint is missing or already committed");
    validateReview(state, envelope.memberId, turn, epoch);
  }
  return freezeDiscussionValue({ ...envelope, payload: turn, payloadHash: discussionHash(turn) });
}
function validateSeal(state: DiscussionSession, seal: SealedDiscussionReply): SealedDiscussionReply {
  const parsed = SealedDiscussionReplySchema.parse(seal);
  const validatedReply = validated(state, {
    memberId: parsed.memberId,
    snapshotId: parsed.snapshotId,
    payload: parsed.payload
  });
  if (parsed.payloadHash !== validatedReply.payloadHash) throw new Error("Corrupt sealed payload hash");
  return validatedReply;
}
export function validateDiscussionReply(state: DiscussionSession, candidate: DiscussionReply): SealedDiscussionReply {
  return validated(parseDiscussionSession(state), candidate);
}
function sealUnchecked(state: DiscussionSession, candidate: DiscussionReply): DiscussionSession {
  const reply = validated(state, candidate);
  const next = copy(state);
  next.pendingBatch ??= {
    snapshotId: reply.snapshotId,
    phase: state.phase,
    expectedMembers: [...state.memberIds],
    sealedReplies: []
  };
  if (next.pendingBatch.sealedReplies.some((item) => item.memberId === reply.memberId))
    throw new Error("Member reply is already sealed");
  next.pendingBatch.sealedReplies.push(SealedDiscussionReplySchema.parse(reply));
  next.revision++;
  return freezeDiscussionValue(next);
}
export function sealDiscussionReply(state: DiscussionSession, candidate: DiscussionReply): DiscussionSession {
  return sealUnchecked(parseDiscussionSession(state), candidate);
}
function propose(
  next: MutableSession,
  memberId: string,
  draft: Extract<DiscussionProtocolTurn, { phase: "opening" }>["claims"][number]
): string {
  const ordinal =
    new Set(
      next.claimVersions
        .filter((item) => item.authorId === memberId && item.segmentId === next.segmentId)
        .map((item) => item.claimId)
    ).size + 1;
  const claimId = `${next.sessionId}:s${next.segmentId}:member:${encodeURIComponent(memberId)}:claim:${ordinal}`;
  const versionId = `${claimId}:v1`;
  next.claimVersions.push({
    ...structuredClone(draft),
    assumptions: [...draft.assumptions],
    sourceRefs: draft.sourceRefs.map((ref) => ({ ...ref })),
    claimId,
    versionId,
    authorId: memberId,
    segmentId: next.segmentId,
    roundIndex: next.roundIndex,
    version: 1,
    withdrawn: false
  });
  return versionId;
}
function commitUnchecked(state: DiscussionSession): DiscussionSession {
  const batch = state.pendingBatch;
  if (!batch) throw new Error("No sealed batch");
  exactRoster(
    state.memberIds,
    batch.sealedReplies.map((reply) => reply.memberId)
  );
  const replies = state.memberIds.map((id) =>
    validateSeal(state, batch.sealedReplies.find((item) => item.memberId === id)!)
  );
  const next = copy(state);
  for (const reply of replies) {
    const turn = reply.payload;
    if (turn.phase === "opening") {
      const ownIds = turn.claims.map((claim) => propose(next, reply.memberId, claim));
      next.answerVersions.push(
        AnswerVersionSchema.parse(createOpeningAnswerVersion(next, reply.memberId, turn.answer, ownIds))
      );
      Object.defineProperty(next.complexities, reply.memberId, {
        value: turn.complexity,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    if (turn.phase === "discussion") {
      for (const [index, action] of turn.actions.entries()) {
        if (action.kind === "propose") propose(next, reply.memberId, action.claim);
        if (action.kind === "revise" || action.kind === "withdraw") {
          const old = activeClaim(state, action.targetVersionId),
            version = old.version + 1;
          next.claimVersions.push({
            ...DiscussionSessionSchema.shape.claimVersions.element.parse(old),
            ...(action.kind === "revise"
              ? {
                  ...structuredClone(action.claim),
                  assumptions: [...action.claim.assumptions],
                  sourceRefs: action.claim.sourceRefs.map((ref) => ({ ...ref }))
                }
              : { withdrawalReason: action.rationale }),
            version,
            versionId: `${old.claimId}:v${version}`,
            previousVersionId: old.versionId,
            roundIndex: state.roundIndex,
            withdrawn: action.kind === "withdraw"
          });
        }
        if (action.kind === "ask" || action.kind === "challenge" || action.kind === "reply") {
          const messageId = `${state.sessionId}:s${state.segmentId}:round:${state.roundIndex}:member:${encodeURIComponent(reply.memberId)}:message:${index}`;
          const target =
            action.kind === "reply" ? state.messages.find((item) => item.messageId === action.replyTo)! : undefined;
          next.messages.push({
            messageId,
            authorId: reply.memberId,
            recipientId: target?.authorId ?? ("recipientId" in action ? action.recipientId : ""),
            kind: action.kind,
            ...(action.kind === "reply" ? { replyTo: action.replyTo } : { target: structuredClone(action.target) }),
            rationale: action.rationale,
            sourceRefs: action.sourceRefs.map((ref) => ({ ...ref })),
            segmentId: state.segmentId,
            roundIndex: state.roundIndex,
            respondedBy: []
          });
          if (target) next.messages.find((item) => item.messageId === target.messageId)!.respondedBy.push(messageId);
        }
        if (action.kind === "object")
          next.objections.push({
            ...action.objection,
            objectionId: `${state.sessionId}:s${state.segmentId}:round:${state.roundIndex}:member:${encodeURIComponent(reply.memberId)}:objection:${index}`,
            authorId: reply.memberId,
            segmentId: state.segmentId,
            roundIndex: state.roundIndex
          });
      }
      next.answerVersions.push(
        AnswerVersionSchema.parse(createRevisedAnswerVersion(state, reply.memberId, turn.answer))
      );
    }
    if (turn.phase === "review") {
      const epoch = next.reviewEpochs.at(-1)!;
      epoch.reviews.push({ memberId: reply.memberId, turn: DiscussionReviewTurnSchema.parse(turn) });
      for (const position of turn.positions)
        if (
          position.kind === "objection" &&
          epoch.objections.find((item) => item.objectionId === position.objectionId)!.authorId === reply.memberId
        )
          next.objectionResolutions.push({
            objectionId: position.objectionId,
            authorId: reply.memberId,
            status: position.status!,
            epochId: epoch.epochId
          });
    }
  }
  next.committedBatches.push({
    snapshotId: batch.snapshotId,
    phase: state.phase,
    roundIndex: state.roundIndex,
    replies: replies.map((reply) => SealedDiscussionReplySchema.parse(reply))
  });
  if (state.phase === "opening") {
    next.phase = "discussion";
    next.roundIndex = 1;
  } else if (state.phase === "discussion") next.roundIndex++;
  else next.reviewEpochs.at(-1)!.status = "committed";
  delete next.pendingBatch;
  next.committedSeq++;
  next.revision++;
  return freezeDiscussionValue(next);
}
export function commitSealedDiscussionBatch(state: DiscussionSession): DiscussionSession {
  return commitUnchecked(parseDiscussionSession(state));
}
export function applyDiscussionBatch(state: DiscussionSession, replies: readonly DiscussionReply[]): DiscussionSession {
  let next = parseDiscussionSession(state);
  exactRoster(
    next.memberIds,
    replies.map((reply) => reply.memberId)
  );
  if (next.pendingBatch) throw new Error("Commit existing seals instead of replacing them");
  for (const reply of replies) next = sealUnchecked(next, reply);
  return commitUnchecked(next);
}
function freezeCheckpointUnchecked(state: DiscussionSession): DiscussionSession {
  if (state.phase !== "discussion" || state.roundIndex < 2 || state.pendingBatch)
    throw new Error("A review checkpoint requires a committed discussion round and no pending batch");
  if ((state.reviewEpochs.at(-1)?.roundIndex ?? 0) >= state.roundIndex - 1)
    throw new Error("At most one review checkpoint per discussion round");
  const next = copy(state);
  const frozen = {
    epochId: state.reviewEpochs.length + 1,
    contextHash: contextHash(state),
    segmentId: state.segmentId,
    contextVersion: state.contextVersion,
    roundIndex: state.roundIndex - 1,
    expectedMembers: [...state.memberIds],
    claimVersions: activeDiscussionClaims(state),
    answerVersions: latestDiscussionAnswers(state),
    objections: activeDiscussionObjections(state)
  };
  const epoch = {
    ...frozen,
    reviewSetHash: discussionReviewSetHash(state.sessionId, frozen),
    status: "pending" as const,
    reviews: []
  };
  next.reviewEpochs.push(ReviewEpochSchema.parse(epoch));
  next.phase = "review";
  next.revision++;
  return freezeDiscussionValue(next);
}
export function freezeDiscussionReview(state: DiscussionSession): DiscussionSession {
  return freezeCheckpointUnchecked(parseDiscussionSession(state));
}
function resumeUnchecked(state: DiscussionSession): DiscussionSession {
  if (state.phase !== "review" || state.reviewEpochs.at(-1)?.status !== "committed" || state.pendingBatch)
    throw new Error("Only a complete committed review can return to discussion");
  const next = copy(state);
  next.phase = "discussion";
  next.revision++;
  return freezeDiscussionValue(next);
}
export function resumeDiscussionAfterReview(state: DiscussionSession): DiscussionSession {
  return resumeUnchecked(parseDiscussionSession(state));
}

/** Strict structural parse plus replay: disk or caller edits cannot invent versions,
 * ownership, frozen checkpoints, sealed replies or half-committed domain changes. */
export function parseDiscussionSession(raw: unknown): DiscussionSession {
  const parsed = DiscussionSessionSchema.parse(raw);
  let replay = initial({
    sessionId: parsed.sessionId,
    segmentId: parsed.segmentId,
    contextVersion: parsed.contextVersion,
    question: parsed.question,
    constraints: parsed.constraints,
    memberIds: parsed.memberIds,
    policy: parsed.policy,
    sources: parsed.sources.map(({ sourceId, name, content }) => ({
      sourceId,
      ...(name === undefined ? {} : { name }),
      content
    }))
  });
  for (const batch of parsed.committedBatches) {
    if (batch.phase === "review") replay = freezeCheckpointUnchecked(replay);
    else if (replay.phase === "review") replay = resumeUnchecked(replay);
    if (
      batch.phase !== replay.phase ||
      batch.roundIndex !== replay.roundIndex ||
      batch.snapshotId !== discussionSnapshotId(replay)
    )
      throw new Error("Corrupt committed discussion snapshot");
    exactRoster(
      replay.memberIds,
      batch.replies.map((reply) => reply.memberId)
    );
    for (const reply of batch.replies) {
      validateSeal(replay, reply);
      replay = sealUnchecked(replay, {
        memberId: reply.memberId,
        snapshotId: reply.snapshotId,
        payload: reply.payload
      });
    }
    replay = commitUnchecked(replay);
  }
  if (parsed.phase === "review" && replay.phase !== "review") replay = freezeCheckpointUnchecked(replay);
  if (parsed.phase === "discussion" && replay.phase === "review") replay = resumeUnchecked(replay);
  if (parsed.pendingBatch) {
    exactRoster(parsed.memberIds, parsed.pendingBatch.expectedMembers);
    if (
      parsed.pendingBatch.snapshotId !== discussionSnapshotId(replay) ||
      parsed.pendingBatch.phase !== replay.phase ||
      !parsed.pendingBatch.sealedReplies.length
    )
      throw new Error("Corrupt pending batch identity");
    for (const reply of parsed.pendingBatch.sealedReplies) {
      validateSeal(replay, reply);
      replay = sealUnchecked(replay, {
        memberId: reply.memberId,
        snapshotId: reply.snapshotId,
        payload: reply.payload
      });
    }
  }
  if (parsed.revision < replay.revision || !same({ ...parsed, revision: 0 }, { ...replay, revision: 0 }))
    throw new Error("Corrupt discussion state or immutable history");
  // An enclosing durable writer may advance revisions for metadata; it never
  // changes the committed semantic snapshot or replaces a frozen model input.
  return freezeDiscussionValue({ ...replay, revision: parsed.revision });
}
/** All-member coverage is a pure input to the stage 1 review reservation API. */
export function discussionReviewItemCounts(state: DiscussionSession): Record<string, number> {
  const snapshot = sharedDiscussionSnapshot(parseDiscussionSession(state));
  const covered = snapshot.reviewEpoch ?? snapshot;
  const count = covered.claimVersions.length + covered.answerVersions.length + covered.objections.length;
  return Object.fromEntries(state.memberIds.map((id) => [id, count]));
}
