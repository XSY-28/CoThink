import {
  applyRoundPair,
  buildMemberRequest,
  createPeerSession,
  type Assessment,
  type ClaimDraft,
  type ClaimVersion,
  type DiscussionTurn,
  type MemberId,
  type MemberReply,
  type OpeningTurn,
  type PeerAction,
  type PeerSession,
  type PeerTurn,
  type ReviewTurn,
  type RoundPair,
  type SessionConfigInput
} from "../../src/index.js";

const provider = (modelId: string) => ({
  protocol: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  modelId,
  apiKeyEnv: "TEST_API_KEY",
  outputMode: "json_object" as const,
  generationOptions: { temperature: 0.4 }
});

export function makeConfig(sessionId = "session-test"): SessionConfigInput {
  return {
    sessionId,
    schemaVersion: 1,
    members: { "member-a": provider("a"), "member-b": provider("b") },
    question: "Which option?",
    goal: "Choose carefully",
    constraints: ["Local only"],
    sourceCommit: "baseline",
    promptVersion: "peer-v1",
    createdAt: "2026-10-13T00:00:00.000Z"
  };
}

export function makeClaimDraft(statement = "Choose A"): ClaimDraft {
  return {
    statement,
    rationale: "Fits the goal",
    assumptions: ["Caveat applies"],
    sourceRefs: [{ sourceId: "source-1", startLine: 1, endLine: 2 }]
  };
}

/** Expected opening version; makeSession constructs it through the real reducer. */
export function makeClaim(memberId: MemberId, statement: string, sequence = 1): ClaimVersion {
  const claimId = `segment-1:${memberId}:claim-${sequence}`;
  return {
    ...makeClaimDraft(statement),
    claimId,
    versionId: `${claimId}:v1`,
    authorId: memberId,
    segmentId: 1,
    roundIndex: 0,
    version: 1,
    withdrawn: false
  };
}

export function makeOpeningTurn(claims: ClaimDraft[] = []): OpeningTurn {
  return { phase: "opening", claims, conclusion: "Opening position", evidenceRequests: [] };
}

export function makeDiscussionTurn(actions: PeerAction[] = [], readyToReview = false): DiscussionTurn {
  return { phase: "discussion", actions, readyToReview, conclusion: "My position", evidenceRequests: [] };
}

export function makeReviewTurn(state: PeerSession, stances: Assessment[]): ReviewTurn {
  const segment = state.segments.find((s) => s.segmentId === state.currentSegmentId)!;
  if (stances.length !== segment.reviewVersions.length || !segment.reviewSetHash) {
    throw new Error("Review fixture requires exactly one stance per frozen version");
  }
  return {
    phase: "review",
    reviewSetHash: segment.reviewSetHash,
    positions: segment.reviewVersions.map((versionId, index) => ({
      versionId,
      stance: stances[index]!,
      rationale: "My evaluation",
      sourceRefs: []
    })),
    conclusion: "Final signed position",
    evidenceRequests: []
  };
}

export function envelope(state: PeerSession, memberId: MemberId, payload: unknown): MemberReply {
  const request = buildMemberRequest(state, memberId);
  return { memberId, jobId: request.jobId, snapshotId: request.snapshotId, inputHash: request.inputHash, payload };
}

export function makePairFromTurns(state: PeerSession, a: unknown, b: unknown): RoundPair {
  return [envelope(state, "member-a", a), envelope(state, "member-b", b)];
}

export function makeTurn(state: PeerSession, memberId: MemberId, actions: PeerAction[] = []): MemberReply {
  return envelope(state, memberId, makeDiscussionTurn(actions));
}

export function makePair(_state: PeerSession, a: MemberReply, b: MemberReply): RoundPair {
  return [a, b];
}

type Positions = Record<string, Assessment>;

