import { describe, expect, test } from "vitest";
import type { DiscussionSession, DiscussionProtocolTurn } from "../../src/discussion/contracts.js";
import { normalizeDiscussionPolicy } from "../../src/discussion/policy.js";
import { buildDiscussionMemberRequest, type ProtocolCodec } from "../../src/discussion/codec.js";
import { sharedDiscussionSnapshot, discussionSnapshotId } from "../../src/discussion/context.js";
import { JsonDiscussionCodec } from "../../src/discussion/json-codec.js";
import { validateDiscussionAnswer } from "../../src/discussion/answers.js";
import {
  createDiscussionSession,
  applyDiscussionBatch,
  freezeDiscussionReview,
  validateDiscussionReply
} from "../../src/discussion/protocol.js";

const codec = new JsonDiscussionCodec();
const opening = {
  phase: "opening",
  claims: [{ statement: "Claim", rationale: "Reason" }],
  answer: { body: "Answer", basisDraftIndices: [0], unresolvedObjectionIds: [] },
  complexity: "simple",
  complexityRationale: "Short question"
};
function state(): DiscussionSession {
  return {
    schemaVersion: 2,
    promptVersion: "peer-v6",
    codecVersion: "discussion-json-v1",
    policyVersion: "discussion-policy-v1",
    sessionId: "codec-test",
    revision: 0,
    policy: normalizeDiscussionPolicy({}, ["a", "b"]),
    policyHash: "synthetic",
    question: "Question?",
    constraints: [],
    sources: [],
    segmentId: 1,
    contextVersion: 1,
    memberIds: ["a", "b"],
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
  };
}
const discussionState = (): DiscussionSession => ({
  ...state(),
  phase: "discussion",
  roundIndex: 1,
  committedSeq: 1,
  claimVersions: ["a", "b"].map((authorId) => ({
    claimId: `claim-${authorId}`,
    versionId: `claim-${authorId}:v1`,
    authorId,
    segmentId: 1,
    roundIndex: 0,
    version: 1,
    withdrawn: false,
    statement: "Claim",
    rationale: "Reason",
    assumptions: [],
    sourceRefs: []
  })),
  answerVersions: ["a", "b"].map((authorId) => ({
    answerVersionId: `answer-${authorId}:v1`,
    authorId,
    segmentId: 1,
    roundIndex: 0,
    body: "Answer",
    basisVersionIds: [`claim-${authorId}:v1`],
    limitations: [],
    unresolvedObjectionIds: []
  }))
});

describe("discussion codec representation boundary", () => {
  test("normalizes only allowed empty metadata from object or JSON", () => {
    const parsed = codec.decode(opening);
    expect(codec.decode(JSON.stringify(opening))).toEqual(parsed);
    expect(parsed).toMatchObject({
      claims: [{ assumptions: [], sourceRefs: [] }],
      answer: { limitations: [] },
      evidenceRequests: []
    });
    expect(opening).not.toHaveProperty("evidenceRequests");
  });
  test.each(["phase", "claims", "answer", "complexity", "complexityRationale"])(
    "never fabricates missing %s",
    (field) => {
      const malformed: Record<string, unknown> = { ...opening };
      delete malformed[field];
      expect(() => codec.decode(malformed)).toThrow();
    }
  );
  test.each(["body", "basisDraftIndices", "unresolvedObjectionIds"])("never fabricates opening answer %s", (field) => {
    const answer: Record<string, unknown> = { ...opening.answer };
    delete answer[field];
    expect(() => codec.decode({ ...opening, answer })).toThrow();
  });
  test("rejects unknown fields and malformed JSON rather than dropping or repairing them", () => {
    expect(() => codec.decode({ ...opening, leader: "a" })).toThrow();
    expect(() => codec.decode({ ...opening, answer: { ...opening.answer, owner: "b" } })).toThrow();
    expect(() => codec.decode("```json\n{}\n```")).toThrow();
    expect(() => codec.decode({ ...opening, claims: [{ ...opening.claims[0], assumptions: null }] })).toThrow();
  });
  test.each(["reviewSetHash", "positions"])("does not complete missing review %s", (field) => {
    const malformed: Record<string, unknown> = { phase: "review", reviewSetHash: "hash", positions: [] };
    delete malformed[field];
    expect(() => codec.decode(malformed)).toThrow();
  });
  test("does not fabricate stance, rationale, or version references", () => {
    for (const position of [
      { kind: "claim", versionId: "id", rationale: "Reason" },
      { kind: "claim", stance: "accept", rationale: "Reason" },
      { kind: "claim", versionId: "id", stance: "accept" }
    ])
      expect(() => codec.decode({ phase: "review", reviewSetHash: "hash", positions: [position] })).toThrow();
  });
  test("syntax decoding leaves invented IDs intact for domain rejection", () => {
    expect(
      codec.decode({
        phase: "review",
        reviewSetHash: "forged",
        positions: [{ kind: "claim", versionId: "forged", stance: "accept", rationale: "Reason" }]
      })
    ).toMatchObject({ reviewSetHash: "forged", positions: [{ versionId: "forged" }] });
  });
});

