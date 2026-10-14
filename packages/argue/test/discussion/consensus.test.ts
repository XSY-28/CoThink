import { describe, expect, it } from "vitest";
import { evaluateConsensus, currentCompleteReview, isRelevantObjection } from "../../src/discussion/consensus.js";
import { latestDiscussionAnswers, activeDiscussionClaims } from "../../src/discussion/answers.js";
import {
  applyDiscussionBatch,
  createDiscussionSession,
  freezeDiscussionReview,
  resumeDiscussionAfterReview,
  sealDiscussionReply
} from "../../src/discussion/protocol.js";
import { discussionConstraintContextHash } from "../../src/discussion/result.js";
import type { ConstraintCheck } from "../../src/discussion/result.js";
import type {
  DiscussionSession,
  DiscussionReviewTurn,
  DiscussionProtocolTurn
} from "../../src/discussion/contracts.js";
import {
  discussionEnvelope,
  openedSession,
  exchangeTurn,
  reviewSession,
  reviewTurn,
  stage2Session,
  openingTurn
} from "./stage2-fixtures.js";

type Exchange = Extract<DiscussionProtocolTurn, { phase: "discussion" }>;
function exchange(
  state: DiscussionSession,
  edit: (turn: Exchange, id: string) => Exchange = (turn) => turn
): DiscussionSession {
  return applyDiscussionBatch(
    state,
    state.memberIds.map((id) => discussionEnvelope(state, id, edit(exchangeTurn(state, id), id)))
  );
}
function reviewed(
  state: DiscussionSession = reviewSession(),
  edit: (turn: DiscussionReviewTurn, id: string) => DiscussionReviewTurn = (turn) => turn
): DiscussionSession {
  return applyDiscussionBatch(
    state,
    state.memberIds.map((id) => discussionEnvelope(state, id, edit(reviewTurn(state, id), id)))
  );
}
function check(
  state: DiscussionSession,
  answerVersionId: string | null,
  status: "passed" | "failed" = "failed"
): ConstraintCheck {
  return {
    checkId: "host-check",
    source: "host",
    contextHash: discussionConstraintContextHash(state),
    answerVersionId,
    status,
    evidence: "Reproducible local constraint check"
  };
}
function objectionState(
  target: "answer" | "claim" = "answer",
  memberIds: readonly string[] = ["a", "b"]
): DiscussionSession {
  const state = openedSession(memberIds);
  const answer = latestDiscussionAnswers(state)[0]!;
  return exchange(state, (turn, id) =>
    id !== "b"
      ? turn
      : {
          ...turn,
          actions: [
            {
              kind: "object",
              objection: {
                targetAnswerVersionId: answer.answerVersionId,
                ...(target === "claim" ? { targetClaimVersionId: activeDiscussionClaims(state)[0]!.versionId } : {}),
                severity: "blocking",
                summary: "A concern",
                impact: "Could invalidate the answer",
                evidenceNeeded: "A counterexample check"
              }
            }
          ]
        }
  );
}
function ownerStatus(
  turn: DiscussionReviewTurn,
  id: string,
  status: "retained" | "resolved" | "withdrawn"
): DiscussionReviewTurn {
  return {
    ...turn,
    positions: turn.positions.map((position) =>
      position.kind === "objection" && id === "b" ? { ...position, status } : position
    )
  };
}