/** Rejects incomplete fixture input so coverage tests must choose the explicit unsafe helper below. */
export function makeReview(state: PeerSession, memberId: MemberId, positions: Positions): MemberReply {
  const segment = state.segments.find((s) => s.segmentId === state.currentSegmentId)!;
  if (!segment.reviewSetHash) throw new Error("Session is not in review");
  const keys = Object.keys(positions);
  if (keys.length !== segment.reviewVersions.length || keys.some((key) => !segment.reviewVersions.includes(key))) {
    throw new Error("Use makeIncompleteReview to test missing or extra positions");
  }
  return makeIncompleteReview(state, memberId, positions);
}

/** Structurally valid review payload that deliberately bypasses fixture coverage checking. */
export function makeIncompleteReview(state: PeerSession, memberId: MemberId, partialPositions: Positions): MemberReply {
  const segment = state.segments.find((s) => s.segmentId === state.currentSegmentId)!;
  if (!segment.reviewSetHash) throw new Error("Session is not in review");
  return envelope(state, memberId, {
    phase: "review",
    reviewSetHash: segment.reviewSetHash,
    positions: Object.entries(partialPositions).map(([versionId, stance]) => ({
      versionId,
      stance,
      rationale: "My evaluation",
      sourceRefs: []
    })),
    conclusion: "Final signed position",
    evidenceRequests: []
  } satisfies ReviewTurn);
}

interface SessionOptions {
  phase?: "opening" | "discussion" | "review";
  claims?: ClaimVersion[];
  claimCount?: number;
  sessionId?: string;
}

/** Use real state transitions to construct a deterministic opening, discussion, or review snapshot. */
export function makeSession(options: SessionOptions = {}): PeerSession {
  if (options.claims && options.claimCount !== undefined) throw new Error("Choose claims or claimCount");
  const defaultCount = options.phase === "review" ? 2 : 0;
  const count = options.claimCount ?? defaultCount;
  if (!Number.isInteger(count) || count < 0 || count > 6)
    throw new Error("Opening claim count must be between 0 and 6");
  const claims =
    options.claims ??
    Array.from({ length: count }, (_, index) =>
      makeClaim(index % 2 === 0 ? "member-a" : "member-b", `Claim ${index + 1}`, Math.floor(index / 2) + 1)
    );
  let state = createPeerSession(makeConfig(options.sessionId), [
    { sourceId: "source-1", content: "Option A\nA caveat", segmentId: 1 }
  ]);
  if ((options.phase ?? "opening") === "opening") return state;
  const a = claims
    .filter((c) => c.authorId === "member-a")
    .map(({ statement, rationale, assumptions, sourceRefs, alternativeToVersionId }) => ({
      statement,
      rationale,
      assumptions,
      sourceRefs,
      ...(alternativeToVersionId === undefined ? {} : { alternativeToVersionId })
    }));
  const b = claims
    .filter((c) => c.authorId === "member-b")
    .map(({ statement, rationale, assumptions, sourceRefs, alternativeToVersionId }) => ({
      statement,
      rationale,
      assumptions,
      sourceRefs,
      ...(alternativeToVersionId === undefined ? {} : { alternativeToVersionId })
    }));
  state = applyRoundPair(state, makePairFromTurns(state, makeOpeningTurn(a), makeOpeningTurn(b)));
  if (options.claims) {
    const expectedIds = [
      ...claims.filter((c) => c.authorId === "member-a"),
      ...claims.filter((c) => c.authorId === "member-b")
    ].map((c) => c.versionId);
    const actualIds = state.claimVersions.map((c) => c.versionId);
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
      throw new Error("Supplied claim IDs do not match the constructed opening order");
    }
  }
  if (options.phase === "discussion") return state;
  while (state.segments[0]!.phase === "discussion") {
    state = applyRoundPair(state, makePairFromTurns(state, makeDiscussionTurn(), makeDiscussionTurn()));
  }
  return state;
}

// Keep the phase union visible to consumers composing scripted runtime payloads.
export type FixtureTurn = PeerTurn;
