import { describe, expect, it } from "vitest";
import { applyRoundPair, buildPeerReport } from "../../src/index.js";
import { makeClaim, makeIncompleteReview, makePair, makeReview, makeSession, makeTurn } from "./fixtures.js";

describe("shared peer fixtures through production protocol", () => {
  it("constructs authored claims and a real targeted discussion message", () => {
    const claimed = makeClaim("member-b", "Use B");
    const state = makeSession({ phase: "discussion", claims: [claimed] });
    expect(state.claimVersions.map((c) => c.versionId)).toEqual([claimed.versionId]);
    const a = makeTurn(state, "member-a", [
      { kind: "challenge", targetVersionId: claimed.versionId, rationale: "Missing condition", sourceRefs: [] }
    ]);
    const b = makeTurn(state, "member-b");
    const next = applyRoundPair(state, makePair(state, a, b));
    expect(next.messages[0]).toMatchObject({
      authorId: "member-a",
      recipientId: "member-b",
      targetVersionId: claimed.versionId,
      respondedBy: []
    });
  });

  it("uses explicit incomplete-review input to reach coverage validation", () => {
    const state = makeSession({ phase: "review", claimCount: 2 });
    const versions = state.segments[0]!.reviewVersions;
    const a = makeIncompleteReview(state, "member-a", { [versions[0]!]: "accept" });
    const b = makeReview(state, "member-b", Object.fromEntries(versions.map((id) => [id, "accept"])));
    expect(() => applyRoundPair(state, makePair(state, a, b))).toThrow(/Review coverage/);
    expect(buildPeerReport(state).claims.every((c) => c.label === "incomplete_review")).toBe(true);
  });
});