describe("deterministic answer consensus", () => {
  it("accepts the same saved answer versions after complete three-member review without mutating state", () => {
    const state = reviewed(reviewSession(["a", "b", "c"]));
    const before = JSON.stringify(state);
    expect(evaluateConsensus(state)).toEqual(latestDiscussionAnswers(state));
    expect(JSON.stringify(state)).toBe(before);
    expect(currentCompleteReview(state)?.epochId).toBe(1);
  });
  it.each(["reject", "uncertain"] as const)("one %s vote blocks that exact answer", (stance) => {
    const pending = reviewSession();
    const candidate = latestDiscussionAnswers(pending)[0]!;
    const state = reviewed(pending, (turn, id) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        id === "b" && position.kind === "answer" && position.answerVersionId === candidate.answerVersionId
          ? { ...position, stance }
          : position
      )
    }));
    expect(evaluateConsensus(state).map((item) => item.authorId)).toEqual(["b"]);
  });
  it("high decision weight never substitutes for the other member's vote", () => {
    let state = createDiscussionSession({
      sessionId: "high-preference",
      question: "Which proposal?",
      memberIds: ["a", "b"],
      policy: {
        effort: "standard",
        weights: {
          a: { participationWeight: 1, decisionWeight: 100 },
          b: { participationWeight: 1, decisionWeight: 1 }
        }
      }
    });
    state = applyDiscussionBatch(
      state,
      state.memberIds.map((id) => discussionEnvelope(state, id, openingTurn()))
    );
    const pending = freezeDiscussionReview(exchange(state));
    const result = reviewed(pending, (turn, id) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        id === "b" && position.kind === "answer" ? { ...position, stance: "reject" } : position
      )
    }));
    expect(evaluateConsensus(result)).toEqual([]);
  });
  it("similar or identical bodies do not merge votes across independent versions", () => {
    const opened = openedSession();
    const pending = freezeDiscussionReview(
      exchange(opened, (turn) => ({ ...turn, answer: { ...turn.answer, body: "Identical answer" } }))
    );
    const state = reviewed(pending, (turn, id) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        position.kind === "answer"
          ? {
              ...position,
              stance:
                latestDiscussionAnswers(pending).find((answer) => answer.authorId === id)!.answerVersionId ===
                position.answerVersionId
                  ? "accept"
                  : "reject"
            }
          : position
      )
    }));
    expect(evaluateConsensus(state)).toEqual([]);
  });
  it.each(["reject", "uncertain"] as const)("basis %s blocks an otherwise accepted answer", (stance) => {
    const pending = reviewSession();
    const basis = pending.reviewEpochs[0]!.claimVersions[0]!.versionId;
    const state = reviewed(pending, (turn, id) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        id === "b" && position.kind === "claim" && position.versionId === basis ? { ...position, stance } : position
      )
    }));
    expect(evaluateConsensus(state)).toEqual([]);
  });
  it("disagreement about an unused alternative claim does not block consensus", () => {
    const opened = openedSession();
    const used = activeDiscussionClaims(opened)[0]!.versionId;
    const pending = freezeDiscussionReview(
      exchange(opened, (turn) => ({ ...turn, answer: { ...turn.answer, basisVersionIds: [used] } }))
    );
    const state = reviewed(pending, (turn) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        position.kind === "claim" && position.versionId !== used ? { ...position, stance: "reject" } : position
      )
    }));
    expect(evaluateConsensus(state)).toHaveLength(2);
  });
  it("readable historical basis is not accepted by reviewing its replacement", () => {
    const opened = openedSession();
    const oldClaim = activeDiscussionClaims(opened)[0]!;
    const pending = freezeDiscussionReview(
      exchange(opened, (turn, id) => ({
        ...turn,
        actions:
          id === "a"
            ? [
                {
                  kind: "revise",
                  targetVersionId: oldClaim.versionId,
                  claim: { statement: "New claim", rationale: "Changed evidence", assumptions: [], sourceRefs: [] }
                }
              ]
            : []
      }))
    );
    expect(pending.reviewEpochs[0]!.claimVersions.some((claim) => claim.versionId === oldClaim.versionId)).toBe(false);
    expect(evaluateConsensus(reviewed(pending))).toEqual([]);
  });
  it("empty basis cannot produce vacuous consensus", () => {
    const pending = freezeDiscussionReview(
      exchange(openedSession(), (turn) => ({ ...turn, answer: { ...turn.answer, basisVersionIds: [] } }))
    );
    expect(evaluateConsensus(reviewed(pending))).toEqual([]);
  });
  it("empty claim set cannot produce vacuous consensus", () => {
    const initial = stage2Session();
    const opened = applyDiscussionBatch(
      initial,
      initial.memberIds.map((id) =>
        discussionEnvelope(initial, id, {
          ...openingTurn(),
          claims: [],
          answer: { ...openingTurn().answer, basisDraftIndices: [] }
        })
      )
    );
    const pending = freezeDiscussionReview(exchange(opened));
    expect(evaluateConsensus(reviewed(pending))).toEqual([]);
  });
  it("opening and a pending review produce no consensus", () => {
    expect(evaluateConsensus(openedSession())).toEqual([]);
    expect(evaluateConsensus(reviewSession())).toEqual([]);
    expect(currentCompleteReview(reviewSession())).toBeUndefined();
  });
  it("successful half-batch remains sealed and cannot confirm answers", () => {
    const pending = reviewSession();
    const half = sealDiscussionReply(pending, discussionEnvelope(pending, "a", reviewTurn(pending, "a")));
    expect(evaluateConsensus(half)).toEqual([]);
    expect(currentCompleteReview(half)).toBeUndefined();
  });
  it("resuming discussion invalidates the old checkpoint even before revising answers", () => {
    const resumed = resumeDiscussionAfterReview(reviewed());
    expect(evaluateConsensus(resumed)).toEqual([]);
    expect(currentCompleteReview(resumed)).toBeUndefined();
  });
  it("A1 votes cannot confirm A2 until its new checkpoint is complete", () => {
    const state = exchange(resumeDiscussionAfterReview(reviewed()));
    expect(evaluateConsensus(state)).toEqual([]);
    expect(evaluateConsensus(freezeDiscussionReview(state))).toEqual([]);
    expect(evaluateConsensus(reviewed(freezeDiscussionReview(state)))).toEqual(latestDiscussionAnswers(state));
  });
  it.each(["ask", "challenge"] as const)("an unanswered directed %s prevents any consensus", (kind) => {
    const opened = openedSession();
    const pending = freezeDiscussionReview(
      exchange(opened, (turn, id) =>
        id !== "a"
          ? turn
          : {
              ...turn,
              actions: [
                {
                  kind,
                  target: { kind: "answer", answerVersionId: latestDiscussionAnswers(opened)[1]!.answerVersionId },
                  recipientId: "b",
                  rationale: "Explain the caveat",
                  sourceRefs: []
                }
              ]
            }
      )
    );
    expect(evaluateConsensus(reviewed(pending))).toEqual([]);
  });
  it("a committed response permits subsequent consensus", () => {
    const opened = openedSession();
    const asked = exchange(opened, (turn, id) =>
      id !== "a"
        ? turn
        : {
            ...turn,
            actions: [
              {
                kind: "ask",
                target: { kind: "answer", answerVersionId: latestDiscussionAnswers(opened)[1]!.answerVersionId },
                recipientId: "b",
                rationale: "Explain the caveat",
                sourceRefs: []
              }
            ]
          }
    );
    const answered = exchange(asked, (turn, id) =>
      id !== "b"
        ? turn
        : {
            ...turn,
            actions: [
              { kind: "reply", replyTo: asked.messages[0]!.messageId, rationale: "Caveat explained", sourceRefs: [] }
            ]
          }
    );
    expect(evaluateConsensus(reviewed(freezeDiscussionReview(answered)))).toHaveLength(2);
  });
  it.each(["reviewSetHash", "contextHash", "expectedMembers", "answerVersions"] as const)(
    "rejects forged frozen %s rather than interpreting edited history",
    (key) => {
      const state = structuredClone(reviewed());
      const forged = {
        ...state,
        reviewEpochs: state.reviewEpochs.map((epoch) => ({
          ...epoch,
          [key]: key === "expectedMembers" ? ["a"] : key === "answerVersions" ? [] : "forged"
        }))
      };
      expect(() => evaluateConsensus(forged as DiscussionSession)).toThrow();
      expect(() => currentCompleteReview(forged as DiscussionSession)).toThrow();
    }
  );
  it.each(["missing", "duplicate", "reference", "hash"] as const)(
    "rejects %s review corruption through immutable-history replay",
    (corruption) => {
      const state = reviewed();
      const epoch = state.reviewEpochs[0]!;
      const review = epoch.reviews[0]!;
      const positions = review.turn.positions;
      const turn =
        corruption === "hash"
          ? { ...review.turn, reviewSetHash: "wrong" }
          : {
              ...review.turn,
              positions:
                corruption === "missing"
                  ? positions.slice(1)
                  : corruption === "duplicate"
                    ? [...positions, positions[0]!]
                    : positions.map((position, index) =>
                        index === 0 ? { ...position, versionId: "nonexistent" } : position
                      )
            };
      const forged = {
        ...state,
        reviewEpochs: [{ ...epoch, reviews: [{ ...review, turn }, ...epoch.reviews.slice(1)] }]
      };
      expect(() => evaluateConsensus(forged as DiscussionSession)).toThrow();
    }
  );
});

