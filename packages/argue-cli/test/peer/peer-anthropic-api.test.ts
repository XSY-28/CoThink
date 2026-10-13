import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PeerRuntimeFailure, type MemberRequest } from "@onevcat/argue";
import { createPeerApiRuntime, validatePeerApiRequest } from "../../src/runtime/peer-api.js";

const fakeKey = "unique-fake-native-key-73";
const validContent = JSON.stringify({ phase: "opening", conclusion: "Yes", evidenceRequests: [], claims: [] });
let server: Server | undefined;

async function localServer(response: { body?: unknown; status?: number; hold?: boolean }) {
  const requests: { path?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  let observed!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    observed = resolve;
  });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    observed();
    if (response.hold) return;
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local address");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, requestSeen };
}

function request(baseUrl: string, overrides: Partial<MemberRequest> = {}): MemberRequest {
  return {
    protocol: "anthropic-compatible",
    baseUrl,
    modelId: "native-model",
    apiKeyEnv: "FAKE_PEER_KEY",
    outputMode: "prompt_json",
    generationOptions: { temperature: 0.3, top_k: 5 },
    maxOutputTokens: 100,
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Frozen question" }
    ],
    jobId: "job",
    memberId: "member-a",
    snapshotId: "snapshot",
    sharedSnapshotId: "snapshot",
    phase: "opening",
    inputHash: "hash",
    deadline: "2026-10-14T00:00:00.000Z",
    sharedContext: {} as MemberRequest["sharedContext"],
    outputSchema: {},
    ...overrides
  };
}

function completion(
  content: unknown[] = [{ type: "text", text: validContent }],
  stopReason: string | null = "end_turn"
) {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    model: "returned-native-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 9, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }
  };
}
const runtime = createPeerApiRuntime({ FAKE_PEER_KEY: fakeKey });

afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("native Anthropic peer transport", () => {
  it("redacts scoped other peer keys from native text and model while retaining actual auth", async () => {
    const otherKey = `${fakeKey}-native-other-peer`;
    const escaped = `\\u0075${otherKey.slice(1)}`;
    const scopedRuntime = createPeerApiRuntime({ FAKE_PEER_KEY: fakeKey, OTHER_PEER_KEY: otherKey }, [
      "OTHER_PEER_KEY"
    ]);
    const local = await localServer({
      body: {
        ...completion([{ type: "text", text: `{"literal":"${otherKey}","escaped":"${escaped}","own":"${fakeKey}"}` }]),
        model: otherKey
      }
    });
    const reply = await scopedRuntime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply.payload).toEqual({ literal: "[REDACTED]", escaped: "[REDACTED]", own: "[REDACTED]" });
    expect(reply.modelId).toBe("[REDACTED]");
    expect(reply.rawContent).not.toContain("native-other-peer");
    expect(local.requests[0]?.headers["x-api-key"]).toBe(fakeKey);
  });

  it("redacts scoped other peer keys from native invalid stop reason diagnostics", async () => {
    const otherKey = "another-peer-credential-for-stop";
    const scopedRuntime = createPeerApiRuntime({ FAKE_PEER_KEY: fakeKey, OTHER_PEER_KEY: otherKey }, [
      "OTHER_PEER_KEY"
    ]);
    const local = await localServer({ body: completion(undefined, otherKey) });
    let failure: unknown;
    try {
      await scopedRuntime.respond(request(local.baseUrl), new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      peerError: { code: "invalid_finish_reason" },
      runtime: { finishReason: "[REDACTED]" }
    });
    expect(JSON.stringify(failure)).not.toContain(otherKey);
  });
  it("preflights native unsupported tuning without a credential or connection", () => {
    expect(() =>
      validatePeerApiRequest(request("https://example.invalid/v1", { generationOptions: { mcpServers: [] } }))
    ).toThrow(PeerRuntimeFailure);
    expect(() => validatePeerApiRequest(request("https://example.invalid/v1"))).not.toThrow();
  });

  it("preflights unsupported protocols and native output mode while preserving OpenAI options", () => {
    expect(() => validatePeerApiRequest(request("https://example.invalid/v1", { protocol: "unsupported" }))).toThrow(
      PeerRuntimeFailure
    );
    expect(() => validatePeerApiRequest(request("https://example.invalid/v1", { outputMode: "json_object" }))).toThrow(
      PeerRuntimeFailure
    );
    expect(() =>
      validatePeerApiRequest(
        request("https://example.invalid/v1", {
          protocol: "openai-compatible",
          outputMode: "json_object",
          generationOptions: { custom_provider_option: 7 }
        })
      )
    ).not.toThrow();
  });
  it("sends native auth, system, frozen messages and tuning without a structured-output tool", async () => {
    const local = await localServer({
      body: completion([
        { type: "thinking", thinking: "not final JSON", signature: "sig" },
        { type: "text", text: validContent.slice(0, 20) },
        { type: "text", text: validContent.slice(20) }
      ])
    });
    const reply = await runtime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply).toMatchObject({
      payload: JSON.parse(validContent),
      rawContent: validContent,
      modelId: "returned-native-model",
      finishReason: "stop",
      protocol: "anthropic-compatible",
      usage: { inputTokens: 15, outputTokens: 9, totalTokens: 24 }
    });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]).toMatchObject({
      path: "/v1/messages",
      headers: { "x-api-key": fakeKey, "anthropic-version": "2023-06-01" },
      body: {
        model: "native-model",
        max_tokens: 100,
        temperature: 0.3,
        top_k: 5,
        system: [{ type: "text", text: "Return JSON." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Frozen question" }] }]
      }
    });
    expect(local.requests[0].headers).not.toHaveProperty("authorization");
    for (const field of ["response_format", "tools", "tool_choice", "output_config"])
      expect(local.requests[0].body).not.toHaveProperty(field);
  });

  it("does not retain previous calls as hidden history", async () => {
    const local = await localServer({ body: completion() });
    await runtime.respond(request(local.baseUrl), new AbortController().signal);
    await runtime.respond(
      request(local.baseUrl, { messages: [{ role: "user", content: "Only second turn" }] }),
      new AbortController().signal
    );
    expect(local.requests).toHaveLength(2);
    expect(local.requests[1].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Only second turn" }] }
    ]);
    expect(local.requests[1].body).not.toHaveProperty("system");
  });

  it("maps native thinking budget and preserves the declared total output cap", async () => {
    const local = await localServer({ body: completion() });
    await runtime.respond(
      request(local.baseUrl, {
        maxOutputTokens: 2048,
        generationOptions: { thinking: { type: "enabled", budget_tokens: 1024 } }
      }),
      new AbortController().signal
    );
    expect(local.requests[0].body).toMatchObject({
      max_tokens: 2048,
      thinking: { type: "enabled", budget_tokens: 1024 }
    });
  });

  it("maps top_p and stop_sequences into the native wire format", async () => {
    const local = await localServer({ body: completion() });
    await runtime.respond(
      request(local.baseUrl, { generationOptions: { top_p: 0.9, stop_sequences: ["DONE"], effort: "low" } }),
      new AbortController().signal
    );
    expect(local.requests[0].body).toMatchObject({
      top_p: 0.9,
      stop_sequences: ["DONE"],
      output_config: { effort: "low" }
    });
  });

  it.each([
    { temperature: "0.3" },
    { top_p: 2 },
    { top_k: -1 },
    { stop_sequences: [42] },
    { reasoning_effort: "low" },
    { mcpServers: [{ type: "url", name: "hidden", url: "https://example.com" }] },
    { thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 0.3 },
    { thinking: { type: "enabled", budget_tokens: 1024, budgetTokens: 2048 } }
  ])("rejects invalid or unsupported native generation options %j without HTTP", async (generationOptions) => {
    const local = await localServer({ body: completion() });
    await expect(
      runtime.respond(
        request(local.baseUrl, { maxOutputTokens: 4096, generationOptions }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ peerError: { code: "invalid_generation_options", retryable: false } });
    expect(local.requests).toHaveLength(0);
  });

  it("includes all native usage iterations when compaction was reported", async () => {
    const body = completion();
    const local = await localServer({
      body: {
        ...body,
        usage: {
          ...body.usage,
          iterations: [
            { type: "compaction", input_tokens: 12, output_tokens: 5 },
            { type: "message", input_tokens: 8, output_tokens: 9 }
          ]
        }
      }
    });
    const reply = await runtime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply.usage).toEqual({ inputTokens: 27, outputTokens: 14, totalTokens: 41 });
  });

  it.each([
    [[], "end_turn", "empty_content"],
    [[{ type: "thinking", thinking: validContent, signature: "sig" }], "end_turn", "empty_content"],
    [[{ type: "text", text: "" }], "end_turn", "empty_content"],
    [[{ type: "text", text: "{broken" }], "end_turn", "malformed_json"],
    [[{ type: "text", text: validContent }], "max_tokens", "truncated_output"],
    [[{ type: "text", text: validContent }], "stop_sequence", "invalid_finish_reason"],
    [[{ type: "text", text: validContent }], "unknown", "invalid_finish_reason"],
    [[{ type: "text", text: validContent }], null, "invalid_finish_reason"],
    [[{ type: "tool_use", id: "tool-1", name: "json", input: {} }], "tool_use", "invalid_finish_reason"],
    [
      [
        { type: "text", text: validContent },
        { type: "tool_use", id: "tool-1", name: "json", input: {} }
      ],
      "end_turn",
      "invalid_finish_reason"
    ]
  ])("rejects final blocks %j stopped with %s", async (content, stopReason, code) => {
    const local = await localServer({ body: completion(content, stopReason) });
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code, retryable: true },
      runtime: { modelId: "returned-native-model", usage: { inputTokens: 15, outputTokens: 9, totalTokens: 24 } }
    });
    expect(local.requests).toHaveLength(1);
  });

  it("keeps parseable truncated payload as evidence", async () => {
    const local = await localServer({ body: completion(undefined, "max_tokens") });
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code: "truncated_output" },
      rawContent: validContent,
      payload: JSON.parse(validContent),
      runtime: { finishReason: "length" }
    });
  });

  it("redacts decoded final JSON keys, values and returned model", async () => {
    const escaped = "\\u0075nique-fake-native-key-73";
    const content = `{"conclusion":"${escaped}","${escaped}":"${escaped}"}`;
    const local = await localServer({ body: { ...completion([{ type: "text", text: content }]), model: fakeKey } });
    const reply = await runtime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply.payload).toEqual({ conclusion: "[REDACTED]", "[REDACTED]": "[REDACTED]" });
    expect(reply.modelId).toBe("[REDACTED]");
    expect(JSON.stringify(JSON.parse(reply.rawContent))).not.toContain(fakeKey);
  });

  it("retains redacted malformed HTTP 200 envelope and actual usage", async () => {
    const envelope =
      '{"error":{"message":"\\u0075nique-fake-native-key-73"},"model":"actual-model","usage":{"input_tokens":4,"cache_read_input_tokens":3}}';
    const local = await localServer({ body: envelope });
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code: "invalid_http_response" },
      payload: { error: { message: "[REDACTED]" } },
      runtime: { modelId: "actual-model", usage: { inputTokens: 7 } }
    });
  });

  it("retains invalid HTTP 200 text without accepting it", async () => {
    const local = await localServer({ body: "not-json-response" });
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code: "invalid_http_response" },
      rawContent: "not-json-response",
      runtime: { usage: {} }
    });
  });

  it.each([
    [401, "authentication_failed", false],
    [429, "rate_limited", true]
  ])("classifies HTTP %i without retrying", async (status, code, retryable) => {
    const local = await localServer({
      status,
      body: { type: "error", error: { type: "api_error", message: fakeKey } }
    });
    let failure: unknown;
    try {
      await runtime.respond(request(local.baseUrl), new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PeerRuntimeFailure);
    expect(failure).toMatchObject({ peerError: { code, retryable } });
    expect(JSON.stringify(failure)).not.toContain(fakeKey);
    expect(local.requests).toHaveLength(1);
  });

  it.each([
    ["cancelled", false],
    ["request_timeout", true]
  ])("aborts live HTTP as %s", async (code, timeout) => {
    const local = await localServer({ hold: true });
    const controller = new AbortController();
    const pending = runtime.respond(request(local.baseUrl), controller.signal);
    await Promise.race([local.requestSeen, pending]);
    controller.abort(timeout ? new DOMException("Deadline", "TimeoutError") : undefined);
    await expect(pending).rejects.toMatchObject({ peerError: { code, retryable: true } });
    expect(local.requests).toHaveLength(1);
  });

  it("rejects native json_object mode before sending", async () => {
    const local = await localServer({ body: completion() });
    await expect(
      runtime.respond(request(local.baseUrl, { outputMode: "json_object" }), new AbortController().signal)
    ).rejects.toMatchObject({ peerError: { code: "unsupported_output_mode", retryable: false } });
    expect(local.requests).toHaveLength(0);
  });
});
