import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyRoundPair,
  buildMemberRequest,
  createPeerSession,
  identifyStoredSession,
  DiscussionSessionHeaderSchema
} from "../../src/index.js";
import { makeConfig, makeOpeningTurn, makeDiscussionTurn, makePairFromTurns } from "../peer/fixtures.js";
import baseline from "./fixtures/peer-baseline.json" with { type: "json" };
import paused from "./fixtures/peer-v5-paused.json" with { type: "json" };

const header = {
  schemaVersion: 2,
  promptVersion: "peer-v6",
  codecVersion: "discussion-json-v1",
  policyVersion: "discussion-policy-v1",
  sessionId: "new-session",
  revision: 0
};
it("recognizes a new header without pretending it is an executable discussion state", () => {
  expect(identifyStoredSession({ ...header, futureProtocolState: {} })).toEqual({
    kind: "discussion",
    sessionId: header.sessionId,
    revision: 0,
    header
  });
  expect(DiscussionSessionHeaderSchema.parse(header)).toEqual(header);
});
it.each([
  null,
  {},
  { schemaVersion: 1 },
  { ...header, schemaVersion: 3 },
  { ...header, schemaVersion: "2" },
  { ...header, promptVersion: "peer-v7" },
  { ...header, codecVersion: "unknown" },
  { ...header, policyVersion: "unknown" },
  { ...header, revision: -1 },
  { ...header, config: paused.config },
  { ...paused, config: { ...paused.config, schemaVersion: 2 } },
  { ...paused, config: { ...paused.config, promptVersion: "peer-v6" } }
])("rejects missing, unknown, mixed or mismatched version markers", (raw) => {
  expect(() => identifyStoredSession(raw)).toThrow();
});
it("reads an af34aac paused snapshot without migrating frozen inputs", () => {
  const routed = identifyStoredSession(paused);
  expect(routed.kind).toBe("peer");
  if (routed.kind !== "peer") throw new Error("Wrong format");
  expect(routed.state).toEqual(paused);
  expect(routed.state.jobs.every((job) => job.frozenInput !== undefined)).toBe(true);
});

describe("af34aac frozen request compatibility", () => {
  for (const promptVersion of ["peer-v1", "peer-v2", "peer-v3", "peer-v4", "peer-v5"] as const) {
    it(`preserves ${promptVersion} requests, messages, output schema and hashes in every phase`, () => {
      let state = createPeerSession({ ...makeConfig("baseline-" + promptVersion), promptVersion }, [
        { sourceId: "source-1", content: "Option A\nA caveat", segmentId: 1 }
      ]);
      for (const sample of baseline.filter((item) => item.promptVersion === promptVersion)) {
        expect(state.segments[0]!.phase).toBe(sample.phase);
        expect(state.segments[0]!.roundIndex).toBe(sample.roundIndex);
        expect(state.segments[0]!.reviewSetHash).toBe(sample.reviewSetHash);
        expect(identifyStoredSession(state).kind).toBe("peer");
        for (const expected of sample.requests) {
          const request = buildMemberRequest(state, expected.memberId as "member-a" | "member-b");
          expect(request.inputHash).toBe(expected.inputHash);
          expect("sha256:" + createHash("sha256").update(JSON.stringify(request)).digest("hex")).toBe(expected.digest);
        }
        if (sample.phase === "review") break;
        const turn =
          sample.phase === "opening"
            ? makeOpeningTurn([{ statement: "Choose A", rationale: "Fits", assumptions: [], sourceRefs: [] }])
            : makeDiscussionTurn();
        state = applyRoundPair(state, makePairFromTurns(state, turn, turn));
      }
    });
  }
});
