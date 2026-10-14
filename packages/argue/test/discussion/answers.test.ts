import { describe, expect, test } from "vitest";
import {
  activeDiscussionClaims,
  activeDiscussionObjections,
  createOpeningAnswerVersion,
  createRevisedAnswerVersion,
  latestDiscussionAnswers,
  validateDiscussionAnswer,
  validateOpeningAnswer
} from "../../src/discussion/answers.js";
import {
  DiscussionSessionSchema,
  type AnswerVersion,
  type DiscussionClaimVersion,
  type DiscussionSession,
  type ImportantObjection
} from "../../src/discussion/contracts.js";
import { normalizeDiscussionPolicy } from "../../src/discussion/policy.js";

function claim(authorId = "alice", version = 1, segmentId = 1): DiscussionClaimVersion {
  return {
    claimId: `${authorId}-claim`,
    versionId: `${authorId}-claim-v${version}-s${segmentId}`,
    authorId,
    segmentId,
    roundIndex: version - 1,
    version,
    statement: "A source-backed claim",
    rationale: "Its supporting reasoning",
    assumptions: [],
    sourceRefs: [],
    withdrawn: false
  };
}

function answer(authorId = "alice", ordinal = 1, segmentId = 1): AnswerVersion {
  return {
    answerVersionId: `answers:s${segmentId}:member:${encodeURIComponent(authorId)}:answer:v${ordinal}`,
    authorId,
    segmentId,
    roundIndex: ordinal - 1,
    body: "A proposed answer",
    basisVersionIds: [`${authorId}-claim-v1-s${segmentId}`],
    limitations: [],
    unresolvedObjectionIds: []
  };
}

function objection(objectionId = "objection-a", authorId = "bob", segmentId = 1): ImportantObjection {
  return {
    objectionId,
    authorId,
    segmentId,
    roundIndex: 1,
    targetAnswerVersionId: "answers:s1:member:alice:answer:v1",
    severity: "blocking",
    summary: "The answer depends on an unverified assumption",
    impact: "The proposed answer could fail",
    evidenceNeeded: "Verify the assumption"
  };
}

function session(overrides: Partial<DiscussionSession> = {}): DiscussionSession {
  return DiscussionSessionSchema.parse({
    schemaVersion: 2,
    promptVersion: "peer-v6",
    codecVersion: "discussion-json-v1",
    policyVersion: "discussion-policy-v1",
    sessionId: "answers",
    revision: 0,
    policy: normalizeDiscussionPolicy({}, ["alice", "bob"]),
    policyHash: "synthetic",
    question: "Which answer is useful?",
    constraints: [],
    sources: [],
    segmentId: 1,
    contextVersion: 1,
    memberIds: ["alice", "bob"],
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
    committedBatches: [],
    ...overrides
  });
}

function openingDraft(overrides: Record<string, unknown> = {}) {
  return {
    body: "My answer",
    basisDraftIndices: [0],
    limitations: new Array<string>(),
    unresolvedObjectionIds: [],
    ...overrides
  };
}

function discussionState(overrides: Partial<DiscussionSession> = {}): DiscussionSession {
  return session({
    phase: "discussion",
    roundIndex: 1,
    claimVersions: [claim(), claim("bob")],
    answerVersions: [answer(), answer("bob")],
    objections: [objection()],
    ...overrides
  });
}

function revisedDraft(overrides: Record<string, unknown> = {}) {
  return {
    previousVersionId: "answers:s1:member:alice:answer:v1",
    body: "My revised answer",
    basisVersionIds: ["alice-claim-v1-s1"],
    limitations: [],
    unresolvedObjectionIds: [],
    ...overrides
  };
}

