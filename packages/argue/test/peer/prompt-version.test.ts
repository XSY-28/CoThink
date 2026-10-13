import { expect, it } from "vitest";
import { applyRoundPair, buildMemberRequest, createPeerSession, validateMemberReply } from "../../src/index.js";
import { makeConfig, makeDiscussionTurn, makeOpeningTurn, makePairFromTurns, makeSession } from "./fixtures.js";

it("keeps peer-v1 frozen opening input hash for previously stored sessions", () => {
  const config = {
    sessionId: "v1-hash",
    schemaVersion: 1 as const,
    question: "Q?",
    sourceCommit: "abc",
    createdAt: "2026-10-13T00:00:00.000Z",
    promptVersion: "peer-v1" as const,
    members: [
      {
        id: "member-a" as const,
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "a",
        apiKeyEnv: "A",
        outputMode: "json_object" as const,
        generationOptions: {}
      },
      {
        id: "member-b" as const,
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "b",
        apiKeyEnv: "B",
        outputMode: "json_object" as const,
        generationOptions: {}
      }
    ]
  };
  const state = createPeerSession(config);
  expect(buildMemberRequest(state, "member-a").inputHash).toBe(
    "sha256:d8bc3a8d4da03df3c11b1f62b4c6976ec57e4f5b4a7142e606c5b1b2d7b5ce0d"
  );
});

it("keeps peer-v2 frozen opening input hash for previously stored sessions", () => {
  const config = {
    sessionId: "v2-hash",
    schemaVersion: 1 as const,
    question: "Q?",
    sourceCommit: "abc",
    createdAt: "2026-10-13T00:00:00.000Z",
    promptVersion: "peer-v2" as const,
    members: [
      {
        id: "member-a" as const,
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "a",
        apiKeyEnv: "A",
        outputMode: "json_object" as const,
        generationOptions: {}
      },
      {
        id: "member-b" as const,
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "b",
        apiKeyEnv: "B",
        outputMode: "json_object" as const,
        generationOptions: {}
      }
    ]
  };
  expect(buildMemberRequest(createPeerSession(config), "member-a").inputHash).toBe(
    "sha256:7b7723657f3f3dcefb5af5423d6c39db944e201a647faa95a2ba5d4ed6866a51"
  );
});

it("keeps peer-v3 frozen opening input hash for previously stored sessions", () => {
  const state = createPeerSession({
    sessionId: "v3-hash",
    schemaVersion: 1,
    question: "Q?",
    sourceCommit: "abc",
    createdAt: "2026-10-13T00:00:00.000Z",
    promptVersion: "peer-v3" as never,
    members: [
      {
        id: "member-a",
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "a",
        apiKeyEnv: "A",
        outputMode: "json_object",
        generationOptions: {}
      },
      {
        id: "member-b",
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "b",
        apiKeyEnv: "B",
        outputMode: "json_object",
        generationOptions: {}
      }
    ]
  });
  expect(buildMemberRequest(state, "member-a").inputHash).toBe(
    "sha256:66990177563dd0b2a8441f52e2e116d6da30cba99d9ce01324fcf9faecd27a5d"
  );
});

