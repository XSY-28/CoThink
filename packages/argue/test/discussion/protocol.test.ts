import { expect, it } from "vitest";
import {
  applyDiscussionBatch,
  createDiscussionSession,
  parseDiscussionSession,
  validateDiscussionReply,
  sealDiscussionReply,
  commitSealedDiscussionBatch,
  freezeDiscussionReview,
  resumeDiscussionAfterReview,
  discussionReviewItemCounts
} from "../../src/discussion/protocol.js";
import { discussionSnapshotId, sharedDiscussionSnapshot } from "../../src/discussion/context.js";
import {
  latestDiscussionAnswers,
  activeDiscussionClaims,
  activeDiscussionObjections
} from "../../src/discussion/answers.js";
import { DiscussionProtocolTurnSchema } from "../../src/discussion/contracts.js";
import {
  stage2Session,
  openingTurn,
  exchangeTurn,
  reviewTurn,
  discussionEnvelope,
  openedSession,
  exchangedSession,
  reviewSession
} from "./stage2-fixtures.js";

it("resolves opening local draft indices only after full independent batch commit", () => {
  const state = stage2Session(),
    a = discussionEnvelope(state, "a", openingTurn());
  const sealed = sealDiscussionReply(state, a);
  expect(sealed.claimVersions).toEqual([]);
  expect(sealed.answerVersions).toEqual([]);
  expect(sealed.complexities).toEqual({});
  expect(sealed.committedSeq).toBe(0);
  expect(discussionSnapshotId(sealed)).toBe(discussionSnapshotId(state));
  expect(sharedDiscussionSnapshot(sealed)).toEqual(sharedDiscussionSnapshot(state));
  expect(() => commitSealedDiscussionBatch(sealed)).toThrow(/every expected member/i);
  const both = sealDiscussionReply(sealed, discussionEnvelope(state, "b", openingTurn()));
  expect(both.answerVersions).toEqual([]);
  const committed = commitSealedDiscussionBatch(both);
  expect(committed.answerVersions).toHaveLength(2);
  for (const answer of committed.answerVersions)
    expect(answer.basisVersionIds).toEqual(
      committed.claimVersions.filter((claim) => claim.authorId === answer.authorId).map((claim) => claim.versionId)
    );
  expect(committed.complexities).toEqual({ a: "moderate", b: "moderate" });
  expect(Object.isFrozen(committed.answerVersions[0]!.basisVersionIds)).toBe(true);
  expect(parseDiscussionSession(JSON.parse(JSON.stringify(committed)))).toEqual(committed);
});
it("preserves a valid sealed half when the other response is invalid", () => {
  const state = stage2Session(),
    sealed = sealDiscussionReply(state, discussionEnvelope(state, "a", openingTurn()));
  expect(() =>
    sealDiscussionReply(
      sealed,
      discussionEnvelope(state, "b", { ...openingTurn(), answer: { ...openingTurn().answer, basisDraftIndices: [1] } })
    )
  ).toThrow();
  expect(sealed.pendingBatch!.sealedReplies.map((reply) => reply.memberId)).toEqual(["a"]);
  expect(sealed.answerVersions).toEqual([]);
  expect(() => sealDiscussionReply(sealed, discussionEnvelope(state, "a", openingTurn()))).toThrow(/already sealed/i);
});
it.each([{ members: [] }, { members: ["a"] }, { members: ["a", "a"] }, { members: ["a", "c"] }])(
  "rejects incomplete or wrong-roster batch",
  ({ members }) => {
    const state = stage2Session();
    expect(() =>
      applyDiscussionBatch(
        state,
        members.map((id) => discussionEnvelope(state, id, openingTurn()))
      )
    ).toThrow();
  }
);
it.each([undefined, "discussion", "review"])("rejects opening phase omission or substitution", (phase) => {
  const state = stage2Session(),
    turn = { ...openingTurn(), phase };
  expect(() => validateDiscussionReply(state, discussionEnvelope(state, "a", turn))).toThrow();
});
it("rejects unknown global IDs, source ranges and spoofed author fields", () => {
  const state = stage2Session(),
    turn = openingTurn();
  for (const payload of [
    { ...turn, answer: { ...turn.answer, basisVersionIds: ["fake"] } },
    { ...turn, answer: { ...turn.answer, authorId: "b" } },
    { ...turn, claims: [{ ...turn.claims[0], sourceRefs: [{ sourceId: "source-1", startLine: 1, endLine: 3 }] }] },
    { ...turn, claims: [{ ...turn.claims[0], sourceRefs: [{ sourceId: "source-1", startLine: 2, endLine: 1 }] }] }
  ])
    expect(() => validateDiscussionReply(state, discussionEnvelope(state, "a", payload))).toThrow();
});
it("rejects peer-owned answer/claim edits even for a high-weight member", () => {
  let state = openedSession();
  const bAnswer = latestDiscussionAnswers(state).find((answer) => answer.authorId === "b")!,
    bClaim = activeDiscussionClaims(state).find((claim) => claim.authorId === "b")!;
  expect(() =>
    validateDiscussionReply(
      state,
      discussionEnvelope(state, "a", {
        ...exchangeTurn(state, "a"),
        answer: { ...exchangeTurn(state, "a").answer, previousVersionId: bAnswer.answerVersionId }
      })
    )
  ).toThrow(/author/i);
  for (const action of [
    { kind: "revise", targetVersionId: bClaim.versionId, claim: openingTurn().claims[0]! },
    { kind: "withdraw", targetVersionId: bClaim.versionId, rationale: "Override" }
  ] as const)
    expect(() =>
      validateDiscussionReply(state, discussionEnvelope(state, "a", exchangeTurn(state, "a", [action])))
    ).toThrow(/author/i);
  const high = createDiscussionSession({
    sessionId: "high",
    question: "Q",
    memberIds: ["a", "b"],
    policy: {
      weights: {
        a: { decisionWeight: 100, participationWeight: 100 },
        b: { decisionWeight: 0.1, participationWeight: 0.1 }
      }
    }
  });
  state = applyDiscussionBatch(
    high,
    ["a", "b"].map((id) => discussionEnvelope(high, id, openingTurn()))
  );
  expect(() =>
    validateDiscussionReply(
      state,
      discussionEnvelope(state, "a", {
        ...exchangeTurn(state, "a"),
        answer: {
          ...exchangeTurn(state, "a").answer,
          previousVersionId: latestDiscussionAnswers(state)[1]!.answerVersionId
        }
      })
    )
  ).toThrow(/author/i);
});
it("never rebases same-batch references or permits future proposed claim IDs", () => {
  const state = openedSession(),
    own = activeDiscussionClaims(state)[0]!;
  const future = `${state.sessionId}:s1:member:a:claim:2:v1`;
  expect(() =>
    validateDiscussionReply(
      state,
      discussionEnvelope(state, "a", {
        ...exchangeTurn(state, "a", [{ kind: "propose", claim: openingTurn().claims[0]! }]),
        answer: { ...exchangeTurn(state, "a").answer, basisVersionIds: [future] }
      })
    )
  ).toThrow(/basis/i);
  const next = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "revise",
          targetVersionId: own.versionId,
          claim: { ...openingTurn().claims[0]!, statement: "Revised claim" }
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  expect(latestDiscussionAnswers(next).find((answer) => answer.authorId === "b")!.basisVersionIds).toContain(
    own.versionId
  );
  expect(next.claimVersions.find((claim) => claim.versionId === own.versionId)!.statement).toBe("A claim");
  expect(() =>
    validateDiscussionReply(
      next,
      discussionEnvelope(next, "a", {
        ...exchangeTurn(next, "a"),
        answer: { ...exchangeTurn(next, "a").answer, basisVersionIds: [own.versionId] }
      })
    )
  ).toThrow(/basis/i);
});
it("rejects withdrawn and unknown frozen references and stale reply snapshots", () => {
  const state = openedSession(),
    own = activeDiscussionClaims(state)[0]!;
  const next = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [{ kind: "withdraw", targetVersionId: own.versionId, rationale: "Retracted" }])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  expect(() =>
    validateDiscussionReply(
      next,
      discussionEnvelope(next, "a", {
        ...exchangeTurn(next, "a"),
        answer: { ...exchangeTurn(next, "a").answer, basisVersionIds: [own.versionId] }
      })
    )
  ).toThrow();
  expect(() => validateDiscussionReply(next, discussionEnvelope(state, "a", exchangeTurn(state, "a")))).toThrow(
    /snapshot/i
  );
});
it("requires each directed ask/challenge recipient to reply exactly once", () => {
  const state = openedSession(),
    b = latestDiscussionAnswers(state)[1]!;
  const asked = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "ask",
          target: { kind: "answer", answerVersionId: b.answerVersionId },
          recipientId: "b",
          rationale: "Why?",
          sourceRefs: []
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  const reply = { kind: "reply" as const, replyTo: asked.messages[0]!.messageId, rationale: "Because", sourceRefs: [] };
  expect(() => validateDiscussionReply(asked, discussionEnvelope(asked, "b", exchangeTurn(asked, "b")))).toThrow(
    /reply/i
  );
  expect(() =>
    validateDiscussionReply(asked, discussionEnvelope(asked, "a", exchangeTurn(asked, "a", [reply])))
  ).toThrow(/reply/i);
  expect(() =>
    validateDiscussionReply(asked, discussionEnvelope(asked, "b", exchangeTurn(asked, "b", [reply, reply])))
  ).toThrow();
  const answered = applyDiscussionBatch(asked, [
    discussionEnvelope(asked, "a", exchangeTurn(asked, "a")),
    discussionEnvelope(asked, "b", exchangeTurn(asked, "b", [reply]))
  ]);
  expect(answered.messages[0]!.respondedBy).toHaveLength(1);
});
it("freezes complete review sets for all members and preserves every answer through review", () => {
  const state = reviewSession(["a", "b", "c"]),
    epoch = state.reviewEpochs[0]!;
  expect(epoch.expectedMembers).toEqual(["a", "b", "c"]);
  expect(epoch.claimVersions).toHaveLength(3);
  expect(epoch.answerVersions).toHaveLength(3);
  expect(discussionReviewItemCounts(state)).toEqual({ a: 6, b: 6, c: 6 });
  const sealed = sealDiscussionReply(state, discussionEnvelope(state, "a", reviewTurn(state, "a")));
  expect(sealed.reviewEpochs[0]!.reviews).toEqual([]);
  expect(sealed.answerVersions).toEqual(state.answerVersions);
  const complete = applyDiscussionBatch(
    state,
    state.memberIds.map((id) => discussionEnvelope(state, id, reviewTurn(state, id)))
  );
  expect(complete.answerVersions).toEqual(state.answerVersions);
  expect(complete.reviewEpochs[0]!.status).toBe("committed");
  expect(complete.reviewEpochs[0]!.reviews).toHaveLength(3);
});
it.each([
  "missing-phase",
  "missing-hash",
  "wrong-hash",
  "missing-positions",
  "missing-slot",
  "duplicate-slot",
  "extra-slot",
  "answer-edit",
  "wrong-namespace"
])("rejects invalid review: %s", (mode) => {
  const state = reviewSession(),
    turn = structuredClone(reviewTurn(state, "a")) as Record<string, unknown>;
  const positions = turn.positions as Record<string, unknown>[];
  if (mode === "missing-phase") delete turn.phase;
  if (mode === "missing-hash") delete turn.reviewSetHash;
  if (mode === "wrong-hash") turn.reviewSetHash = "fake";
  if (mode === "missing-positions") delete turn.positions;
  if (mode === "missing-slot") turn.positions = positions.slice(1);
  if (mode === "duplicate-slot") turn.positions = [positions[0], positions[0], ...positions.slice(2)];
  if (mode === "extra-slot") turn.positions = [...positions, { ...positions[0], versionId: "unknown" }];
  if (mode === "answer-edit") turn.answer = { body: "Rewritten answer" };
  if (mode === "wrong-namespace")
    turn.positions = [
      { ...positions[0], versionId: state.reviewEpochs[0]!.answerVersions[0]!.answerVersionId },
      ...positions.slice(1)
    ];
  expect(() => validateDiscussionReply(state, discussionEnvelope(state, "a", turn))).toThrow();
  expect(state.reviewEpochs[0]!.reviews).toEqual([]);
});
it("creates repeated epochs after a new discussion, invalidating old confirmations and hashes", () => {
  const first = reviewSession();
  const completed = applyDiscussionBatch(
    first,
    first.memberIds.map((id) => discussionEnvelope(first, id, reviewTurn(first, id)))
  );
  const resumed = resumeDiscussionAfterReview(completed);
  expect(() => freezeDiscussionReview(resumed)).toThrow(/one review/i);
  const discussed = applyDiscussionBatch(
    resumed,
    resumed.memberIds.map((id) => discussionEnvelope(resumed, id, exchangeTurn(resumed, id)))
  );
  const second = freezeDiscussionReview(discussed);
  expect(second.reviewEpochs).toHaveLength(2);
  expect(second.reviewEpochs[1]!.reviews).toEqual([]);
  expect(second.reviewEpochs[1]!.reviewSetHash).not.toBe(first.reviewEpochs[0]!.reviewSetHash);
  expect(() => validateDiscussionReply(second, discussionEnvelope(second, "a", reviewTurn(first, "a")))).toThrow(
    /hash/i
  );
  expect(second.reviewEpochs[0]!.reviews).toEqual(completed.reviewEpochs[0]!.reviews);
});
it("cannot start review before mutual exchange, with seals pending, or resume partial review", () => {
  expect(() => freezeDiscussionReview(openedSession())).toThrow();
  const state = exchangedSession(),
    sealed = sealDiscussionReply(state, discussionEnvelope(state, "a", exchangeTurn(state, "a")));
  expect(() => freezeDiscussionReview(sealed)).toThrow();
  expect(() => resumeDiscussionAfterReview(reviewSession())).toThrow();
});
it("only the objection's author can resolve it and all reviewers cover it", () => {
  const state = openedSession(),
    b = latestDiscussionAnswers(state)[1]!;
  const discussed = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "object",
          objection: {
            targetAnswerVersionId: b.answerVersionId,
            severity: "blocking",
            summary: "Concern",
            impact: "Could fail",
            evidenceNeeded: "A check"
          }
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  const frozen = freezeDiscussionReview(discussed),
    turn = reviewTurn(frozen, "b");
  const other = {
    ...turn,
    positions: turn.positions.map((position) =>
      position.kind === "objection" ? { ...position, status: "resolved" } : position
    )
  };
  expect(() => validateDiscussionReply(frozen, discussionEnvelope(frozen, "b", other))).toThrow(/author/i);
  const owner = reviewTurn(frozen, "a"),
    resolved = {
      ...owner,
      positions: owner.positions.map((position) =>
        position.kind === "objection" ? { ...position, status: "resolved" } : position
      )
    };
  const committed = applyDiscussionBatch(frozen, [
    discussionEnvelope(frozen, "a", resolved),
    discussionEnvelope(frozen, "b", turn)
  ]);
  expect(activeDiscussionObjections(committed)).toEqual([]);
  expect(discussionReviewItemCounts(committed)).toEqual({ a: 5, b: 5 });
  expect(committed.objections).toEqual(discussed.objections);
  expect(committed.answerVersions).toEqual(frozen.answerVersions);
});
it("normalizes only omitted empty metadata, never mandatory fields or unknown commentary", () => {
  const turn = JSON.parse(JSON.stringify(openingTurn()));
  delete turn.evidenceRequests;
  delete turn.claims[0].assumptions;
  delete turn.claims[0].sourceRefs;
  delete turn.answer.limitations;
  expect(DiscussionProtocolTurnSchema.parse(turn)).toEqual(openingTurn());
  for (const key of ["basisDraftIndices", "unresolvedObjectionIds", "body"]) {
    const missing = structuredClone(turn);
    delete missing.answer[key];
    expect(() => DiscussionProtocolTurnSchema.parse(missing)).toThrow();
  }
  expect(() => DiscussionProtocolTurnSchema.parse({ ...turn, commentary: "Model says trust me" })).toThrow();
});
it.each([
  "answer-body",
  "answer-owner",
  "claim-body",
  "source-copy",
  "epoch-hash",
  "epoch-coverage",
  "half-commit",
  "seal-payload"
])("rejects persisted corruption: %s", (mode) => {
  const base =
    mode === "seal-payload"
      ? sealDiscussionReply(stage2Session(), discussionEnvelope(stage2Session(), "a", openingTurn()))
      : reviewSession();
  const state = JSON.parse(JSON.stringify(base));
  if (mode === "answer-body") state.answerVersions[0].body = "changed";
  if (mode === "answer-owner") state.answerVersions[0].authorId = "b";
  if (mode === "claim-body") state.claimVersions[0].statement = "changed";
  if (mode === "source-copy") state.sources[0].content = "changed";
  if (mode === "epoch-hash") state.reviewEpochs[0].reviewSetHash = "wrong";
  if (mode === "epoch-coverage") state.reviewEpochs[0].answerVersions.pop();
  if (mode === "half-commit") state.committedBatches[0].replies.pop();
  if (mode === "seal-payload") state.pendingBatch.sealedReplies[0].payload.answer.body = "changed-but-still-valid";
  expect(() => parseDiscussionSession(state)).toThrow();
});
it("source IDs and input budget are checked before building a protocol", () => {
  const input = { sessionId: "x", question: "Q", memberIds: ["a", "b"], policy: {} };
  expect(() =>
    createDiscussionSession({
      ...input,
      sources: [
        { sourceId: "same", content: "A" },
        { sourceId: "same", content: "B" }
      ]
    })
  ).toThrow();
  expect(() =>
    createDiscussionSession({ ...input, sources: [{ sourceId: "large", content: "x".repeat(20001) }] })
  ).toThrow();
});
it("retains immutable historical dependencies for reading without reopening stale reference slots", () => {
  const state = openedSession(),
    own = activeDiscussionClaims(state)[0]!;
  const next = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "revise",
          targetVersionId: own.versionId,
          claim: { ...openingTurn().claims[0]!, statement: "New position" }
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  const shared = sharedDiscussionSnapshot(next);
  expect(shared.historicalClaimVersions.find((claim) => claim.versionId === own.versionId)!.statement).toBe("A claim");
  const checkpoint = freezeDiscussionReview(next);
  expect(checkpoint.reviewEpochs[0]!.claimVersions.some((claim) => claim.versionId === own.versionId)).toBe(false);
  const turn = reviewTurn(checkpoint, "a");
  expect(() =>
    validateDiscussionReply(
      checkpoint,
      discussionEnvelope(checkpoint, "a", {
        ...turn,
        positions: [
          ...turn.positions,
          { kind: "claim", versionId: own.versionId, stance: "accept", rationale: "Old text", sourceRefs: [] }
        ]
      })
    )
  ).toThrow(/coverage/i);
});
it("preserves historical target text for pending directed messages and retained objections", () => {
  const state = openedSession(),
    oldAnswer = latestDiscussionAnswers(state)[1]!;
  const next = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "ask",
          target: { kind: "answer", answerVersionId: oldAnswer.answerVersionId },
          recipientId: "b",
          rationale: "Why?",
          sourceRefs: []
        },
        {
          kind: "object",
          objection: {
            targetAnswerVersionId: oldAnswer.answerVersionId,
            severity: "material",
            summary: "Concern",
            impact: "Impact",
            evidenceNeeded: "Test"
          }
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  expect(sharedDiscussionSnapshot(next).historicalAnswerVersions).toContainEqual(oldAnswer);
});
it("keeps arbitrary roster names and opening complexity entries without prototype-key loss", () => {
  const state = openedSession(["__proto__", "constructor", "c"]);
  expect(Object.keys(state.complexities).sort()).toEqual(["__proto__", "constructor", "c"].sort());
  expect(parseDiscussionSession(JSON.parse(JSON.stringify(state)))).toEqual(state);
});
it("rejects a changed policy copy without its original frozen policy digest", () => {
  const state = JSON.parse(JSON.stringify(reviewSession()));
  state.policy.weights.a.decisionWeight = 100;
  expect(() => parseDiscussionSession(state)).toThrow(/immutable/i);
});
it("seals a valid review while a peer's missing coverage leaves the entire checkpoint uncommitted", () => {
  const state = reviewSession(),
    sealed = sealDiscussionReply(state, discussionEnvelope(state, "a", reviewTurn(state, "a")));
  const invalid = reviewTurn(state, "b");
  expect(() =>
    sealDiscussionReply(sealed, discussionEnvelope(state, "b", { ...invalid, positions: invalid.positions.slice(1) }))
  ).toThrow(/coverage/i);
  expect(() => commitSealedDiscussionBatch(sealed)).toThrow();
  expect(sealed.reviewEpochs[0]!.reviews).toEqual([]);
  expect(sealed.reviewEpochs[0]!.status).toBe("pending");
  expect(sealed.answerVersions).toEqual(state.answerVersions);
  expect(parseDiscussionSession(JSON.parse(JSON.stringify(sealed)))).toEqual(sealed);
});
it("requires an objection's explicit owner status and summary fields on its frozen review slot", () => {
  const state = openedSession(),
    target = latestDiscussionAnswers(state)[1]!.answerVersionId;
  const discussed = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "object",
          objection: {
            targetAnswerVersionId: target,
            severity: "material",
            summary: "Concern",
            impact: "Impact",
            evidenceNeeded: "Test"
          }
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  const frozen = freezeDiscussionReview(discussed);
  for (const key of ["status", "summary", "impact", "evidenceNeeded"]) {
    const turn = JSON.parse(JSON.stringify(reviewTurn(frozen, "a")));
    const position = turn.positions.find((item: { kind: string }) => item.kind === "objection");
    delete position[key];
    expect(() => validateDiscussionReply(frozen, discussionEnvelope(frozen, "a", turn))).toThrow(/author/i);
  }
});
it("rejects whitespace-only review reasons and author dissent summaries before resolving an objection", () => {
  const state = openedSession(),
    target = latestDiscussionAnswers(state)[1]!.answerVersionId;
  const discussed = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "object",
          objection: {
            targetAnswerVersionId: target,
            severity: "blocking",
            summary: "Concern",
            impact: "Impact",
            evidenceNeeded: "Test"
          }
        }
      ])
    ),
    discussionEnvelope(state, "b", exchangeTurn(state, "b"))
  ]);
  const frozen = freezeDiscussionReview(discussed);
  for (const [key, value] of [
    ["rationale", " "],
    ["summary", "\n"],
    ["impact", "\t"],
    ["evidenceNeeded", "\u00a0"]
  ]) {
    const turn = JSON.parse(JSON.stringify(reviewTurn(frozen, "a")));
    const position = turn.positions.find((item: { kind: string }) => item.kind === "objection");
    position.status = "resolved";
    position[key!] = value;
    expect(() => validateDiscussionReply(frozen, discussionEnvelope(frozen, "a", turn))).toThrow();
  }
  expect(activeDiscussionObjections(frozen)).toHaveLength(1);
});
it("includes historical bases of retained objection targets even after all latest answers switch bases", () => {
  const state = openedSession(),
    bAnswer = latestDiscussionAnswers(state)[1]!,
    bClaim = activeDiscussionClaims(state)[1]!;
  const first = applyDiscussionBatch(state, [
    discussionEnvelope(
      state,
      "a",
      exchangeTurn(state, "a", [
        {
          kind: "object",
          objection: {
            targetAnswerVersionId: bAnswer.answerVersionId,
            severity: "blocking",
            summary: "Concern",
            impact: "Impact",
            evidenceNeeded: "Test"
          }
        }
      ])
    ),
    discussionEnvelope(
      state,
      "b",
      exchangeTurn(state, "b", [
        {
          kind: "revise",
          targetVersionId: bClaim.versionId,
          claim: { ...openingTurn().claims[0]!, statement: "New B claim" }
        }
      ])
    )
  ]);
  const second = applyDiscussionBatch(
    first,
    first.memberIds.map((id) => discussionEnvelope(first, id, exchangeTurn(first, id)))
  );
  const frozen = freezeDiscussionReview(second),
    snapshot = sharedDiscussionSnapshot(frozen);
  expect(snapshot.historicalAnswerVersions).toContainEqual(bAnswer);
  expect(snapshot.historicalClaimVersions).toContainEqual(bClaim);
  expect(snapshot.claimVersions.some((claim) => claim.versionId === bClaim.versionId)).toBe(false);
  expect(snapshot.reviewEpoch!.claimVersions.some((claim) => claim.versionId === bClaim.versionId)).toBe(false);
});