describe("important objection provenance", () => {
  it("retained objections follow the candidate's saved answer ancestry, but not unrelated candidates", () => {
    const state = reviewed(freezeDiscussionReview(objectionState()));
    const [a, b] = latestDiscussionAnswers(state);
    const objection = state.objections[0]!;
    expect(isRelevantObjection(state, a!, objection)).toBe(true);
    expect(isRelevantObjection(state, b!, objection)).toBe(false);
    expect(evaluateConsensus(state).map((answer) => answer.authorId)).toEqual(["b"]);
  });
  it("a retained objection to a shared basis blocks all dependent answers", () => {
    const state = reviewed(freezeDiscussionReview(objectionState("claim")));
    expect(evaluateConsensus(state)).toEqual([]);
  });
  it.each(["resolved", "withdrawn"] as const)(
    "only the original author's current %s status removes the block",
    (status) => {
      const state = reviewed(freezeDiscussionReview(objectionState()), (turn, id) => ownerStatus(turn, id, status));
      expect(evaluateConsensus(state)).toHaveLength(2);
    }
  );
  it("an observer rejecting an objection does not override its owner's retained status", () => {
    const state = reviewed(freezeDiscussionReview(objectionState()), (turn, id) => ({
      ...turn,
      positions: turn.positions.map((position) =>
        position.kind === "objection" ? { ...position, stance: id === "b" ? "accept" : "reject" } : position
      )
    }));
    expect(evaluateConsensus(state).map((answer) => answer.authorId)).toEqual(["b"]);
  });
  it("owner stance and owner resolution status have separate meanings", () => {
    const state = reviewed(freezeDiscussionReview(objectionState()), (turn, id) => ({
      ...ownerStatus(turn, id, "resolved"),
      positions: ownerStatus(turn, id, "resolved").positions.map((position) =>
        position.kind === "objection" ? { ...position, stance: "reject" } : position
      )
    }));
    expect(evaluateConsensus(state)).toHaveLength(2);
  });
  it("an explicit unresolved ID links an objection to another candidate", () => {
    const state = objectionState();
    const pending = freezeDiscussionReview(
      exchange(state, (turn, id) =>
        id !== "b"
          ? turn
          : { ...turn, answer: { ...turn.answer, unresolvedObjectionIds: [state.objections[0]!.objectionId] } }
      )
    );
    expect(evaluateConsensus(reviewed(pending))).toEqual([]);
  });
  it("retained claim objections follow saved basis previous-version links", () => {
    const state = objectionState("claim");
    const claim = activeDiscussionClaims(state)[0]!;
    const revised = exchange(state, (turn, id) =>
      id !== "a"
        ? turn
        : {
            ...turn,
            actions: [
              {
                kind: "revise",
                targetVersionId: claim.versionId,
                claim: { statement: "Changed basis", rationale: "New grounds", assumptions: [], sourceRefs: [] }
              }
            ]
          }
    );
    const current = reviewed(freezeDiscussionReview(exchange(revised)));
    const answerB = latestDiscussionAnswers(current)[1]!;
    expect(answerB.basisVersionIds).not.toContain(claim.versionId);
    expect(isRelevantObjection(current, answerB, current.objections[0]!)).toBe(true);
    expect(evaluateConsensus(current)).toEqual([]);
  });
  it("similar ID prefixes and forged objection data do not create relevance", () => {
    const state = reviewed(freezeDiscussionReview(objectionState()));
    const answer = latestDiscussionAnswers(state)[1]!;
    const objection = state.objections[0]!;
    expect(isRelevantObjection(state, answer, { ...objection, targetAnswerVersionId: answer.answerVersionId })).toBe(
      false
    );
    expect(isRelevantObjection(state, { ...answer, unresolvedObjectionIds: [objection.objectionId] }, objection)).toBe(
      false
    );
    expect(isRelevantObjection(state, answer, { ...objection, objectionId: objection.objectionId + "-similar" })).toBe(
      false
    );
  });
  it("resolved objections remain resolved in later complete checkpoints", () => {
    const first = reviewed(freezeDiscussionReview(objectionState()), (turn, id) => ownerStatus(turn, id, "resolved"));
    const second = reviewed(freezeDiscussionReview(exchange(resumeDiscussionAfterReview(first))));
    expect(second.reviewEpochs.at(-1)!.objections).toEqual([]);
    expect(evaluateConsensus(second)).toHaveLength(2);
  });
});