it("v4 offers actor-specific legal action identifiers and symmetric input-size checks", () => {
  let state = makeSession({ phase: "discussion", claimCount: 2 });
  state.config.promptVersion = "peer-v4" as never;
  const [aVersion, bVersion] = state.claimVersions;
  state = applyRoundPair(
    state,
    makePairFromTurns(
      state,
      makeDiscussionTurn([
        { kind: "ask", target: { versionId: bVersion!.versionId }, rationale: "Why?", sourceRefs: [] }
      ]),
      makeDiscussionTurn()
    )
  );
  const messageId = state.messages[0]!.messageId;
  const a = buildMemberRequest(state, "member-a");
  const b = buildMemberRequest(state, "member-b");
  type Variant = { properties: { kind: { const: string } } & Record<string, { enum: string[] }> };
  const variants = (request: typeof a) =>
    (request.outputSchema.properties as unknown as { actions: { items: { oneOf: Variant[] } } }).actions.items.oneOf;
  const variant = (request: typeof a, kind: string) =>
    variants(request).find((item) => item.properties.kind.const === kind);
  expect(variant(a, "reply")).toBeUndefined();
  expect(variant(b, "reply")!.properties.replyTo!.enum).toEqual([messageId]);
  expect(variant(a, "challenge")!.properties.targetVersionId!.enum).toEqual([bVersion!.versionId]);
  expect(variant(b, "challenge")!.properties.targetVersionId!.enum).toEqual([aVersion!.versionId]);
  expect(variant(a, "revise")!.properties.targetVersionId!.enum).toEqual([aVersion!.versionId]);
  expect(variant(b, "revise")!.properties.targetVersionId!.enum).toEqual([bVersion!.versionId]);
  expect(variant(a, "propose")!.properties.alternativeToVersionId!.enum).toEqual([bVersion!.versionId]);
  expect(variant(b, "propose")!.properties.alternativeToVersionId!.enum).toEqual([aVersion!.versionId]);
  const aLength = a.messages.reduce((n, item) => n + item.content.length, 0);
  const bLength = b.messages.reduce((n, item) => n + item.content.length, 0);
  expect(aLength).not.toBe(bLength);
  const smaller = Math.min(aLength, bLength);
  state.config.members["member-a"].maxInputCharacters = smaller;
  state.config.members["member-b"].maxInputCharacters = smaller;
  expect(() => buildMemberRequest(state, "member-a")).toThrow(/Compiled input exceeds/);
  expect(() => buildMemberRequest(state, "member-b")).toThrow(/Compiled input exceeds/);
});

it("v3 constrains opening and discussion references to present namespaces", () => {
  const opening = makeSession();
  opening.config.promptVersion = "peer-v3" as never;
  const a = buildMemberRequest(opening, "member-a");
  const b = buildMemberRequest(opening, "member-b");
  expect(a.outputSchema).toEqual(b.outputSchema);
  expect(JSON.stringify(a.outputSchema)).not.toContain("targetVersionId");
  expect(JSON.stringify(a.outputSchema)).not.toContain("alternativeToVersionId");
  expect(JSON.stringify(a.outputSchema)).toContain('"enum":["source-1"]');
  expect(a.messages[0]!.content).toContain("jobId");
  expect(a.messages[0]!.content).toContain("not message IDs");
  const discussion = makeSession({ phase: "discussion", claimCount: 2 });
  discussion.config.promptVersion = "peer-v3" as never;
  const request = buildMemberRequest(discussion, "member-a");
  const schema = JSON.stringify(request.outputSchema);
  expect(schema).toContain(discussion.claimVersions[0]!.versionId);
  expect(schema).toContain(discussion.claimVersions[1]!.versionId);
  expect(schema).not.toContain('"replyTo"');
  expect(schema).not.toContain('"messageId"');
});

it("v3 constrains review positions and hash to the frozen review set", () => {
  const state = makeSession({ phase: "review", claimCount: 2 });
  state.config.promptVersion = "peer-v3" as never;
  const request = buildMemberRequest(state, "member-a");
  const properties = request.outputSchema.properties as Record<string, unknown>;
  expect(properties.reviewSetHash).toEqual({ const: state.segments[0]!.reviewSetHash });
  expect(JSON.stringify(properties.positions)).toContain(JSON.stringify(state.segments[0]!.reviewVersions));
});

it("v2 gives phase-specific valid identifier and shared action guidance", () => {
  const state = createPeerSession({ ...makeConfig(), promptVersion: "peer-v2" as never });
  const a = buildMemberRequest(state, "member-a");
  const b = buildMemberRequest(state, "member-b");
  expect(a.messages[0]!.content).toContain("omit alternativeToVersionId");
  expect(a.messages[0]!.content).toContain("omit targetVersionId");
  expect(a.messages[0]!.content).toContain("sourceRefs");
  expect(a.messages[0]!.content.replace("member-a", "member-b")).toBe(b.messages[0]!.content);
  const opened = applyRoundPair(state, makePairFromTurns(state, makeOpeningTurn(), makeOpeningTurn()));
  const discussion = buildMemberRequest(opened, "member-a").messages[0]!.content;
  expect(discussion).toContain("challenge and ask combined");
  expect(discussion).toContain("versionId");
  expect(discussion).toContain("reply actions are separate");
});

