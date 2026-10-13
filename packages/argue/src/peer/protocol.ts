import {
  MEMBER_IDS,
  MemberReplySchema,
  PeerTurnSchema,
  SessionConfigInputSchema,
  ContextSourceInputSchema,
  type ClaimDraft,
  type ClaimVersion,
  type ContextSourceInput,
  type MemberId,
  type MemberReply,
  type PeerAction,
  type PeerMessage,
  type PeerSession,
  type RoundPair,
  type SessionConfigInput,
  type SourceRef,
  type ValidatedMemberReply
} from "./contracts.js";
import { buildMemberRequest, currentSegment, peerSnapshotId } from "./context.js";
import { hashJson, sha256 } from "./hash.js";

export function activeClaimVersions(state: PeerSession): ClaimVersion[] {
  const latest = new Map<string, ClaimVersion>();
  for (const version of state.claimVersions) latest.set(version.claimId, version);
  return [...latest.values()].filter((v) => !v.withdrawn);
}
export function createPeerSession(input: SessionConfigInput, sourceInputs: ContextSourceInput[] = []): PeerSession {
  const config = SessionConfigInputSchema.parse(input);
  const sources = sourceInputs.map((input) => {
    const source = ContextSourceInputSchema.parse(input);
    return { ...source, contentHash: sha256(source.content), lineCount: source.content.split("\n").length };
  });
  if (new Set(sources.map((s) => s.sourceId)).size !== sources.length) throw new Error("Duplicate source IDs");
  if (sources.some((s) => s.segmentId !== 1)) throw new Error("Initial sources must belong to segment 1");
  if (sources.reduce((n, s) => n + s.content.length, 0) > config.limits.maxSourceCharacters)
    throw new Error("Source character limit exceeded");
  const state: PeerSession = {
    config,
    revision: 0,
    eventSeq: 0,
    status: "active",
    currentSegmentId: 1,
    sources,
    segments: [
      {
        segmentId: 1,
        phase: "opening",
        roundIndex: 0,
        snapshotId: "pending",
        expectedMembers: [...MEMBER_IDS],
        status: "active",
        startedAt: config.createdAt,
        deadline: new Date(Date.parse(config.createdAt) + config.limits.segmentTimeoutMs).toISOString(),
        minDiscussionRounds: config.limits.minDiscussionRounds,
        maxDiscussionRounds: config.limits.maxDiscussionRounds,
        maxCalls: config.limits.maxCalls,
        reviewVersions: [],
        reviews: []
      }
    ],
    claimVersions: [],
    messages: [],
    rounds: [],
    jobs: [],
    attempts: [],
    events: []
  };
  currentSegment(state).snapshotId = peerSnapshotId(state);
  return state;
}
const otherMember = (memberId: MemberId): MemberId => (memberId === "member-a" ? "member-b" : "member-a");
function validateSourceRefs(state: PeerSession, refs: SourceRef[]) {
  for (const ref of refs) {
    const source = state.sources.find((s) => s.sourceId === ref.sourceId);
    if (!source || ref.startLine > ref.endLine || ref.endLine > source.lineCount)
      throw new Error("Invalid copied source reference or line range");
  }
}
function versionAt(state: PeerSession, versionId: string): ClaimVersion {
  const version = state.claimVersions.find((v) => v.versionId === versionId);
  if (!version) throw new Error(`Unknown frozen version: ${versionId}`);
  return version;
}
function messageAt(state: PeerSession, messageId: string): PeerMessage {
  const message = state.messages.find((m) => m.messageId === messageId);
  if (!message) throw new Error(`Unknown frozen message: ${messageId}`);
  return message;
}
export function pendingPeerMessages(state: PeerSession, recipientId?: MemberId): PeerMessage[] {
  return state.messages.filter(
    (m) =>
      m.kind !== "reply" && m.respondedBy.length === 0 && (recipientId === undefined || m.recipientId === recipientId)
  );
}
function validateDraft(state: PeerSession, draft: ClaimDraft) {
  validateSourceRefs(state, draft.sourceRefs);
  if (draft.alternativeToVersionId) versionAt(state, draft.alternativeToVersionId);
}
function validateActions(state: PeerSession, memberId: MemberId, actions: PeerAction[]) {
  if (actions.filter((a) => a.kind === "propose").length > 1)
    throw new Error("Proposal limit is 1 per member per batch");
  if (actions.filter((a) => a.kind === "challenge" || a.kind === "ask").length > 2)
    throw new Error("Challenge/ask limit is 2 per member per batch");
  const modified = new Set<string>();
  const replies = new Set<string>();
  for (const action of actions) {
    if ("sourceRefs" in action) validateSourceRefs(state, action.sourceRefs);
    if (action.kind === "propose" || action.kind === "revise") validateDraft(state, action);
    if (action.kind === "revise" || action.kind === "withdraw") {
      const target = versionAt(state, action.targetVersionId);
      if (target.authorId !== memberId) throw new Error("Only the author can change their own claim");
      if (!activeClaimVersions(state).some((v) => v.versionId === target.versionId))
        throw new Error("Only the latest current active version can change");
      if (modified.has(target.claimId))
        throw new Error("Duplicate modification: a claim may change only once in a batch");
      modified.add(target.claimId);
    }
    if (action.kind === "challenge" && versionAt(state, action.targetVersionId).authorId === memberId)
      throw new Error("A challenge must target the peer's claim");
    if (action.kind === "ask") {
      const target =
        "versionId" in action.target
          ? versionAt(state, action.target.versionId)
          : messageAt(state, action.target.messageId);
      if (target.authorId === memberId) throw new Error("Ask must target the other member");
    }
    if (action.kind === "reply") {
      const target = messageAt(state, action.replyTo);
      if (target.kind === "reply" || target.recipientId !== memberId || target.respondedBy.length > 0)
        throw new Error("Reply must answer a pending directed question/challenge");
      if (replies.has(target.messageId)) throw new Error("Duplicate reply");
      replies.add(target.messageId);
    }
  }
  if (pendingPeerMessages(state, memberId).some((m) => !replies.has(m.messageId)))
    throw new Error("Each pending directed message requires exactly one reply");
}
/** Validate against committed protocol context only; sealing/attempt metadata is invisible. */
export function validateMemberReply(state: PeerSession, candidate: MemberReply): ValidatedMemberReply {
  const envelope = MemberReplySchema.parse(candidate);
  const request = buildMemberRequest(state, envelope.memberId);
  if (envelope.snapshotId !== request.snapshotId) throw new Error("Stale snapshot ID");
  if (envelope.jobId !== request.jobId) throw new Error("Stale job ID");
  if (envelope.inputHash !== request.inputHash) throw new Error("Frozen input hash mismatch");
  const payload = PeerTurnSchema.parse(envelope.payload);
  if (payload.phase !== request.phase) throw new Error("Wrong phase for frozen snapshot");
  for (const evidence of payload.evidenceRequests)
    if (evidence.targetVersionId) versionAt(state, evidence.targetVersionId);
  if (payload.phase === "opening") for (const draft of payload.claims) validateDraft(state, draft);
  if (payload.phase === "discussion") validateActions(state, envelope.memberId, payload.actions);
  if (payload.phase === "review") {
    const segment = currentSegment(state);
    if (payload.reviewSetHash !== segment.reviewSetHash) throw new Error("Review set hash mismatch");
    const ids = payload.positions.map((p) => p.versionId);
    if (
      ids.length !== segment.reviewVersions.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !segment.reviewVersions.includes(id))
    )
      throw new Error("Review coverage must include every frozen version exactly once");
    for (const position of payload.positions) validateSourceRefs(state, position.sourceRefs);
  }
  return { ...envelope, payload };
}
function propose(state: PeerSession, memberId: MemberId, draft: ClaimDraft) {
  const segment = currentSegment(state);
  const sequence = new Set(state.claimVersions.filter((v) => v.authorId === memberId).map((v) => v.claimId)).size + 1;
  const claimId = `segment-${segment.segmentId}:${memberId}:claim-${sequence}`;
  const content: ClaimDraft = {
    statement: draft.statement,
    rationale: draft.rationale,
    assumptions: structuredClone(draft.assumptions),
    sourceRefs: structuredClone(draft.sourceRefs),
    ...(draft.alternativeToVersionId === undefined ? {} : { alternativeToVersionId: draft.alternativeToVersionId })
  };
  state.claimVersions.push({
    ...content,
    claimId,
    versionId: `${claimId}:v1`,
    authorId: memberId,
    segmentId: segment.segmentId,
    roundIndex: segment.roundIndex,
    version: 1,
    withdrawn: false
  });
}
function applyAction(
  state: PeerSession,
  original: PeerSession,
  memberId: MemberId,
  action: PeerAction,
  actionIndex: number
) {
  const segment = currentSegment(state);
  if (action.kind === "propose") {
    propose(state, memberId, action);
    return;
  }
  if (action.kind === "revise" || action.kind === "withdraw") {
    const prior = versionAt(original, action.targetVersionId);
    const version = prior.version + 1;
    const updated: ClaimVersion = {
      ...prior,
      ...(action.kind === "revise"
        ? {
            statement: action.statement,
            rationale: action.rationale,
            assumptions: structuredClone(action.assumptions),
            sourceRefs: structuredClone(action.sourceRefs),
            ...(action.alternativeToVersionId === undefined
              ? {}
              : { alternativeToVersionId: action.alternativeToVersionId })
          }
        : { withdrawalReason: action.rationale }),
      version,
      versionId: `${prior.claimId}:v${version}`,
      previousVersionId: prior.versionId,
      segmentId: segment.segmentId,
      roundIndex: segment.roundIndex,
      withdrawn: action.kind === "withdraw"
    };
    state.claimVersions.push(updated);
    return;
  }
  const messageId = `segment-${segment.segmentId}:round-${segment.roundIndex}:${memberId}:message-${actionIndex + 1}`;
  const message: PeerMessage = {
    messageId,
    authorId: memberId,
    recipientId: otherMember(memberId),
    segmentId: segment.segmentId,
    roundIndex: segment.roundIndex,
    kind: action.kind,
    rationale: action.rationale,
    sourceRefs: structuredClone(action.sourceRefs),
    respondedBy: []
  };
  if (action.kind === "challenge") message.targetVersionId = action.targetVersionId;
  if (action.kind === "ask") {
    if ("versionId" in action.target) message.targetVersionId = action.target.versionId;
    else message.targetMessageId = action.target.messageId;
  }
  if (action.kind === "reply") {
    message.replyTo = action.replyTo;
    state.messages.find((m) => m.messageId === action.replyTo)!.respondedBy.push(messageId);
  }
  state.messages.push(message);
}
function freezeReview(state: PeerSession) {
  const segment = currentSegment(state);
  segment.phase = "review";
  segment.reviewVersions = activeClaimVersions(state)
    .map((v) => v.versionId)
    .sort();
  segment.reviewSetHash = hashJson({
    segmentId: segment.segmentId,
    versions: segment.reviewVersions.map((id) => versionAt(state, id))
  });
  if (segment.reviewVersions.length === 0) {
    segment.status = "completed";
    segment.completionReason = "no_active_claims";
    state.status = "completed";
  }
}
export function applyRoundPair(state: PeerSession, replies: RoundPair): PeerSession {
  if (
    replies.length !== 2 ||
    new Set(replies.map((r) => r.memberId)).size !== 2 ||
    MEMBER_IDS.some((id) => !replies.some((r) => r.memberId === id))
  )
    throw new Error("A pair requires both fixed members exactly once");
  // Validate both fully against original state before applying either. Never rebase peer refs.
  const validated = MEMBER_IDS.map((id) => validateMemberReply(state, replies.find((r) => r.memberId === id)!));
  const next = structuredClone(state);
  const segment = currentSegment(next);
  const phase = segment.phase;
  for (const reply of validated) {
    if (reply.payload.phase === "opening")
      for (const draft of reply.payload.claims) propose(next, reply.memberId, draft);
    if (reply.payload.phase === "discussion")
      reply.payload.actions.forEach((action, i) => applyAction(next, state, reply.memberId, action, i));
    if (reply.payload.phase === "review")
      segment.reviews.push({ ...reply.payload, memberId: reply.memberId, segmentId: segment.segmentId });
  }
  next.rounds.push({
    segmentId: segment.segmentId,
    roundIndex: segment.roundIndex,
    phase,
    snapshotId: segment.snapshotId,
    replies: validated
  });
  next.status = "active";
  delete next.pauseReason;
  if (phase === "opening") {
    segment.phase = "discussion";
    segment.roundIndex = 1;
  }
  if (phase === "discussion") {
    const ready = validated.every((r) => r.payload.phase === "discussion" && r.payload.readyToReview);
    if (
      segment.roundIndex >= segment.maxDiscussionRounds ||
      (segment.roundIndex >= segment.minDiscussionRounds && ready && pendingPeerMessages(next).length === 0)
    )
      freezeReview(next);
    else segment.roundIndex++;
  }
  if (phase === "review") {
    segment.status = "completed";
    segment.completionReason = "reviewed";
    next.status = "completed";
  }
  next.revision = state.revision + 1;
  segment.snapshotId = peerSnapshotId(next);
  return next;
}
