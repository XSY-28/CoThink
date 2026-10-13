import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PeerRuntimeFailure, type MemberRequest } from "@onevcat/argue";
import { createPeerApiRuntime } from "../../src/runtime/peer-api.js";

const fakeKey = "unique-fake-key-for-redaction-73";
const validContent = JSON.stringify({ phase: "opening", conclusion: "Yes", evidenceRequests: [], claims: [] });
type Reply = { status?: number; body?: unknown; hold?: boolean };
let server: Server | undefined;

async function localServer(reply: (request: Record<string, unknown>) => Reply) {
  const requests: Record<string, unknown>[] = [];
  const headers: IncomingHttpHeaders[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(body);
    headers.push(req.headers);
    const result = reply(body);
    if (result.hold) return;
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local address");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, headers };
}

function request(baseUrl: string, overrides: Partial<MemberRequest> = {}): MemberRequest {
  return {
    protocol: "openai-compatible",
    baseUrl,
    modelId: "test-model",
    apiKeyEnv: "FAKE_PEER_KEY",
    outputMode: "json_object",
    generationOptions: { thinking: { type: "disabled" }, temperature: 0.3 },
    maxOutputTokens: 100,
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Question one" }
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
function completion(content: string | null, finishReason = "stop", usage?: Record<string, number>) {
  return {
    id: "reply-1",
    object: "chat.completion",
    created: 1,
    model: "returned-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", reasoning_content: "not final JSON", content },
        finish_reason: finishReason
      }
    ],
    ...(usage ? { usage } : {})
  };
}
const runtime = createPeerApiRuntime({ FAKE_PEER_KEY: fakeKey });

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("peer API transport", () => {
  it("redacts explicitly scoped peer credentials longest-first while authenticating with the current key", async () => {
    const otherKey = `${fakeKey}-other-peer`;
    const escapedOther = `\\u0075${otherKey.slice(1)}`;
    const scopedRuntime = createPeerApiRuntime(
      { FAKE_PEER_KEY: fakeKey, OTHER_PEER_KEY: otherKey, ORDINARY_SETTING: "ordinary-value" },
      ["FAKE_PEER_KEY", "OTHER_PEER_KEY"]
    );
    const body = completion(
      `{"literal":"${otherKey}","escaped":"${escapedOther}","${escapedOther}":"${fakeKey}","ordinary":"ordinary-value"}`
    );
    body.model = otherKey;
    const local = await localServer(() => ({ body }));
    const reply = await scopedRuntime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply.payload).toEqual({
      literal: "[REDACTED]",
      escaped: "[REDACTED]",
      "[REDACTED]": "[REDACTED]",
      ordinary: "ordinary-value"
    });
    expect(reply.modelId).toBe("[REDACTED]");
    expect(local.headers[0]?.authorization).toBe(`Bearer ${fakeKey}`);
    expect(JSON.stringify(reply)).not.toContain(otherKey);
    expect(reply.rawContent).not.toContain("other-peer");
  });

  it.each([200, 401])(
    "redacts other peer credentials in HTTP %i failures including Unicode escapes",
    async (status) => {
      const otherKey = "second-credential-for-peer";
      const escaped = "\\u0073econd-credential-for-peer";
      const scopedRuntime = createPeerApiRuntime({ FAKE_PEER_KEY: fakeKey, OTHER_PEER_KEY: otherKey }, [
        "OTHER_PEER_KEY"
      ]);
      const local = await localServer(() => ({
        status,
        body: status === 200 ? `broken ${escaped}` : { error: { message: `literal ${otherKey}, escaped ${escaped}` } }
      }));
      let failure: unknown;
      try {
        await scopedRuntime.respond(request(local.baseUrl), new AbortController().signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(PeerRuntimeFailure);
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain(otherKey);
      expect(serialized).not.toContain("econd-credential-for-peer");
      expect(serialized).toContain("[REDACTED]");
    }
  );
  it("sends explicit frozen messages, JSON mode, thinking and output cap; parses final content only", async () => {
    const local = await localServer(() => ({
      body: completion(validContent, "stop", { prompt_tokens: 8, completion_tokens: 9 })
    }));
    const reply = await runtime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply.payload).toEqual(JSON.parse(validContent));
    expect(reply.rawContent).toBe(validContent);
    expect(reply.modelId).toBe("returned-model");
    expect(reply.usage).toEqual({ inputTokens: 8, outputTokens: 9 });
    expect(reply.finishReason).toBe("stop");
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]).toMatchObject({
      model: "test-model",
      max_tokens: 100,
      temperature: 0.3,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "Question one" }
      ]
    });
  });

  it("passes a frozen GLM reasoning_effort option through the real HTTP request", async () => {
    const local = await localServer(() => ({ body: completion(validContent) }));
    await runtime.respond(
      request(local.baseUrl, { generationOptions: { thinking: { type: "enabled" }, reasoning_effort: "low" } }),
      new AbortController().signal
    );
    expect(local.requests[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
  });

  it("omits response_format in prompt_json mode and sends only the supplied turn", async () => {
    const local = await localServer(() => ({ body: completion(validContent) }));
    await runtime.respond(
      request(local.baseUrl, { outputMode: "prompt_json", messages: [{ role: "user", content: "Frozen turn" }] }),
      new AbortController().signal
    );
    expect(local.requests[0]).not.toHaveProperty("response_format");
    expect(local.requests[0]).toMatchObject({ messages: [{ role: "user", content: "Frozen turn" }] });
  });

  it.each([
    ["empty", null, "stop", "empty_content"],
    ["empty string", "", "stop", "empty_content"],
    ["malformed", "{broken", "stop", "malformed_json"],
    ["truncated", validContent, "length", "truncated_output"]
  ])("rejects %s final content with observed metadata", async (_label, content, reason, code) => {
    const local = await localServer(() => ({
      body: completion(content, reason, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
    }));
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code, retryable: true },
      runtime: { modelId: "returned-model", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
    });
  });

  it("retains parseable truncated payload and never accepts an unknown finish reason", async () => {
    const local = await localServer(() => ({ body: completion(validContent, "length") }));
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code: "truncated_output" },
      payload: JSON.parse(validContent),
      rawContent: validContent
    });
  });

  it("records malformed HTTP 200 response body without converting it into success", async () => {
    const local = await localServer(() => ({ body: "not-json-response" }));
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code: "invalid_http_response" },
      rawContent: "not-json-response",
      runtime: { modelId: "test-model", usage: {} }
    });
  });

  it("retains a redacted HTTP 200 error envelope as diagnostic evidence", async () => {
    const escapedKey = "\\u0075nique-fake-key-for-redaction-73";
    const envelope = `{"error":{"message":"provider malformed envelope: ${escapedKey}"},"model":"actual-model","usage":{"prompt_tokens":4}}`;
    const local = await localServer(() => ({ body: envelope }));
    let failure: unknown;
    try {
      await runtime.respond(request(local.baseUrl), new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PeerRuntimeFailure);
    expect(failure).toMatchObject({
      peerError: { code: "invalid_http_response" },
      runtime: { modelId: "actual-model", usage: { inputTokens: 4 } },
      payload: { error: { message: "provider malformed envelope: [REDACTED]" } }
    });
    const rawContent = (failure as PeerRuntimeFailure).rawContent;
    expect(rawContent).toBeTruthy();
    expect(JSON.parse(rawContent!)).toMatchObject({ error: { message: "provider malformed envelope: [REDACTED]" } });
    expect(JSON.stringify(failure)).not.toContain(fakeKey);
  });

  it("keeps complete envelope null content empty despite nonempty reasoning", async () => {
    const local = await localServer(() => ({ body: completion(null, "stop", { prompt_tokens: 4 }) }));
    await expect(runtime.respond(request(local.baseUrl), new AbortController().signal)).rejects.toMatchObject({
      peerError: { code: "empty_content" },
      rawContent: "",
      runtime: { usage: { inputTokens: 4 } }
    });
  });

  it("redacts a loaded key echoed in successful metadata and final JSON", async () => {
    const body = completion(
      JSON.stringify({ phase: "opening", conclusion: fakeKey, evidenceRequests: [], claims: [] })
    );
    body.model = fakeKey;
    const local = await localServer(() => ({ body }));
    const reply = await runtime.respond(request(local.baseUrl), new AbortController().signal);
    expect(JSON.stringify(reply)).not.toContain(fakeKey);
    expect(reply.modelId).toBe("[REDACTED]");
    expect(reply.payload).toMatchObject({ conclusion: "[REDACTED]" });
  });

  it("redacts Unicode-escaped key values and object keys after decoding final JSON", async () => {
    const escapedKey = "\\u0075nique-fake-key-for-redaction-73";
    const content = `{"phase":"opening","conclusion":"${escapedKey}","evidenceRequests":[],"claims":[],"extra":[{"${escapedKey}":"${escapedKey}"}]}`;
    const local = await localServer(() => ({ body: completion(content) }));
    const reply = await runtime.respond(request(local.baseUrl), new AbortController().signal);
    expect(reply.payload).toMatchObject({ conclusion: "[REDACTED]", extra: [{ "[REDACTED]": "[REDACTED]" }] });
    expect(JSON.stringify(reply)).not.toContain(fakeKey);
    expect(JSON.stringify(JSON.parse(reply.rawContent))).not.toContain(fakeKey);
  });

  it.each([
    [401, "authentication_failed", false],
    [429, "rate_limited", true]
  ])("classifies HTTP %i and sends exactly once", async (status, code, retryable) => {
    const local = await localServer(() => ({ status, body: { error: { message: `bad ${fakeKey}` } } }));
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

  it("passes cancellation into the live HTTP call", async () => {
    const local = await localServer(() => ({ hold: true }));
    const controller = new AbortController();
    const pending = runtime.respond(request(local.baseUrl), controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ peerError: { code: "cancelled" } });
    expect(local.requests).toHaveLength(1);
  });

  it("classifies an AbortSignal timeout on the live HTTP call", async () => {
    const local = await localServer(() => ({ hold: true }));
    await expect(runtime.respond(request(local.baseUrl), AbortSignal.timeout(30))).rejects.toMatchObject({
      peerError: { code: "request_timeout", retryable: true }
    });
    expect(local.requests).toHaveLength(1);
  });
});