describe("shared semantic context and concrete output guidance", () => {
  test("member requests share byte-identical semantic context and expose no weights", () => {
    const s = state();
    const a = buildDiscussionMemberRequest(s, "a", 2048, codec);
    const b = buildDiscussionMemberRequest(s, "b", 4096, codec);
    expect(a.messages[1]).toEqual(b.messages[1]);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.messages[0]).not.toEqual(b.messages[0]);
    expect(JSON.stringify(a)).not.toContain("Weight");
    expect(a.inputHash).not.toBe(b.inputHash);
    expect(a).not.toHaveProperty("baseUrl");
  });
  test("three-member output contracts retain every member's independent answer slots", () => {
    const pair = discussionState();
    const memberIds = ["a", "b", "c"];
    const triple: DiscussionSession = {
      ...pair,
      memberIds,
      policy: normalizeDiscussionPolicy({}, memberIds),
      claimVersions: [
        ...pair.claimVersions,
        { ...pair.claimVersions[0]!, claimId: "claim-c", versionId: "claim-c:v1", authorId: "c" }
      ],
      answerVersions: [
        ...pair.answerVersions,
        { ...pair.answerVersions[0]!, answerVersionId: "answer-c:v1", authorId: "c", basisVersionIds: ["claim-c:v1"] }
      ]
    };
    const requests = memberIds.map((memberId) => buildDiscussionMemberRequest(triple, memberId, 2048, codec));
    expect(new Set(requests.map((request) => request.messages[1]!.content)).size).toBe(1);
    const contract = JSON.parse(requests[0]!.messages[1]!.content).responseContract;
    expect(Object.keys(contract.byMember)).toEqual(memberIds);
    expect(contract.byMember.c.template.answer.previousVersionId).toBe("answer-c:v1");
    expect(contract.byMember.c.referenceSlots.ownActiveClaimVersionIds).toEqual(["claim-c:v1"]);
    expect(contract.byMember.c.referenceSlots.activeBasisVersionIds).toEqual([
      "claim-a:v1",
      "claim-b:v1",
      "claim-c:v1"
    ]);
  });
  test("changing weights cannot change shared semantics or grant codec authority", () => {
    const s = discussionState();
    const weighted = {
      ...s,
      policy: normalizeDiscussionPolicy(
        {
          weights: {
            a: { participationWeight: 100, decisionWeight: 100 },
            b: { participationWeight: 0.1, decisionWeight: 0.1 }
          }
        },
        ["a", "b"]
      )
    };
    expect(buildDiscussionMemberRequest(weighted, "a", 2048, codec)).toEqual(
      buildDiscussionMemberRequest(s, "a", 2048, codec)
    );
    expect(buildDiscussionMemberRequest(weighted, "b", 2048, codec)).toEqual(
      buildDiscussionMemberRequest(s, "b", 2048, codec)
    );
  });
  test("revision and sealed half batch cannot change shared semantic snapshot or hash", () => {
    const s = state();
    const changed = {
      ...s,
      revision: 8,
      pendingBatch: {
        snapshotId: discussionSnapshotId(s),
        phase: "opening" as const,
        expectedMembers: ["a", "b"],
        sealedReplies: [
          {
            memberId: "a",
            snapshotId: discussionSnapshotId(s),
            payloadHash: "synthetic",
            payload: codec.decode(opening) as DiscussionProtocolTurn
          }
        ]
      }
    };
    expect(sharedDiscussionSnapshot(changed)).toEqual(sharedDiscussionSnapshot(s));
    expect(discussionSnapshotId(changed)).toBe(discussionSnapshotId(s));
    expect(Object.isFrozen(sharedDiscussionSnapshot(s))).toBe(true);
    expect(Object.isFrozen(sharedDiscussionSnapshot(s).memberIds)).toBe(true);
  });
  test("opening template has invalid judgment placeholders and local draft references", () => {
    const request = buildDiscussionMemberRequest(state(), "a", 2048, codec);
    const shared = JSON.parse(request.messages[1]!.content);
    expect(shared.responseContract.byMember.a.template.answer.basisDraftIndices).toEqual([0]);
    expect(shared.responseContract.byMember.a.template.answer.body).toBe(null);
    expect(() => codec.decode(shared.responseContract.byMember.a.template)).toThrow();
  });
  test("discussion schema constrains own revisions, latest own answer, and real active target IDs", () => {
    const request = buildDiscussionMemberRequest(discussionState(), "a", 2048, codec);
    const schemaText = JSON.stringify(request.outputSchema);
    expect(schemaText).toContain('"previousVersionId":{"const":"answer-a:v1"}');
    expect(schemaText).toContain('"targetVersionId":{"enum":["claim-a:v1"]}');
    const shared = JSON.parse(request.messages[1]!.content);
    expect(shared.responseContract.byMember.b.template.answer.previousVersionId).toBe("answer-b:v1");
  });
  test("review templates contain every real frozen item and author-only objection slots", () => {
    const s = discussionState();
    const objection = {
      objectionId: "obj-b",
      authorId: "b",
      segmentId: 1,
      roundIndex: 1,
      targetAnswerVersionId: "answer-a:v1",
      severity: "material" as const,
      summary: "Missing evidence",
      impact: "Conclusion may fail",
      evidenceNeeded: "A test"
    };
    const epoch = {
      epochId: 1,
      contextHash: "frozen-context-hash",
      segmentId: 1,
      contextVersion: 1,
      roundIndex: 1,
      expectedMembers: s.memberIds,
      claimVersions: s.claimVersions,
      answerVersions: s.answerVersions,
      objections: [objection],
      reviewSetHash: "frozen-review-hash",
      status: "pending" as const,
      reviews: []
    };
    const reviewState: DiscussionSession = { ...s, phase: "review", objections: [objection], reviewEpochs: [epoch] };
    const a = buildDiscussionMemberRequest(reviewState, "a", 4096, codec);
    const b = buildDiscussionMemberRequest(reviewState, "b", 4096, codec);
    expect(a.messages[1]).toEqual(b.messages[1]);
    const contract = JSON.parse(a.messages[1]!.content).responseContract;
    expect(contract.byMember.a.template.reviewSetHash).toBe("frozen-review-hash");
    expect(contract.byMember.a.template.positions).toHaveLength(5);
    expect(
      contract.byMember.a.template.positions.map(
        (item: { versionId?: string; answerVersionId?: string; objectionId?: string }) =>
          item.versionId ?? item.answerVersionId ?? item.objectionId
      )
    ).toEqual(["claim-a:v1", "claim-b:v1", "answer-a:v1", "answer-b:v1", "obj-b"]);
    expect(contract.byMember.a.template.positions.at(-1)).not.toHaveProperty("status");
    expect(contract.byMember.b.template.positions.at(-1)).toMatchObject({
      status: null,
      summary: null,
      impact: null,
      evidenceNeeded: null
    });
    expect(JSON.stringify(a.outputSchema)).toContain('"reviewSetHash":{"const":"frozen-review-hash"}');
    expect(JSON.stringify(a.outputSchema)).toContain('"minItems":5');
    expect(JSON.stringify(a.outputSchema)).toContain('"maxItems":5');
    expect(() => codec.decode(contract.byMember.b.template)).toThrow();
  });
  test("reference guidance retains copied source IDs and real line bounds", () => {
    const s: DiscussionSession = {
      ...state(),
      sources: [{ sourceId: "source-real", content: "line one\nline two", contentHash: "source-hash", lineCount: 2 }]
    };
    const encoded = buildDiscussionMemberRequest(s, "a", 2048, codec);
    const contract = JSON.parse(encoded.messages[1]!.content).responseContract;
    expect(contract.byMember.a.referenceSlots.sourceRefs).toEqual([
      { sourceId: "source-real", startLine: 1, endLine: 2 }
    ]);
    expect(JSON.stringify(encoded.outputSchema)).toContain('"sourceId":{"const":"source-real"}');
    expect(JSON.stringify(encoded.outputSchema)).toContain('"maximum":2');
  });
  test("semantic snapshot excludes superseded claims/answers and completed objections", () => {
    const s = discussionState();
    const newer = {
      ...s.claimVersions[0]!,
      versionId: "claim-a:v2",
      previousVersionId: "claim-a:v1",
      version: 2,
      roundIndex: 1
    };
    const nextAnswer = {
      ...s.answerVersions[0]!,
      answerVersionId: "answer-a:v2",
      previousVersionId: "answer-a:v1",
      basisVersionIds: ["claim-a:v2"],
      roundIndex: 1
    };
    const objection = {
      objectionId: "obj-b",
      authorId: "b",
      segmentId: 1,
      roundIndex: 1,
      targetAnswerVersionId: "answer-a:v1",
      severity: "material" as const,
      summary: "Concern",
      impact: "Impact",
      evidenceNeeded: "Test"
    };
    const snapshot = sharedDiscussionSnapshot({
      ...s,
      claimVersions: [...s.claimVersions, newer],
      answerVersions: [...s.answerVersions, nextAnswer],
      objections: [objection],
      objectionResolutions: [{ objectionId: "obj-b", authorId: "b", status: "resolved", epochId: 1 }]
    });
    expect(snapshot.claimVersions.map((item) => item.versionId)).toEqual(["claim-a:v2", "claim-b:v1"]);
    expect(snapshot.answerVersions.map((item) => item.answerVersionId)).toEqual(["answer-a:v2", "answer-b:v1"]);
    expect(snapshot.objections).toEqual([]);
    expect(s.claimVersions[0]!.versionId).toBe("claim-a:v1");
  });
  test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe quota %s", (quota) => {
    expect(() => buildDiscussionMemberRequest(state(), "a", quota, codec)).toThrow();
  });
  test("rejects unknown members, codec swaps, and oversized input before transport", () => {
    expect(() => buildDiscussionMemberRequest(state(), "unknown", 2048, codec)).toThrow();
    expect(() =>
      buildDiscussionMemberRequest(state(), "a", 2048, {
        ...codec,
        codecVersion: "other",
        encode: codec.encode.bind(codec),
        decode: codec.decode.bind(codec)
      })
    ).toThrow();
    expect(() =>
      buildDiscussionMemberRequest({ ...state(), question: "x".repeat(100_001) }, "a", 2048, codec)
    ).toThrow();
  });
  test("test-only alternative codec changes representation while preserving decoded semantic turn", () => {
    const wrapped: ProtocolCodec = {
      codecVersion: "test-envelope-v1",
      encode(snapshot, context) {
        const encoded = codec.encode(snapshot, context);
        return {
          ...encoded,
          messages: encoded.messages.map((message) => ({
            ...message,
            content: JSON.stringify({ envelope: message.content })
          }))
        };
      },
      decode(raw) {
        return codec.decode((raw as { envelope: unknown }).envelope);
      }
    };
    expect(
      wrapped.encode(sharedDiscussionSnapshot(state()), { memberId: "a", maxOutputTokens: 2048 }).messages
    ).not.toEqual(codec.encode(sharedDiscussionSnapshot(state()), { memberId: "a", maxOutputTokens: 2048 }).messages);
    expect(wrapped.decode({ envelope: opening })).toEqual(codec.decode(opening));
  });
  test("both codecs pass valid answers and reject forged/stale references with identical domain validation", () => {
    const alternative: ProtocolCodec = {
      codecVersion: "test-envelope-v1",
      encode: codec.encode.bind(codec),
      decode(raw) {
        return codec.decode((raw as { envelope: unknown }).envelope);
      }
    };
    const s = discussionState();
    const answer = {
      previousVersionId: "answer-a:v1",
      body: "My updated answer",
      basisVersionIds: ["claim-a:v1"],
      limitations: [],
      unresolvedObjectionIds: []
    };
    const turn = { phase: "discussion", actions: [], answer, readyToReview: false };
    for (const decode of [
      (raw: unknown) => codec.decode(raw),
      (raw: unknown) => alternative.decode({ envelope: raw })
    ]) {
      const valid = decode(turn) as Extract<DiscussionProtocolTurn, { phase: "discussion" }>;
      expect(() => validateDiscussionAnswer(s, "a", valid.answer)).not.toThrow();
      for (const malformed of [
        { ...answer, basisVersionIds: ["forged"] },
        { ...answer, previousVersionId: "answer-b:v1" },
        { ...answer, previousVersionId: "stale" }
      ]) {
        const invalid = decode({ ...turn, answer: malformed }) as Extract<
          DiscussionProtocolTurn,
          { phase: "discussion" }
        >;
        expect(() => validateDiscussionAnswer(s, "a", invalid.answer)).toThrow();
      }
    }
  });
  test("alternative representation preserves strict full review domain validation", () => {
    const alternative: ProtocolCodec = {
      codecVersion: "test-envelope-v1",
      encode: codec.encode.bind(codec),
      decode(raw) {
        return codec.decode((raw as { envelope: unknown }).envelope);
      }
    };
    let s = createDiscussionSession({
      sessionId: "codec-domain",
      question: "Question?",
      memberIds: ["a", "b"],
      policy: {}
    });
    s = applyDiscussionBatch(
      s,
      s.memberIds.map((memberId) => ({ memberId, snapshotId: discussionSnapshotId(s), payload: codec.decode(opening) }))
    );
    s = applyDiscussionBatch(
      s,
      s.memberIds.map((memberId) => ({
        memberId,
        snapshotId: discussionSnapshotId(s),
        payload: {
          phase: "discussion",
          actions: [],
          answer: {
            previousVersionId: s.answerVersions.find((item) => item.authorId === memberId)!.answerVersionId,
            body: "Updated answer",
            basisVersionIds: s.claimVersions.filter((item) => item.authorId === memberId).map((item) => item.versionId),
            limitations: [],
            unresolvedObjectionIds: []
          },
          readyToReview: true,
          evidenceRequests: []
        }
      }))
    );
    s = freezeDiscussionReview(s);
    const epoch = s.reviewEpochs.at(-1)!;
    const review = {
      phase: "review",
      reviewSetHash: epoch.reviewSetHash,
      positions: [
        ...epoch.claimVersions.map((item) => ({
          kind: "claim",
          versionId: item.versionId,
          stance: "accept",
          rationale: "Reason"
        })),
        ...epoch.answerVersions.map((item) => ({
          kind: "answer",
          answerVersionId: item.answerVersionId,
          stance: "accept",
          rationale: "Reason"
        }))
      ]
    };
    for (const decode of [
      (raw: unknown) => codec.decode(raw),
      (raw: unknown) => alternative.decode({ envelope: raw })
    ]) {
      const candidate = (raw: unknown) => ({
        memberId: "a",
        snapshotId: discussionSnapshotId(s),
        payload: decode(raw)
      });
      expect(() => validateDiscussionReply(s, candidate(review))).not.toThrow();
      for (const invalid of [
        { ...review, reviewSetHash: "forged" },
        { ...review, positions: review.positions.slice(1) },
        { ...review, positions: [...review.positions.slice(1), review.positions[1]!] },
        { ...review, positions: [{ ...review.positions[0]!, versionId: "forged" }, ...review.positions.slice(1)] },
        opening
      ])
        expect(() => validateDiscussionReply(s, candidate(invalid))).toThrow();
    }
  });
});
