import { describe, expect, it } from "vitest";
import * as peer from "../../src/index.js";
import {
  makeClaimDraft,
  makeConfig,
  makeDiscussionTurn,
  makeOpeningTurn,
  makePairFromTurns,
  makeReviewTurn,
  makeSession
} from "./fixtures.js";

const member = (modelId: string) => ({
  protocol: "openai-compatible" as const,
  baseUrl: "https://example.invalid/v1",
  modelId,
  apiKeyEnv: "TEST_API_KEY",
  outputMode: "json_object" as const,
  generationOptions: { temperature: 0.4 }
});
const config = makeConfig;
const create = () => makeSession();
const claim = makeClaimDraft;
const opening = (statement: string) => ({ ...makeOpeningTurn([claim(statement)]), conclusion: statement });
const discussion = (actions: unknown[] = [], readyToReview = false) => ({
  ...makeDiscussionTurn([], readyToReview),
  actions
});
const pair = makePairFromTurns;
const opened = () => {
  const state = create();
  return peer.applyRoundPair(state, pair(state, opening("A"), opening("B")));
};
const toReview = (state = opened()) => {
  while (state.segments.at(-1)!.phase === "discussion")
    state = peer.applyRoundPair(state, pair(state, discussion(), discussion()));
  return state;
};
const review = makeReviewTurn;

