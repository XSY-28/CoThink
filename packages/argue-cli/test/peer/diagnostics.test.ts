import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  PeerRuntimeFailure,
  type MemberId,
  type MemberRequest,
  type MemberRuntime,
  type PeerMemberConfig,
  type RuntimeReply
} from "@onevcat/argue";
import { testPeerConnections } from "../../src/peer/diagnostics.js";

const env = { TEST_A: "synthetic-a-key-119", TEST_B: "synthetic-b-key-291" };
const members: Record<MemberId, PeerMemberConfig> = {
  "member-a": {
    id: "member-a",
    protocol: "openai-compatible",
    modelId: "model-a",
    baseUrl: "https://example.invalid/v1",
    apiKeyEnv: "TEST_A",
    outputMode: "json_object",
    generationOptions: { temperature: 0.3 }
  },
  "member-b": {
    id: "member-b",
    protocol: "openai-compatible",
    modelId: "model-b",
    baseUrl: "https://example.invalid/v1",
    apiKeyEnv: "TEST_B",
    outputMode: "json_object",
    generationOptions: { reasoning_effort: "low" }
  }
};
function payload(request: MemberRequest): unknown {
  return request.phase === "opening"
    ? {
        phase: "opening",
        conclusion: "Probe answer is not a quality judgment",
        claims: [{ statement: "ACTUAL_OPENING_NOT_REVIEWED", rationale: "Synthetic", assumptions: [], sourceRefs: [] }],
        evidenceRequests: []
      }
    : {
        phase: "review",
        conclusion: "Format checked",
        reviewSetHash: request.sharedContext.reviewSetHash,
        positions: request.sharedContext.reviewVersions.map((versionId) => ({
          versionId,
          stance: "uncertain",
          rationale: "Synthetic connection test",
          sourceRefs: []
        })),
        evidenceRequests: []
      };
}
function response(request: MemberRequest, value = payload(request)): RuntimeReply {
  return {
    modelId: request.modelId,
    protocol: request.protocol,
    generationOptions: request.generationOptions,
    usage: { inputTokens: 5, outputTokens: 10 },
    finishReason: "stop",
    rawContent: JSON.stringify(value),
    payload: value
  };
}
function recorder(
  handler: (request: MemberRequest, signal: AbortSignal) => Promise<RuntimeReply> = async (request) => response(request)
) {
  const requests: MemberRequest[] = [];
  const signals: AbortSignal[] = [];
  const runtime: MemberRuntime = {
    respond(request, signal) {
      requests.push(structuredClone(request));
      signals.push(signal);
      return handler(request, signal);
    }
  };
  return { runtime, requests, signals };
}
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("bounded peer connection diagnostics", () => {
  it("makes exactly four calls with shared source-free v5 contexts and separately authored synthetic review versions", async () => {
    const captured = recorder();
    const report = await testPeerConnections(members, env, { runtime: captured.runtime });
    expect(report.ok).toBe(true);
    expect(report.calls).toBe(4);
    expect(report.results.map((result) => result.checks.map((check) => [check.phase, check.ok]))).toEqual([
      [
        ["opening", true],
        ["review", true]
      ],
      [
        ["opening", true],
        ["review", true]
      ]
    ]);
    expect(captured.requests).toHaveLength(4);
    for (const phase of ["opening", "review"]) {
      const phaseRequests = captured.requests.filter((request) => request.phase === phase);
      expect(phaseRequests[0]!.sharedContext).toEqual(phaseRequests[1]!.sharedContext);
      expect(phaseRequests[0]!.messages.at(-1)).toEqual(phaseRequests[1]!.messages.at(-1));
      expect(phaseRequests[0]!.snapshotId).toBe(phaseRequests[1]!.snapshotId);
      expect(phaseRequests[0]!.sharedContext.sources).toEqual([]);
      expect(phaseRequests[0]!.messages[0]!.content).toContain("peer-v5");
      expect(JSON.parse(phaseRequests[0]!.messages.at(-1)!.content)).toHaveProperty("responseContract");
    }
    const review = captured.requests.find((request) => request.phase === "review")!;
    expect(review.sharedContext.reviewVersions).toHaveLength(2);
    expect(review.sharedContext.claimVersions.map((version) => version.authorId)).toEqual(["member-a", "member-b"]);
    expect(JSON.stringify(review.sharedContext)).not.toContain("ACTUAL_OPENING_NOT_REVIEWED");
    expect(review.sharedContext.question).toMatch(/synthetic|connection/iu);
    expect(JSON.stringify(report)).not.toContain("rawContent");
    expect(report.results[0]!.checks[0]!.usage).toEqual({ inputTokens: 5, outputTokens: 10 });
    expect(captured.requests.every((request) => request.maxOutputTokens === 2048)).toBe(true);
  });

  it("selects one member and preserves configured transport, model, env name and generation options", async () => {
    const captured = recorder();
    const report = await testPeerConnections(
      members,
      { TEST_B: env.TEST_B },
      { memberId: "member-b", runtime: captured.runtime, maxOutputTokens: 1800 }
    );
    expect(report.ok).toBe(true);
    expect(report.calls).toBe(2);
    expect(report.results.map((result) => result.memberId)).toEqual(["member-b"]);
    expect(
      captured.requests.every((request) => request.memberId === "member-b" && request.maxOutputTokens === 1800)
    ).toBe(true);
    expect(captured.requests[0]).toMatchObject({
      modelId: "model-b",
      apiKeyEnv: "TEST_B",
      baseUrl: members["member-b"].baseUrl,
      generationOptions: { reasoning_effort: "low" }
    });
  });

  it("preflights every selected credential before any call", async () => {
    const captured = recorder();
    const report = await testPeerConnections(
      members,
      { TEST_A: env.TEST_A, TEST_B: "  " },
      { runtime: captured.runtime }
    );
    expect(report).toMatchObject({ ok: false, calls: 0 });
    expect(captured.requests).toEqual([]);
    expect(report.results.find((result) => result.memberId === "member-b")!.checks[0]).toMatchObject({
      ok: false,
      error: { code: "missing_api_key" }
    });
  });

  it.each([
    { protocol: "unsupported" },
    { protocol: "anthropic-compatible", outputMode: "json_object" },
    { baseUrl: "file:///tmp/no-api" },
    { baseUrl: "https://user:password@example.invalid" },
    { apiKeyEnv: "BAD ENV" },
    { generationOptions: { max_retries: 2 } },
    { maxInputCharacters: 1 },
    { id: "member-a" }
  ])("rejects invalid local selected configuration with zero calls: %j", async (overrides) => {
    const captured = recorder();
    const config = { ...members, "member-b": { ...members["member-b"], ...overrides } } as Record<
      MemberId,
      PeerMemberConfig
    >;
    const report = await testPeerConnections(config, env, { runtime: captured.runtime });
    expect(report.ok).toBe(false);
    expect(report.calls).toBe(0);
    expect(captured.requests).toEqual([]);
  });

  it.each([0, -1, NaN, Infinity, 2147483648])("rejects an invalid deadline before any call: %s", async (timeoutMs) => {
    const captured = recorder();
    const report = await testPeerConnections(members, env, { timeoutMs, runtime: captured.runtime });
    expect(report).toMatchObject({ ok: false, calls: 0 });
    expect(captured.requests).toEqual([]);
  });

  it.each([
    { reasoning_effort: "low" },
    { temperature: "0.3" },
    { top_p: 2 },
    { top_k: -1 },
    { stop_sequences: [42] },
    { thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 0.3 },
    { thinking: { type: "enabled", budget_tokens: 4096 } }
  ])("preflights native provider tuning before either member spends quota: %j", async (generationOptions) => {
    const captured = recorder();
    const config = {
      ...members,
      "member-b": {
        ...members["member-b"],
        protocol: "anthropic-compatible",
        outputMode: "prompt_json" as const,
        generationOptions
      }
    };
    const report = await testPeerConnections(config, env, { runtime: captured.runtime });
    expect(report).toMatchObject({ ok: false, calls: 0 });
    expect(captured.requests).toEqual([]);
    expect(report.results[1]!.checks[0]!.error?.code).toBe("invalid_generation_options");
  });

  it("does not retry or review a failed opening and still checks the independent member", async () => {
    const captured = recorder(async (request) => {
      if (request.memberId === "member-a")
        throw new PeerRuntimeFailure({
          code: "authentication_failed",
          message: `Echoed ${env.TEST_A} ${env.TEST_B} raw private provider data`,
          retryable: false
        });
      return response(request);
    });
    const report = await testPeerConnections(members, env, { runtime: captured.runtime });
    expect(report.ok).toBe(false);
    expect(report.calls).toBe(3);
    expect(
      captured.requests.filter((request) => request.memberId === "member-a").map((request) => request.phase)
    ).toEqual(["opening"]);
    expect(report.results[1]!.checks.map((check) => check.ok)).toEqual([true, true]);
    expect(JSON.stringify(report)).not.toContain(env.TEST_A);
    expect(JSON.stringify(report)).not.toContain(env.TEST_B);
    expect(JSON.stringify(report)).not.toContain("raw private provider data");
  });

  it.each([
    {},
    { conclusion: "no phase", claims: [] },
    { phase: "opening", conclusion: "wrong shape", claims: ["a"] },
    { phase: "opening", conclusion: "no claims" },
    {
      phase: "opening",
      conclusion: "forged author",
      claims: [{ statement: "s", rationale: "r", authorId: "member-b" }]
    },
    {
      phase: "opening",
      conclusion: "invented source",
      claims: [{ statement: "s", rationale: "r", sourceRefs: [{ sourceId: "fake", startLine: 1, endLine: 1 }] }]
    }
  ])("rejects malformed opening without substituting content or calling review: %j", async (value) => {
    const captured = recorder(async (request) => response(request, value));
    const report = await testPeerConnections(members, env, { memberId: "member-a", runtime: captured.runtime });
    expect(report).toMatchObject({ ok: false, calls: 1 });
    expect(report.results[0]!.checks).toHaveLength(1);
    expect(report.results[0]!.checks[0]).toMatchObject({ error: { code: "invalid_peer_reply" } });
  });

  it.each([
    "missing-phase",
    "missing-hash",
    "wrong-hash",
    "missing-position",
    "duplicate-position",
    "unknown-version",
    "fake-source",
    "forged-author"
  ])("rejects %s frozen review", async (defect) => {
    const captured = recorder(async (request) => {
      if (request.phase === "opening") return response(request);
      const value = payload(request) as {
        phase?: string;
        reviewSetHash?: string;
        positions: Array<Record<string, unknown>>;
      };
      if (defect === "missing-phase") delete value.phase;
      if (defect === "missing-hash") delete value.reviewSetHash;
      if (defect === "wrong-hash") value.reviewSetHash = "wrong";
      if (defect === "missing-position") value.positions.pop();
      if (defect === "duplicate-position") value.positions[1] = value.positions[0]!;
      if (defect === "unknown-version") value.positions[0]!.versionId = "unknown";
      if (defect === "fake-source")
        value.positions[0]!.sourceRefs = [{ sourceId: "invented", startLine: 1, endLine: 1 }];
      if (defect === "forged-author") value.positions[0]!.authorId = "member-b";
      return response(request, value);
    });
    const report = await testPeerConnections(members, env, { memberId: "member-a", runtime: captured.runtime });
    expect(report).toMatchObject({ ok: false, calls: 2 });
    expect(report.results[0]!.checks[1]).toMatchObject({ ok: false, error: { code: "invalid_peer_reply" } });
  });

  it("allows only the shared core's cosmetic metadata normalization", async () => {
    const captured = recorder(async (request) => {
      const value = payload(request) as Record<string, unknown>;
      delete value.evidenceRequests;
      value.note = "cosmetic";
      if (request.phase === "opening")
        value.claims = [{ statement: "synthetic", rationale: "reason", note: "cosmetic" }];
      return response(request, value);
    });
    expect((await testPeerConnections(members, env, { runtime: captured.runtime })).ok).toBe(true);
  });

  it("hard-bounds an uncooperative runtime and aborts each timed out request", async () => {
    const captured = recorder(async () => new Promise<RuntimeReply>(() => {}));
    const started = Date.now();
    const report = await testPeerConnections(members, env, { timeoutMs: 20, runtime: captured.runtime });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(report).toMatchObject({ ok: false, calls: 2 });
    expect(report.results.every((result) => result.checks[0]!.error?.code === "request_timeout")).toBe(true);
    expect(captured.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("makes zero calls when already cancelled", async () => {
    const captured = recorder();
    const report = await testPeerConnections(members, env, { runtime: captured.runtime, signal: AbortSignal.abort() });
    expect(report).toMatchObject({ ok: false, calls: 0 });
    expect(captured.requests).toEqual([]);
  });

  it("stops dispatching after cancellation and hard-bounds an uncooperative running request", async () => {
    const controller = new AbortController();
    const captured = recorder(async () => {
      controller.abort();
      return new Promise<RuntimeReply>(() => {});
    });
    const report = await testPeerConnections(members, env, { runtime: captured.runtime, signal: controller.signal });
    expect(report).toMatchObject({ ok: false, calls: 1 });
    expect(captured.signals[0]!.aborted).toBe(true);
    expect(report.results.some((result) => result.checks.some((check) => check.error?.code === "cancelled"))).toBe(
      true
    );
  });

  it.each(["openai-compatible", "anthropic-compatible"] as const)(
    "uses real %s loopback transport with bounded caps and no extra calls",
    async (protocol) => {
      const requests: Record<string, unknown>[] = [];
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
          messages: Array<{ content: string | Array<{ type: string; text: string }> }>;
        };
        requests.push(body);
        const lastContent = body.messages.at(-1)!.content;
        const context = JSON.parse(
          typeof lastContent === "string" ? lastContent : lastContent[0]!.text
        ) as MemberRequest["sharedContext"];
        const value =
          context.phase === "opening"
            ? { phase: "opening", conclusion: "Synthetic", claims: [], evidenceRequests: [] }
            : {
                phase: "review",
                conclusion: "Synthetic",
                reviewSetHash: context.reviewSetHash,
                evidenceRequests: [],
                positions: context.reviewVersions.map((versionId) => ({
                  versionId,
                  stance: "uncertain",
                  rationale: "Synthetic",
                  sourceRefs: []
                }))
              };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...(protocol === "anthropic-compatible"
              ? {
                  id: "test",
                  type: "message",
                  role: "assistant",
                  model: body.model,
                  content: [{ type: "text", text: JSON.stringify(value) }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 10, output_tokens: 20 }
                }
              : {
                  id: "test",
                  object: "chat.completion",
                  created: 1,
                  model: body.model,
                  choices: [
                    { index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 20 }
                })
          })
        );
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback address");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const report = await testPeerConnections(
        {
          "member-a": {
            ...members["member-a"],
            baseUrl,
            protocol,
            outputMode: protocol === "anthropic-compatible" ? "prompt_json" : "json_object"
          },
          "member-b": {
            ...members["member-b"],
            baseUrl,
            protocol,
            outputMode: protocol === "anthropic-compatible" ? "prompt_json" : "json_object",
            generationOptions:
              protocol === "anthropic-compatible" ? { top_k: 5 } : members["member-b"].generationOptions
          }
        },
        env,
        { maxOutputTokens: 256 }
      );
      expect(report).toMatchObject({ ok: true, calls: 4 });
      expect(requests).toHaveLength(4);
      expect(requests.every((request) => request.max_tokens === 256)).toBe(true);
      expect(requests.map((request) => request.model)).toEqual(["model-a", "model-a", "model-b", "model-b"]);
    }
  );
});