it("keeps peer-v4 frozen opening input hash for previously stored sessions", () => {
  const state = createPeerSession({ ...makeConfig("v4-hash"), promptVersion: "peer-v4" });
  expect(buildMemberRequest(state, "member-a").inputHash).toBe(
    "sha256:e43c56a2359a01e3390d41ddb790b7f4cdbb054192f0ddad956eac52641dccb1"
  );
});

it("defaults new sessions to v5 and rejects unknown prompt versions", () => {
  const input = makeConfig();
  delete (input as { promptVersion?: string }).promptVersion;
  expect(createPeerSession(input).config.promptVersion).toBe("peer-v5");
  expect(() => createPeerSession({ ...input, promptVersion: "peer-v6" as never })).toThrow();
});

it("v5 opening contract supplies phase and claim objects, without prewriting independent content", () => {
  const state = makeSession();
  state.config.promptVersion = "peer-v5" as never;
  const a = buildMemberRequest(state, "member-a");
  const b = buildMemberRequest(state, "member-b");
  expect(a.messages[1]).toEqual(b.messages[1]);
  const supplied = JSON.parse(a.messages[1]!.content);
  const { responseContract, ...context } = supplied;
  expect(context).toEqual(a.sharedContext);
  expect(a.messages[1]!.content.endsWith(JSON.stringify(responseContract) + "}")).toBe(true);
  expect(responseContract.requiredFields).toEqual(["phase", "conclusion", "evidenceRequests", "claims"]);
  expect(responseContract.template).toEqual({
    phase: "opening",
    conclusion: null,
    evidenceRequests: [],
    claims: [{ statement: null, rationale: null, assumptions: [], sourceRefs: [] }]
  });
  for (const member of ["member-a", "member-b"] as const) {
    const response = {
      ...responseContract.template,
      conclusion: "My position",
      claims: [{ statement: "A hypothesis", rationale: "Independent reason", assumptions: [], sourceRefs: [] }]
    };
    const [reply] = makePairFromTurns(state, response, response);
    const request = buildMemberRequest(state, member);
    expect(
      validateMemberReply(state, { ...reply, memberId: member, jobId: request.jobId, inputHash: request.inputHash })
        .payload
    ).toEqual(response);
    const { phase: _phase, ...missingPhase } = response;
    expect(_phase).toBe("opening");
    expect(() =>
      validateMemberReply(state, {
        ...reply,
        memberId: member,
        jobId: request.jobId,
        inputHash: request.inputHash,
        payload: missingPhase
      })
    ).toThrow();
  }
});

