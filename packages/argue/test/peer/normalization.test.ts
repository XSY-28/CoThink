import { describe, expect, it } from "vitest";
import {
  applyRoundPair,
  peerSnapshotId,
  PeerTurnSchema,
  validateMemberReply,
  type MemberId,
  type ClaimVersion
} from "../../src/index.js";
import {
  envelope,
  makeClaimDraft,
  makeDiscussionTurn,
  makeOpeningTurn,
  makePairFromTurns,
  makeReviewTurn,
  makeSession
} from "./fixtures.js";

describe("peer wire normalization", () => {
  it("replays captured seven-version review failures: formatting succeeds, invented version still fails", () => {
    // Preserve the actual failed response shapes and references, with prose anonymized.
    const captured = JSON.parse(
      readFileSync(new URL("./fixtures/review-format-regressions.json", import.meta.url), "utf8")
    ) as {
      claimVersions: ClaimVersion[];
      reviewVersions: string[];
      reviewSetHash: string;
      cases: { label: string; payload: unknown; accepted: boolean }[];
    };
    const state = makeSession({ phase: "review" });
    state.claimVersions = captured.claimVersions;
    Object.assign(state.segments[0]!, {
      reviewVersions: captured.reviewVersions,
      reviewSetHash: captured.reviewSetHash
    });
    state.segments[0]!.snapshotId = peerSnapshotId(state);
    expect(captured.reviewVersions).toHaveLength(7);
    for (const sample of captured.cases) {
      for (const id of ["member-a", "member-b"] as const) {
        const validate = () => validateMemberReply(state, envelope(state, id, sample.payload));
        if (sample.accepted) expect(validate().payload.phase, sample.label).toBe("review");
        else expect(validate, sample.label).toThrow(/coverage/i);
      }
    }
  });

  it.each(["member-a", "member-b"] as const)(
    "accepts omitted empty metadata and commentary for %s without mutating raw input",
    (id) => {
      const state = makeSession();
      const payload = {
        phase: "opening",
        conclusion: "Independent position",
        evidenceRequestsNote: "No supplied evidence",
        claims: [{ statement: "A hypothesis", rationale: "A reason", note: "Not established" }]
      };
      const original = structuredClone(payload);
      const valid = validateMemberReply(state, envelope(state, id, payload));
      expect(valid.payload).toEqual({
        phase: "opening",
        conclusion: "Independent position",
        evidenceRequests: [],
        claims: [{ statement: "A hypothesis", rationale: "A reason", assumptions: [], sourceRefs: [] }]
      });
      expect(payload).toEqual(original);
      expect(() => PeerTurnSchema.parse(payload)).toThrow();
      expect(PeerTurnSchema.parse(valid.payload)).toEqual(valid.payload);
    }
  );

  it.each(["member-a", "member-b"] as const)(
    "accepts complete review with missing sourceRefs and an extra note for %s",
    (id) => {
      const state = makeSession({ phase: "review", claimCount: 6 });
      const expected = makeReviewTurn(state, Array(6).fill("uncertain"));
      const payload = {
        ...expected,
        evidenceRequestsNote: "No evidence supplied",
        positions: expected.positions.map(({ versionId, stance, rationale }) => ({
          versionId,
          stance,
          rationale,
          note: "Unverified"
        }))
      };
      expect(validateMemberReply(state, envelope(state, id, payload)).payload).toEqual(expected);
    }
  );

  it("preserves directed message and source references while removing nested commentary", () => {
    const state = makeSession({ phase: "discussion", claimCount: 2 });
    const target = state.claimVersions.find((v) => v.authorId === "member-b")!.versionId;
    const action = {
      kind: "ask",
      target: { versionId: target, note: "Frozen" },
      rationale: "Why?",
      sourceRefs: [{ sourceId: "source-1", startLine: 1, endLine: 2, note: "Copied" }],
      note: "Question"
    };
    const next = applyRoundPair(
      state,
      makePairFromTurns(state, { ...makeDiscussionTurn(), actions: [action] }, makeDiscussionTurn())
    );
    expect(next.messages[0]).toMatchObject({
      targetVersionId: target,
      sourceRefs: [{ sourceId: "source-1", startLine: 1, endLine: 2 }]
    });
    expect(() => applyRoundPair(next, makePairFromTurns(next, makeDiscussionTurn(), makeDiscussionTurn()))).toThrow(
      /reply/i
    );
    const answer = {
      ...makeDiscussionTurn(),
      actions: [{ kind: "reply", replyTo: next.messages[0]!.messageId, rationale: "Answer", note: "Response" }]
    };
    const replied = applyRoundPair(next, makePairFromTurns(next, makeDiscussionTurn(), answer));
    expect(replied.messages[0]!.respondedBy).toHaveLength(1);
    expect(replied.messages[1]!.sourceRefs).toEqual([]);
  });

  it.each(["member-a", "member-b"] as const)(
    "does not normalize away incomplete or invented review coverage for %s",
    (id) => {
      const state = makeSession({ phase: "review" });
      const valid = makeReviewTurn(state, ["accept", "uncertain"]);
      const variants = [
        { ...valid, positions: [] },
        { ...valid, positions: valid.positions.slice(1) },
        { ...valid, positions: [valid.positions[0], valid.positions[0]] },
        {
          ...valid,
          positions: [...valid.positions, { ...valid.positions[0], versionId: "segment-1:member-a:claim-1:v2" }]
        },
        { ...valid, reviewSetHash: "wrong" },
        {
          ...valid,
          positions: valid.positions.map((p) => ({
            ...p,
            sourceRefs: [{ sourceId: "nonexistent", startLine: 1, endLine: 1 }]
          }))
        }
      ];
      for (const payload of variants) {
        expect(() =>
          validateMemberReply(state, envelope(state, id, { ...payload, evidenceRequestsNote: "Extra" }))
        ).toThrow();
      }
      const missing: Record<string, unknown> = { ...valid };
      delete missing.positions;
      expect(() => validateMemberReply(state, envelope(state, id, missing))).toThrow();
    }
  );

  it.each(["member-a", "member-b"] as const)("keeps author rights and known field types strict for %s", (id) => {
    const state = makeSession({ phase: "discussion", claimCount: 2 });
    const target = state.claimVersions.find((v) => v.authorId !== id)!.versionId;
    const base = makeDiscussionTurn();
    const actions = [
      { kind: "revise", targetVersionId: target, ...makeClaimDraft(), note: "Extra" },
      { kind: "withdraw", targetVersionId: target, rationale: "No", note: "Extra" },
      { kind: "merge", claimIds: [target], note: "Extra" },
      { kind: "ask", target: { versionId: target, messageId: "also-a-target" }, rationale: "Why?" },
      { kind: "challenge", targetVersionId: "nonexistent", rationale: "Why?" },
      { kind: "challenge", targetVersionId: target, rationale: "Why?", sourceRefs: null },
      {
        kind: "challenge",
        targetVersionId: target,
        rationale: "Why?",
        sourceRefs: [{ sourceId: "source-1", startLine: 1, endLine: 3 }]
      },
      {
        kind: "challenge",
        targetVersionId: target,
        rationale: "Why?",
        sourceRefs: [{ sourceId: "source-1", startLine: "1", endLine: 2 }]
      },
      { kind: "challenge", targetVersionId: target }
    ];
    for (const action of actions)
      expect(() => validateMemberReply(state, envelope(state, id, { ...base, actions: [action] }))).toThrow();
    for (const payload of [
      { ...base, readyToReview: "true" },
      { ...base, evidenceRequests: null },
      { ...base, actions: undefined }
    ])
      expect(() => validateMemberReply(state, envelope(state, id, payload))).toThrow();
  });

  it.each(["authorId", "member_id", "peerAccepted", "reviewSetHash", "positions", "targetVersionId"])(
    "rejects misplaced authority or protocol field %s",
    (key) => {
      for (const id of ["member-a", "member-b"] as MemberId[]) {
        const state = makeSession();
        expect(() =>
          validateMemberReply(state, envelope(state, id, { ...makeOpeningTurn(), [key]: "override", note: "Extra" }))
        ).toThrow();
        const draft = { ...makeClaimDraft(), [key]: "override" };
        expect(() =>
          validateMemberReply(state, envelope(state, id, { ...makeOpeningTurn(), claims: [draft] }))
        ).toThrow();
      }
    }
  );
});
import { readFileSync } from "node:fs";
