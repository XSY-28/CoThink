import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ModelTransportFailure, PeerRuntimeFailure, type ModelCall, type ModelTransport } from "@onevcat/argue";
import { createApiModelTransport } from "../../src/runtime/model-api.js";
import { peerModelCall, peerRuntimeFromTransport } from "../../src/runtime/peer-api.js";
import { buildMemberRequest, identifyStoredSession } from "@onevcat/argue";
import paused from "../../../argue/test/discussion/fixtures/peer-v5-paused.json" with { type: "json" };
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});
async function endpoint(protocol: string) {
  const bodies: unknown[] = [];
  const content = JSON.stringify({ answer: "fake-secret-key" });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        protocol === "openai-compatible"
          ? {
              id: "reply",
              object: "chat.completion",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
            }
          : {
              id: "reply",
              type: "message",
              role: "assistant",
              model: "test-model",
              stop_reason: "end_turn",
              stop_sequence: null,
              content: [{ type: "text", text: content }],
              usage: { input_tokens: 2, output_tokens: 3 }
            }
      )
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, bodies };
}
it.each(["openai-compatible", "anthropic-compatible"])(
  "accepts a narrow %s call and preserves the legacy wire body and redaction",
  async (protocol) => {
    const local = await endpoint(protocol);
    const call: ModelCall = {
      protocol,
      baseUrl: local.baseUrl,
      modelId: "test-model",
      apiKeyEnv: "KEY",
      outputMode: protocol === "openai-compatible" ? "json_object" : "prompt_json",
      messages: [
        { role: "system", content: "Return JSON" },
        { role: "user", content: "Q" }
      ],
      generationOptions: { temperature: 0.3 },
      maxOutputTokens: 100
    };
    const transport = createApiModelTransport({ KEY: "fake-secret-key" });
    const reply = await transport.respond(call, new AbortController().signal);
    expect(reply.payload).toEqual({ answer: "[REDACTED]" });
    expect(reply.rawContent).not.toContain("fake-secret-key");
    expect(reply.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });
    if (protocol === "openai-compatible")
      expect(local.bodies).toEqual([
        {
          model: "test-model",
          messages: call.messages,
          temperature: 0.3,
          max_tokens: 100,
          response_format: { type: "json_object" }
        }
      ]);
    else
      expect(local.bodies).toEqual([
        {
          model: "test-model",
          max_tokens: 100,
          temperature: 0.3,
          system: [{ type: "text", text: "Return JSON" }],
          messages: [{ role: "user", content: [{ type: "text", text: "Q" }] }]
        }
      ]);
  }
);
it("projects legacy input to transport fields and maps failures without losing usage or raw observations", async () => {
  const session = identifyStoredSession(paused);
  if (session.kind !== "peer") throw Error("not peer");
  const request = buildMemberRequest(session.state, "member-a");
  const projected = peerModelCall(request);
  expect(Object.keys(projected).sort()).toEqual(
    [
      "protocol",
      "baseUrl",
      "modelId",
      "apiKeyEnv",
      "messages",
      "outputMode",
      "maxOutputTokens",
      "generationOptions"
    ].sort()
  );
  const details = {
    runtime: {
      modelId: projected.modelId,
      protocol: projected.protocol,
      generationOptions: projected.generationOptions,
      finishReason: "length",
      usage: { outputTokens: 100 }
    },
    rawContent: "partial",
    payload: { partial: true }
  };
  const transport: ModelTransport = {
    respond: async (call) => {
      expect(call).toEqual(projected);
      throw new ModelTransportFailure({ code: "truncated_output", message: "Truncated", retryable: true }, details);
    }
  };
  try {
    await peerRuntimeFromTransport(transport).respond(request, new AbortController().signal);
    throw Error("must reject");
  } catch (error) {
    expect(error).toBeInstanceOf(PeerRuntimeFailure);
    expect(error).toMatchObject({ peerError: { code: "truncated_output", retryable: true }, ...details });
  }
});