describe("host constraint evidence", () => {
  it("a known failed answer check blocks only the scoped candidate", () => {
    const state = reviewed();
    expect(
      evaluateConsensus(state, [check(state, latestDiscussionAnswers(state)[0]!.answerVersionId)]).map(
        (answer) => answer.authorId
      )
    ).toEqual(["b"]);
  });
  it("global failure blocks all candidates and passing evidence does not manufacture votes", () => {
    const state = reviewed();
    expect(evaluateConsensus(state, [check(state, null)])).toEqual([]);
    expect(evaluateConsensus(state, [check(state, null, "passed")])).toHaveLength(2);
    const pending = reviewSession();
    expect(evaluateConsensus(pending, [check(pending, null, "passed")])).toEqual([]);
  });
  it.each(["context", "answer", "host"] as const)(
    "rejects unknown or stale %s evidence instead of ignoring it",
    (scope) => {
      const state = reviewed();
      const valid = check(state, null);
      const invalid =
        scope === "context"
          ? { ...valid, contextHash: "stale" }
          : scope === "answer"
            ? { ...valid, answerVersionId: state.answerVersions[0]!.answerVersionId }
            : { ...valid, source: "model" };
      expect(() => evaluateConsensus(state, [invalid as ConstraintCheck])).toThrow();
    }
  );
});