it("v5 review contract enumerates every frozen version with neutral unfilled judgments; omission stays invalid", () => {
  const state = makeSession({ phase: "review", claimCount: 6 });
  state.config.promptVersion = "peer-v5" as never;
  const a = buildMemberRequest(state, "member-a");
  const b = buildMemberRequest(state, "member-b");
  expect(a.messages[1]).toEqual(b.messages[1]);
  expect(a.outputSchema).toEqual(b.outputSchema);
  const { responseContract } = JSON.parse(a.messages[1]!.content);
  const template = responseContract.template;
  expect(template.phase).toBe("review");
  expect(template.reviewSetHash).toBe(state.segments[0]!.reviewSetHash);
  expect(template.positions.map((p: { versionId: string }) => p.versionId)).toEqual(state.segments[0]!.reviewVersions);
  expect(
    template.positions.every((p: { stance: unknown; rationale: unknown }) => p.stance === null && p.rationale === null)
  ).toBe(true);
  expect(responseContract.requiredFields).toEqual([
    "phase",
    "conclusion",
    "evidenceRequests",
    "reviewSetHash",
    "positions"
  ]);
  const schema = (a.outputSchema.properties as Record<string, unknown>).positions;
  expect(schema).toMatchObject({ minItems: 6, maxItems: 6 });
  for (const memberId of ["member-a", "member-b"] as const) {
    const request = buildMemberRequest(state, memberId);
    const response = {
      ...template,
      conclusion: "My assessment",
      positions: template.positions.map((p: { versionId: string }) => ({
        ...p,
        stance: "uncertain",
        rationale: "My independent reason"
      }))
    };
    const envelope = {
      memberId,
      jobId: request.jobId,
      snapshotId: request.snapshotId,
      inputHash: request.inputHash,
      payload: response
    };
    expect(validateMemberReply(state, envelope).payload).toEqual(response);
    const missing: Record<string, unknown> = { ...response };
    delete missing.reviewSetHash;
    delete missing.positions;
    for (const bad of [
      template,
      missing,
      { ...response, positions: response.positions.slice(1) },
      { ...response, reviewSetHash: "wrong" },
      { ...response, positions: [...response.positions, response.positions[0]] }
    ])
      expect(() => validateMemberReply(state, { ...envelope, payload: bad })).toThrow();
  }
});

it("v5 discussion contract routes required replies symmetrically and retains author-scoped references", () => {
  let state = makeSession({ phase: "discussion", claimCount: 2 });
  state.config.promptVersion = "peer-v5" as never;
  const [aVersion, bVersion] = state.claimVersions;
  state = applyRoundPair(
    state,
    makePairFromTurns(
      state,
      makeDiscussionTurn([
        { kind: "ask", target: { versionId: bVersion!.versionId }, rationale: "Why B?", sourceRefs: [] }
      ]),
      makeDiscussionTurn([
        { kind: "challenge", targetVersionId: aVersion!.versionId, rationale: "Why A?", sourceRefs: [] }
      ])
    )
  );
  const a = buildMemberRequest(state, "member-a");
  const b = buildMemberRequest(state, "member-b");
  expect(a.messages[1]).toEqual(b.messages[1]);
  const contract = JSON.parse(a.messages[1]!.content).responseContract;
  expect(contract.template).toEqual({
    phase: "discussion",
    conclusion: null,
    evidenceRequests: [],
    actions: [],
    readyToReview: null
  });
  expect(contract.requiredReplyIdsByMember).toEqual({
    "member-a": [state.messages[1]!.messageId],
    "member-b": [state.messages[0]!.messageId]
  });
  for (const request of [a, b]) {
    const actions = (
      request.outputSchema.properties as unknown as {
        actions: {
          items: {
            oneOf: Array<{
              properties: {
                kind: { const: string };
                replyTo?: { enum: string[] };
                targetVersionId?: { enum: string[] };
              };
            }>;
          };
        };
      }
    ).actions.items.oneOf;
    expect(actions.find((item) => item.properties.kind.const === "reply")!.properties.replyTo!.enum).toEqual([
      request.memberId === "member-a" ? state.messages[1]!.messageId : state.messages[0]!.messageId
    ]);
    expect(actions.find((item) => item.properties.kind.const === "revise")!.properties.targetVersionId!.enum).toEqual([
      request.memberId === "member-a" ? aVersion!.versionId : bVersion!.versionId
    ]);
    const empty = { ...contract.template, conclusion: "My position", readyToReview: false };
    expect(() =>
      validateMemberReply(state, {
        memberId: request.memberId,
        jobId: request.jobId,
        snapshotId: request.snapshotId,
        inputHash: request.inputHash,
        payload: empty
      })
    ).toThrow(/reply/i);
  }
  const lengths = [a, b].map((r) => r.messages.reduce((sum, m) => sum + m.content.length, 0));
  state.config.members["member-a"].maxInputCharacters = Math.max(...lengths) - 1;
  for (const member of ["member-a", "member-b"] as const)
    expect(() => buildMemberRequest(state, member)).toThrow(/Compiled input exceeds/);
});