describe("peer frozen protocol", () => {
  it("A01/A02 seals opening until the pair and shares identical immutable snapshots", () => {
    const state = create();
    const a = peer.buildMemberRequest(state, "member-a");
    const b = peer.buildMemberRequest(state, "member-b");
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.sharedContext).toEqual(b.sharedContext);
    expect(a.sharedContext.claimVersions).toEqual([]);
    const next = peer.applyRoundPair(state, pair(state, opening("A"), opening("B")));
    expect(state.claimVersions).toEqual([]);
    expect(peer.buildMemberRequest(next, "member-b").sharedContext.claimVersions.map((c) => c.statement)).toEqual([
      "A",
      "B"
    ]);
    expect(next.revision).toBe(1);
  });
  it("copies sources and validates source line ranges without silently truncating", () => {
    const state = create();
    expect(state.sources[0]?.lineCount).toBe(2);
    expect(state.sources[0]?.contentHash).toMatch(/^sha256:/);
    const invalid = opening("A");
    invalid.claims[0]!.sourceRefs[0]!.endLine = 3;
    expect(() => peer.applyRoundPair(state, pair(state, invalid, opening("B")))).toThrow(/source/i);
    expect(() =>
      peer.createPeerSession(config(), [{ sourceId: "s", content: "x".repeat(20001), segmentId: 1 }])
    ).toThrow(/source|character/i);
  });
  it("A03 member configuration and arrival order cannot change author rights or labels", () => {
    const state = create();
    const swapped = peer.createPeerSession(
      { ...config(), members: { "member-a": member("b"), "member-b": member("a") } },
      [{ sourceId: "source-1", content: "Option A\nA caveat", segmentId: 1 }]
    );
    const replies = pair(state, opening("A"), opening("B"));
    const next = peer.applyRoundPair(state, [replies[1], replies[0]]);
    const other = peer.applyRoundPair(swapped, pair(swapped, opening("A"), opening("B")));
    expect(next.claimVersions).toEqual(other.claimVersions);
    expect(next.claimVersions.map((c) => c.authorId)).toEqual(["member-a", "member-b"]);
  });
  it("rejects duplicate members, stale envelopes, and model-authored commitments", () => {
    const state = create();
    const replies = pair(state, opening("A"), opening("B"));
    expect(() => peer.applyRoundPair(state, [replies[0], replies[0]])).toThrow(/member/i);
    expect(() => peer.applyRoundPair(state, [{ ...replies[0], snapshotId: "old" }, replies[1]])).toThrow(/snapshot/i);
    expect(() =>
      peer.applyRoundPair(state, pair(state, { ...opening("A"), authorId: "member-b" }, opening("B")))
    ).toThrow();
    expect(() =>
      peer.applyRoundPair(state, pair(state, { ...opening("A"), peerAccepted: true }, opening("B")))
    ).toThrow();
  });
  it("validates a single sealed reply without exposing it to the peer", () => {
    const state = create();
    const reply = pair(state, opening("A"), opening("B"))[0];
    const valid = peer.validateMemberReply(state, reply);
    expect(valid.payload.phase).toBe("opening");
    expect(peer.buildMemberRequest(state, "member-b").sharedContext.claimVersions).toEqual([]);
    expect(() => peer.validateMemberReply(state, { ...reply, inputHash: "changed" })).toThrow(/input/i);
  });
  it("normalizes reversed config arrays by id without giving tuple order authority", () => {
    const state = peer.createPeerSession(
      {
        ...config(),
        members: [
          { id: "member-b", ...member("b") },
          { id: "member-a", ...member("a") }
        ]
      },
      []
    );
    expect(peer.buildMemberRequest(state, "member-a").modelId).toBe("a");
    expect(peer.buildMemberRequest(state, "member-b").modelId).toBe("b");
    expect(state.config.members["member-a"].id).toBe("member-a");
  });
  it("A04 rejects peer revision/withdrawal and permits an author-bound alternative", () => {
    const state = opened();
    const target = state.claimVersions[1]!.versionId;
    for (const kind of ["revise", "withdraw"]) {
      const action =
        kind === "revise"
          ? { kind, targetVersionId: target, ...claim("Changed") }
          : { kind, targetVersionId: target, rationale: "Wrong" };
      expect(() => peer.applyRoundPair(state, pair(state, discussion([action]), discussion()))).toThrow(/own|author/i);
    }
    const next = peer.applyRoundPair(
      state,
      pair(
        state,
        discussion([{ kind: "propose", ...claim("Alternative"), alternativeToVersionId: target }]),
        discussion()
      )
    );
    expect(next.claimVersions.at(-1)?.authorId).toBe("member-a");
    expect(next.claimVersions.at(-1)?.alternativeToVersionId).toBe(target);
  });
  it("A05/A15 preserves prior versions and validates peer challenge against the original snapshot", () => {
    const state = opened();
    const old = state.claimVersions[0]!;
    const next = peer.applyRoundPair(
      state,
      pair(
        state,
        discussion([{ kind: "revise", targetVersionId: old.versionId, ...claim("A revised") }]),
        discussion([
          { kind: "challenge", targetVersionId: old.versionId, rationale: "Missing condition", sourceRefs: [] }
        ])
      )
    );
    expect(next.claimVersions.find((c) => c.versionId === old.versionId)).toEqual(old);
    expect(next.claimVersions.at(-1)?.previousVersionId).toBe(old.versionId);
    expect(next.messages[0]?.targetVersionId).toBe(old.versionId);
    expect(next.messages[0]?.respondedBy).toEqual([]);
    const answered = peer.applyRoundPair(
      next,
      pair(
        next,
        discussion([
          { kind: "reply", replyTo: next.messages[0]!.messageId, rationale: "Acknowledged condition", sourceRefs: [] }
        ]),
        discussion()
      )
    );
    const reviewed = toReview(answered);
    expect(reviewed.segments.at(-1)?.reviewVersions).not.toContain(old.versionId);
  });
  it("A06 refuses merge actions and same-round references", () => {
    const state = opened();
    expect(() =>
      peer.applyRoundPair(state, pair(state, discussion([{ kind: "merge", claimIds: ["c1", "c2"] }]), discussion()))
    ).toThrow();
    expect(() =>
      peer.applyRoundPair(
        state,
        pair(
          state,
          discussion([{ kind: "propose", ...claim("Next") }]),
          discussion([
            { kind: "challenge", targetVersionId: "segment-1:member-a:claim-2:v1", rationale: "No", sourceRefs: [] }
          ])
        )
      )
    ).toThrow(/version/i);
  });
  it("A15 rejects duplicate own modifications and revising a historical version atomically", () => {
    const state = opened();
    const id = state.claimVersions[0]!.versionId;
    const revise = { kind: "revise", targetVersionId: id, ...claim("New") };
    for (const actions of [
      [revise, revise],
      [revise, { kind: "withdraw", targetVersionId: id, rationale: "No" }]
    ])
      expect(() => peer.applyRoundPair(state, pair(state, discussion(actions), discussion()))).toThrow(
        /duplicate|once/i
      );
    const next = peer.applyRoundPair(state, pair(state, discussion([revise]), discussion()));
    expect(() => peer.applyRoundPair(next, pair(next, discussion([revise]), discussion()))).toThrow(/latest|current/i);
    expect(state.claimVersions).toHaveLength(2);
  });
  it("requires one reply per pending targeted message and does not equate reply with resolution", () => {
    const state = opened();
    const id = state.claimVersions[0]!.versionId;
    const challenged = peer.applyRoundPair(
      state,
      pair(
        state,
        discussion(),
        discussion([{ kind: "ask", target: { versionId: id }, rationale: "Why?", sourceRefs: [] }])
      )
    );
    expect(() => peer.applyRoundPair(challenged, pair(challenged, discussion(), discussion()))).toThrow(/reply/i);
    const messageId = challenged.messages[0]!.messageId;
    const replied = peer.applyRoundPair(
      challenged,
      pair(
        challenged,
        discussion([{ kind: "reply", replyTo: messageId, rationale: "Need evidence", sourceRefs: [] }]),
        discussion()
      )
    );
    expect(replied.messages[0]?.respondedBy).toHaveLength(1);
    expect(replied.messages[1]?.replyTo).toBe(messageId);
    expect(peer.buildPeerReport(replied).unrespondedMessages).toEqual([]);
    expect(peer.buildPeerReport(replied).messages).toHaveLength(2);
  });
  it("enforces shared proposal and challenge/ask limits", () => {
    const state = opened();
    const id = state.claimVersions[0]!.versionId;
    expect(() =>
      peer.applyRoundPair(
        state,
        pair(
          state,
          discussion([
            { kind: "propose", ...claim() },
            { kind: "propose", ...claim() }
          ]),
          discussion()
        )
      )
    ).toThrow(/limit|one|1/i);
    expect(() =>
      peer.applyRoundPair(
        state,
        pair(
          state,
          discussion(),
          discussion(
            Array.from({ length: 3 }, () => ({
              kind: "challenge",
              targetVersionId: id,
              rationale: "No",
              sourceRefs: []
            }))
          )
        )
      )
    ).toThrow(/limit|two|2/i);
    expect(() =>
      peer.applyRoundPair(
        create(),
        pair(create(), { ...opening("A"), claims: Array.from({ length: 4 }, () => claim()) }, opening("B"))
      )
    ).toThrow();
  });
  it("enters review early only after two rounds, both ready and no pending messages", () => {
    let state = opened();
    state = peer.applyRoundPair(state, pair(state, discussion([], true), discussion([], true)));
    expect(state.segments.at(-1)?.phase).toBe("discussion");
    state = peer.applyRoundPair(state, pair(state, discussion([], true), discussion([], true)));
    expect(state.segments.at(-1)?.phase).toBe("review");
    expect(peer.buildMemberRequest(state, "member-a").sharedContext).toEqual(
      peer.buildMemberRequest(state, "member-b").sharedContext
    );
  });
  it.each(["missing", "duplicate", "stale", "hash"])("A07 refuses an entire %s final review", (mode) => {
    const state = toReview();
    const a = review(state, ["accept", "accept"]);
    const b = review(state, ["accept", "accept"]);
    if (mode === "missing") a.positions.pop();
    if (mode === "duplicate") a.positions[1] = a.positions[0]!;
    if (mode === "stale") a.positions[0]!.versionId = "old-version";
    if (mode === "hash") a.reviewSetHash = "old-hash";
    expect(() => peer.applyRoundPair(state, pair(state, a, b))).toThrow(/review|version|coverage/i);
    expect(peer.buildPeerReport(state).claims.map((c) => c.label)).toEqual(["incomplete_review", "incomplete_review"]);
    expect(state.segments.at(-1)?.reviews).toEqual([]);
  });
  it.each([
    ["accept", "accept", "jointly_accepted"],
    ["reject", "reject", "jointly_rejected"],
    ["accept", "reject", "disputed"],
    ["reject", "accept", "disputed"],
    ["uncertain", "accept", "uncertain"]
  ] as const)("A08 labels %s/%s as %s", (a, b, label) => {
    const state = toReview();
    const done = peer.applyRoundPair(state, pair(state, review(state, [a, a]), review(state, [b, b])));
    expect(peer.buildPeerReport(done).claims.map((c) => c.label)).toEqual([label, label]);
    expect(done.status).toBe("completed");
    expect(() => peer.applyRoundPair(done, pair(done, review(done, [a, a]), review(done, [b, b])))).toThrow();
  });
  it("A12 preserves final-batch unanswered challenges and evidence requests deterministically", () => {
    let state = opened();
    for (let i = 0; i < 2; i++) state = peer.applyRoundPair(state, pair(state, discussion(), discussion()));
    const id = state.claimVersions[0]!.versionId;
    state = peer.applyRoundPair(
      state,
      pair(state, discussion(), {
        ...discussion([{ kind: "challenge", targetVersionId: id, rationale: "Unverified", sourceRefs: [] }]),
        evidenceRequests: [{ targetVersionId: id, request: "Measure it", rationale: "Missing evidence" }]
      })
    );
    const done = peer.applyRoundPair(
      state,
      pair(state, review(state, ["accept", "accept"]), review(state, ["accept", "accept"]))
    );
    const report = peer.buildPeerReport(done);
    expect(report.unrespondedMessages).toHaveLength(1);
    expect(report.evidenceRequests[0]?.request).toBe("Measure it");
    expect(report).toEqual(peer.buildPeerReport(done));
    expect(JSON.stringify(report)).not.toMatch(/representative|participantScore/);
  });
  it("A16 empty active set completes without review or vacuum consensus and retains conclusions", () => {
    let state = create();
    state = peer.applyRoundPair(state, pair(state, { ...opening("A"), claims: [] }, { ...opening("B"), claims: [] }));
    state = toReview(state);
    expect(state.status).toBe("completed");
    expect(state.segments.at(-1)?.completionReason).toBe("no_active_claims");
    const report = peer.buildPeerReport(state);
    expect(report.claims).toEqual([]);
    expect(report.conclusions.map((c) => c.conclusion)).toEqual(["My position", "My position"]);
    expect(report.reviewStatus).toBe("not_called_no_active_claims");
    expect(() => peer.buildMemberRequest(state, "member-a")).toThrow(/completed/i);
  });
  it("A16 all withdrawals retain history, conclusions and outstanding messages", () => {
    let state = opened();
    for (let i = 0; i < 2; i++) state = peer.applyRoundPair(state, pair(state, discussion(), discussion()));
    const a = state.claimVersions[0]!.versionId;
    const b = state.claimVersions[1]!.versionId;
    state = peer.applyRoundPair(
      state,
      pair(
        state,
        discussion([{ kind: "withdraw", targetVersionId: a, rationale: "Retract" }]),
        discussion([
          { kind: "withdraw", targetVersionId: b, rationale: "Retract" },
          { kind: "challenge", targetVersionId: a, rationale: "Still a question", sourceRefs: [] }
        ])
      )
    );
    const report = peer.buildPeerReport(state);
    expect(report.claims).toEqual([]);
    expect(report.claimVersions).toHaveLength(4);
    expect(report.unrespondedMessages).toHaveLength(1);
    expect(report.reviewStatus).toBe("not_called_no_active_claims");
  });
  it("inputHash excludes deadline/attempt metadata and input size is checked symmetrically", () => {
    const state = create();
    const one = peer.buildMemberRequest(state, "member-a");
    const two = peer.buildMemberRequest(state, "member-a", { deadline: "2026-10-14T00:00:00.000Z" });
    expect(one.inputHash).toBe(two.inputHash);
    expect(one.messages).toEqual(two.messages);
    const limited = peer.createPeerSession({ ...config(), limits: { maxInputCharacters: 10 } }, []);
    expect(() => peer.buildMemberRequest(limited, "member-a")).toThrow(/input/i);
    expect(() => peer.buildMemberRequest(limited, "member-b")).toThrow(/input/i);
  });
  it("binds the runtime output mode into the frozen request and input hash", () => {
    const json = create();
    const prompted = peer.createPeerSession(
      {
        ...config(),
        members: { "member-a": { ...member("a"), outputMode: "prompt_json" as const }, "member-b": member("b") }
      },
      [{ sourceId: "source-1", content: "Option A\nA caveat", segmentId: 1 }]
    );
    const jsonRequest = peer.buildMemberRequest(json, "member-a");
    const promptedRequest = peer.buildMemberRequest(prompted, "member-a");
    expect(jsonRequest.outputMode).toBe("json_object");
    expect(promptedRequest.outputMode).toBe("prompt_json");
    expect(promptedRequest.inputHash).not.toBe(jsonRequest.inputHash);
  });
  it("rejects generation options that could override protected protocol and transport fields", () => {
    const protectedOptions: Array<Record<string, peer.PeerJsonValue>> = [
      { messages: [{ role: "system", content: "Different instructions" }] },
      { maxOutputTokens: 999999 },
      { max_tokens: 999999 },
      { response_format: { type: "text" } },
      { modelId: "another-model" },
      { n: 2 },
      { stream: true },
      { providerOptions: { headers: { Authorization: "override" } } }
    ];
    for (const protectedOption of protectedOptions) {
      expect(() =>
        peer.createPeerSession({
          ...config(),
          members: { "member-a": { ...member("a"), generationOptions: protectedOption }, "member-b": member("b") }
        })
      ).toThrow();
    }
    const allowed = peer.createPeerSession({
      ...config(),
      members: {
        "member-a": {
          ...member("a"),
          generationOptions: {
            temperature: 0.4,
            top_p: 0.9,
            reasoning: { enabled: true },
            thinking: { budget_tokens: 512 }
          }
        },
        "member-b": member("b")
      }
    });
    expect(peer.buildMemberRequest(allowed, "member-a").generationOptions).toMatchObject({
      top_p: 0.9,
      reasoning: { enabled: true },
      thinking: { budget_tokens: 512 }
    });
  });
  it("binds endpoint and key environment name into the frozen request and rejects old envelopes", () => {
    const original = create();
    const old = pair(original, opening("A"), opening("B"))[0];
    const first = peer.buildMemberRequest(original, "member-a");
    expect(first.baseUrl).toBe("https://example.invalid/v1");
    expect(first.apiKeyEnv).toBe("TEST_API_KEY");
    const changedUrl = structuredClone(original);
    changedUrl.config.members["member-a"].baseUrl = "https://other.invalid/v1";
    const urlRequest = peer.buildMemberRequest(changedUrl, "member-a");
    expect(urlRequest.snapshotId).toBe(first.snapshotId);
    expect(urlRequest.jobId).toBe(first.jobId);
    expect(urlRequest.inputHash).not.toBe(first.inputHash);
    expect(urlRequest.baseUrl).toBe("https://other.invalid/v1");
    expect(() => peer.validateMemberReply(changedUrl, old)).toThrow(/input hash/i);

    const changedEnv = structuredClone(original);
    changedEnv.config.members["member-a"].apiKeyEnv = "OTHER_TEST_API_KEY";
    const envRequest = peer.buildMemberRequest(changedEnv, "member-a");
    expect(envRequest.inputHash).not.toBe(first.inputHash);
    expect(envRequest.apiKeyEnv).toBe("OTHER_TEST_API_KEY");
    expect(() => peer.validateMemberReply(changedEnv, old)).toThrow(/input hash/i);
  });
  it("rejects a promptVersion that does not select the implemented protocol text", () => {
    expect(peer.SessionConfigInputSchema.safeParse({ ...config(), promptVersion: "peer-v2" }).success).toBe(false);
  });
  it("persists strict session/report shapes after an alternative proposal and verifies copied-source SHA-256", () => {
    let state = opened();
    state = peer.applyRoundPair(
      state,
      pair(state, discussion([{ kind: "propose", ...claim("Alternative") }]), discussion())
    );
    expect(peer.PeerSessionSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true);
    const report = peer.buildPeerReport(state);
    expect(report.resultVersion).toBe("peer.v1");
    expect(peer.PeerResultV1Schema.safeParse(report).success).toBe(true);
    const source = peer.createPeerSession(config(), [{ sourceId: "s", content: "abc", segmentId: 1 }]);
    expect(source.sources[0]?.contentHash).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
  it("hashes a copied source across multiple SHA-256 blocks", () => {
    const source = peer.createPeerSession(config(), [{ sourceId: "long", content: "a".repeat(1000), segmentId: 1 }]);
    expect(source.sources[0]?.contentHash).toBe(
      "sha256:41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );
  });
  it("metadata-only commits and budget extensions cannot alter frozen requests or validation", () => {
    const state = create();
    const request = peer.buildMemberRequest(state, "member-b");
    const reply = pair(state, opening("A"), opening("B"))[1];
    const next = structuredClone(state);
    next.revision += 4;
    next.status = "paused";
    next.eventSeq += 4;
    next.segments[0]!.maxCalls += 2;
    next.segments[0]!.deadline = "2026-10-14T00:00:00.000Z";
    expect(peer.buildMemberRequest(next, "member-b").inputHash).toBe(request.inputHash);
    expect(peer.buildMemberRequest(next, "member-b").snapshotId).toBe(request.snapshotId);
    expect(peer.validateMemberReply(next, reply).payload.phase).toBe("opening");
  });
});