describe("opening answer ownership and local draft references", () => {
  test.each([
    ["unknown member", "outsider", openingDraft(), 1],
    ["out of range", "alice", openingDraft({ basisDraftIndices: [1] }), 1],
    ["negative index", "alice", openingDraft({ basisDraftIndices: [-1] }), 1],
    ["fractional index", "alice", openingDraft({ basisDraftIndices: [0.5] }), 1],
    ["duplicate index", "alice", openingDraft({ basisDraftIndices: [0, 0] }), 1],
    ["invented global ID", "alice", openingDraft({ basisVersionIds: ["unknown"] }), 1],
    ["invented author", "alice", openingDraft({ authorId: "bob" }), 1],
    ["invented answer ID", "alice", openingDraft({ answerVersionId: "chosen" }), 1],
    ["invented objection", "alice", openingDraft({ unresolvedObjectionIds: ["objection-a"] }), 1],
    ["missing basis", "alice", { body: "Answer", unresolvedObjectionIds: [] }, 1],
    ["missing declared objections", "alice", { body: "Answer", basisDraftIndices: [0] }, 1],
    ["empty body", "alice", openingDraft({ body: "" }), 1],
    ["whitespace body", "alice", openingDraft({ body: "  \n " }), 1],
    ["invalid claim count", "alice", openingDraft(), -1]
  ] as const)("rejects %s", (_label, memberId, draft, count) => {
    expect(() => validateOpeningAnswer(session(), memberId, draft, count)).toThrow();
  });

  test.each(["discussion", "review"] as const)("cannot create an opening answer during %s", (phase) => {
    expect(() => validateOpeningAnswer(session({ phase }), "alice", openingDraft(), 1)).toThrow();
  });

  test("opening cannot overwrite an existing answer by the same owner", () => {
    expect(() => validateOpeningAnswer(session({ answerVersions: [answer()] }), "alice", openingDraft(), 1)).toThrow();
  });

  test("resolves local indices against only the caller's same-batch claims, preserving order", () => {
    const state = session({
      claimVersions: [claim("bob"), claim(), { ...claim(), claimId: "alice-second", versionId: "alice-second-v1" }]
    });
    const draft = openingDraft({ basisDraftIndices: [1, 0], limitations: ["Needs validation"] });
    const before = structuredClone(state);
    const created = createOpeningAnswerVersion(state, "alice", draft, ["alice-claim-v1-s1", "alice-second-v1"]);
    expect(created).toEqual({
      answerVersionId: "answers:s1:member:alice:answer:v1",
      authorId: "alice",
      segmentId: 1,
      roundIndex: 0,
      body: "My answer",
      basisVersionIds: ["alice-second-v1", "alice-claim-v1-s1"],
      limitations: ["Needs validation"],
      unresolvedObjectionIds: []
    });
    expect(state).toEqual(before);
    expect(Object.isFrozen(state)).toBe(false);
    expect(Object.isFrozen(draft)).toBe(false);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.basisVersionIds)).toBe(true);
    expect(Object.isFrozen(created.limitations)).toBe(true);
    draft.limitations.push("Later input mutation");
    expect(created.limitations).toEqual(["Needs validation"]);
  });

  test.each([
    ["peer author", [claim("bob")], ["bob-claim-v1-s1"]],
    ["different segment", [claim("alice", 1, 2)], ["alice-claim-v1-s2"]],
    ["later round", [{ ...claim(), roundIndex: 1 }], ["alice-claim-v1-s1"]],
    ["unknown ID", [claim()], ["missing"]],
    [
      "withdrawn claim",
      [{ ...claim(), withdrawn: true, withdrawalReason: "No longer supported" }],
      ["alice-claim-v1-s1"]
    ],
    ["duplicate own IDs", [claim()], ["alice-claim-v1-s1", "alice-claim-v1-s1"]]
  ] as const)("cannot resolve local basis to %s", (_label, claimVersions, ownIds) => {
    expect(() => createOpeningAnswerVersion(session({ claimVersions }), "alice", openingDraft(), ownIds)).toThrow();
  });

  test("normalizes only optional empty metadata; required empty declarations remain explicit", () => {
    const created = createOpeningAnswerVersion(
      session(),
      "alice",
      {
        body: "An answer without supplied claims",
        basisDraftIndices: [],
        unresolvedObjectionIds: []
      },
      []
    );
    expect(created.limitations).toEqual([]);
    expect(created.basisVersionIds).toEqual([]);
    expect(created.unresolvedObjectionIds).toEqual([]);
  });

  test("new segment starts a new owner sequence and member names cannot collide with ID delimiters", () => {
    const state = session({ segmentId: 2, memberIds: ["alice:/", "bob"], answerVersions: [answer("alice:/", 4, 1)] });
    expect(
      createOpeningAnswerVersion(state, "alice:/", openingDraft({ basisDraftIndices: [] }), []).answerVersionId
    ).toBe("answers:s2:member:alice%3A%2F:answer:v1");
  });
});

describe("immutable revised answer versions", () => {
  test.each([
    ["peer answer", { previousVersionId: "answers:s1:member:bob:answer:v1" }],
    ["unknown answer", { previousVersionId: "unknown-answer" }],
    ["same-batch future answer", { previousVersionId: "answers:s1:member:alice:answer:v2" }],
    ["unknown claim", { basisVersionIds: ["unknown-claim"] }],
    ["same-batch future claim", { basisVersionIds: ["alice-claim-v2-s1"] }],
    ["duplicate basis", { basisVersionIds: ["alice-claim-v1-s1", "alice-claim-v1-s1"] }],
    ["unknown objection", { unresolvedObjectionIds: ["unknown-objection"] }],
    ["duplicate objection", { unresolvedObjectionIds: ["objection-a", "objection-a"] }],
    ["invented author", { authorId: "bob" }],
    ["invented generated ID", { answerVersionId: "chosen" }],
    ["opening basis indices", { basisDraftIndices: [0] }],
    ["whitespace body", { body: " \n " }]
  ] as const)("rejects %s", (_label, fields) => {
    expect(() => validateDiscussionAnswer(discussionState(), "alice", revisedDraft(fields))).toThrow();
  });

  test.each(["previousVersionId", "basisVersionIds", "unresolvedObjectionIds"])(
    "does not fabricate missing %s",
    (field) => {
      const draft: Record<string, unknown> = revisedDraft();
      delete draft[field];
      expect(() => validateDiscussionAnswer(discussionState(), "alice", draft)).toThrow();
    }
  );

  test.each(["opening", "review"] as const)("refuses to revise an answer during %s", (phase) => {
    expect(() => createRevisedAnswerVersion(discussionState({ phase }), "alice", revisedDraft())).toThrow();
  });

  test("rejects an old own answer after the owner has committed a newer one", () => {
    expect(() =>
      validateDiscussionAnswer(
        discussionState({ answerVersions: [answer(), answer("alice", 2), answer("bob")] }),
        "alice",
        revisedDraft()
      )
    ).toThrow();
  });

  test("rejects cross-segment answers and claims", () => {
    const state = discussionState({ segmentId: 2, answerVersions: [answer()], claimVersions: [claim()] });
    expect(() => validateDiscussionAnswer(state, "alice", revisedDraft())).toThrow();
    const currentState = discussionState({ claimVersions: [claim("alice", 1, 2)] });
    expect(() =>
      validateDiscussionAnswer(currentState, "alice", revisedDraft({ basisVersionIds: ["alice-claim-v1-s2"] }))
    ).toThrow();
  });

  test.each([
    ["superseded claim", [claim(), { ...claim("alice", 2), previousVersionId: "alice-claim-v1-s1" }]],
    [
      "withdrawn claim",
      [
        claim(),
        { ...claim("alice", 2), previousVersionId: "alice-claim-v1-s1", withdrawn: true, withdrawalReason: "Invalid" }
      ]
    ]
  ] as const)("rejects %s even though it remains in immutable history", (_label, claimVersions) => {
    expect(() => validateDiscussionAnswer(discussionState({ claimVersions }), "alice", revisedDraft())).toThrow();
  });

  test("rejects a resolved objection reference", () => {
    const state = discussionState({
      objectionResolutions: [{ objectionId: "objection-a", authorId: "bob", status: "resolved", epochId: 1 }]
    });
    expect(() =>
      validateDiscussionAnswer(state, "alice", revisedDraft({ unresolvedObjectionIds: ["objection-a"] }))
    ).toThrow();
  });

  test("rejects outsiders and owners who have no current answer", () => {
    expect(() => validateDiscussionAnswer(discussionState(), "outsider", revisedDraft())).toThrow();
    expect(() =>
      validateDiscussionAnswer(discussionState({ answerVersions: [answer("bob")] }), "alice", revisedDraft())
    ).toThrow();
  });

  test("may cite another member's frozen active claim and conservatively retained objection", () => {
    const state = discussionState();
    const draft = revisedDraft({ basisVersionIds: ["bob-claim-v1-s1"], unresolvedObjectionIds: ["objection-a"] });
    const before = structuredClone(state);
    const created = createRevisedAnswerVersion(state, "alice", draft);
    expect(created).toEqual({
      answerVersionId: "answers:s1:member:alice:answer:v2",
      authorId: "alice",
      previousVersionId: "answers:s1:member:alice:answer:v1",
      segmentId: 1,
      roundIndex: 1,
      body: "My revised answer",
      basisVersionIds: ["bob-claim-v1-s1"],
      limitations: [],
      unresolvedObjectionIds: ["objection-a"]
    });
    expect(state).toEqual(before);
    expect(Object.isFrozen(state)).toBe(false);
    expect(Object.isFrozen(draft)).toBe(false);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.unresolvedObjectionIds)).toBe(true);
    expect(state.answerVersions[0]?.body).toBe("A proposed answer");
    expect(state.answerVersions).toHaveLength(2);
  });
});

describe("current immutable semantic views", () => {
  test("latest answers follow the roster and exclude historical segments", () => {
    const state = discussionState({
      memberIds: ["bob", "alice", "carol"],
      answerVersions: [answer("carol", 5, 2), answer(), answer("alice", 2), answer("bob")]
    });
    expect(latestDiscussionAnswers(state).map((value) => value.answerVersionId)).toEqual([
      "answers:s1:member:bob:answer:v1",
      "answers:s1:member:alice:answer:v2"
    ]);
  });

  test("active claims use latest versions; a withdrawn latest version never revives an older claim", () => {
    const state = discussionState({
      claimVersions: [
        claim(),
        claim("alice", 2),
        claim("bob"),
        { ...claim("bob", 2), withdrawn: true, withdrawalReason: "Retracted" },
        claim("carol", 1, 2)
      ]
    });
    expect(activeDiscussionClaims(state).map((value) => value.versionId)).toEqual(["alice-claim-v2-s1"]);
  });

  test("only an objection's own author can resolve it; status comes from the latest owner checkpoint", () => {
    const state = discussionState({
      objections: [objection(), objection("objection-b"), objection("objection-c"), objection("old", "bob", 2)],
      objectionResolutions: [
        { objectionId: "objection-a", authorId: "bob", status: "retained", epochId: 3 },
        { objectionId: "objection-a", authorId: "bob", status: "resolved", epochId: 2 },
        { objectionId: "objection-b", authorId: "bob", status: "withdrawn", epochId: 2 },
        { objectionId: "objection-c", authorId: "alice", status: "resolved", epochId: 4 }
      ]
    });
    expect(activeDiscussionObjections(state).map((value) => value.objectionId)).toEqual(["objection-a", "objection-c"]);
  });
});
