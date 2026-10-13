import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  PeerRuntimeFailure,
  type MemberRequest,
  type MemberRuntime,
  type PeerUsage,
  type RuntimeMetadata
} from "@onevcat/argue";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonnegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function redact(text: string, apiKey: string): string {
  return apiKey ? text.replaceAll(apiKey, "[REDACTED]") : text;
}

function redactDecoded(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") return redact(value, apiKey);
  if (Array.isArray(value)) return value.map((item) => redactDecoded(item, apiKey));
  const object = record(value);
  if (object)
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [redact(key, apiKey), redactDecoded(item, apiKey)])
    );
  return value;
}

function finalContentFields(content: string, apiKey: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { rawContent: redact(content, apiKey), payload: undefined };
  }
  const payload = redactDecoded(parsed, apiKey);
  // Re-serialize only when decoding exposed a hidden key (for example a Unicode escape).
  const rawContent =
    JSON.stringify(payload) === JSON.stringify(parsed) ? redact(content, apiKey) : JSON.stringify(payload);
  return { rawContent, payload };
}

function responseFields(body: string | undefined, apiKey: string, request: MemberRequest, diagnostic = false) {
  let parsed: unknown;
  try {
    parsed = body === undefined ? undefined : JSON.parse(body);
  } catch {
    /* retain raw HTTP body */
  }
  const object = record(parsed);
  const firstChoice = Array.isArray(object?.choices) ? record(object.choices[0]) : undefined;
  const message = record(firstChoice?.message);
  const hasFinalContent = message !== undefined && Object.hasOwn(message, "content");
  // A null final message is empty even when the same response includes valid reasoning_content.
  const final = finalContentFields(string(message?.content) ?? "", apiKey);
  const diagnosticPayload = parsed === undefined ? undefined : redactDecoded(parsed, apiKey);
  const rawContent =
    diagnostic && !hasFinalContent
      ? parsed === undefined
        ? redact(body ?? "", apiKey)
        : JSON.stringify(diagnosticPayload)
      : final.rawContent;
  const payload = diagnostic && !hasFinalContent ? diagnosticPayload : final.payload;
  const rawUsage = record(object?.usage);
  const usage: PeerUsage = {};
  const inputTokens = nonnegative(rawUsage?.prompt_tokens);
  const outputTokens = nonnegative(rawUsage?.completion_tokens);
  const totalTokens = nonnegative(rawUsage?.total_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  const runtime: RuntimeMetadata = {
    modelId: redact(string(object?.model) || request.modelId, apiKey),
    protocol: request.protocol,
    generationOptions: request.generationOptions,
    usage,
    finishReason: string(firstChoice?.finish_reason) ? redact(string(firstChoice?.finish_reason)!, apiKey) : null
  };
  return { rawContent, payload, runtime };
}

function statusOf(error: unknown): number | undefined {
  const candidate = record(error);
  return typeof candidate?.statusCode === "number" ? candidate.statusCode : undefined;
}

function failure(
  error: unknown,
  key: string,
  body: string | undefined,
  request: MemberRequest,
  signal: AbortSignal
): PeerRuntimeFailure {
  const status = statusOf(error);
  const timedOut = signal.aborted && record(signal.reason)?.name === "TimeoutError";
  const code = timedOut
    ? "request_timeout"
    : signal.aborted
      ? "cancelled"
      : status === 401 || status === 403
        ? "authentication_failed"
        : status === 429
          ? "rate_limited"
          : status === 408
            ? "request_timeout"
            : status && status >= 500
              ? "provider_unavailable"
              : status && status >= 400
                ? "provider_error"
                : body !== undefined
                  ? "invalid_http_response"
                  : "transport_error";
  const retryable = signal.aborted
    ? true
    : status === 401 || status === 403 || (status && status >= 400 && status < 408)
      ? false
      : true;
  const detail = error instanceof Error ? error.message : String(error);
  const message = redact(`Peer API ${code}${status ? ` (HTTP ${status})` : ""}: ${detail}`, key);
  const observed = body === undefined ? {} : responseFields(body, key, request, true);
  return new PeerRuntimeFailure({ code, message, retryable }, observed);
}

/** One frozen request maps to one HTTP attempt. No mutable conversation state is held here. */
export function createPeerApiRuntime(env: Record<string, string | undefined> = process.env): MemberRuntime {
  return {
    async respond(request, signal) {
      if (request.protocol !== "openai-compatible")
        throw new PeerRuntimeFailure({
          code: "unsupported_protocol",
          message: `Unsupported peer protocol: ${request.protocol}`,
          retryable: false
        });
      const key = env[request.apiKeyEnv]?.trim();
      if (!key)
        throw new PeerRuntimeFailure({
          code: "missing_api_key",
          message: `Environment variable ${request.apiKeyEnv} is not set`,
          retryable: false
        });
      let observedBody: string | undefined;
      const provider = createOpenAICompatible({
        name: "argue-peer",
        baseURL: request.baseUrl,
        apiKey: key,
        supportsStructuredOutputs: false,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.status === 200) observedBody = await response.clone().text();
          return response;
        }
      });
      const providerOptions = {
        ...request.generationOptions,
        ...(request.outputMode === "json_object" ? { response_format: { type: "json_object" } } : {})
      };
      let result;
      try {
        result = await generateText({
          model: provider.chatModel(request.modelId),
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: { "argue-peer": providerOptions }
        });
      } catch (error) {
        throw failure(error, key, observedBody, request, signal);
      }
      const observed = responseFields(observedBody, key, request);
      const final = observedBody === undefined ? finalContentFields(result.text, key) : observed;
      const rawContent = final.rawContent;
      const runtime = {
        ...observed.runtime,
        modelId:
          observedBody === undefined
            ? redact(result.response.modelId ?? request.modelId, key)
            : observed.runtime.modelId,
        finishReason:
          observedBody === undefined
            ? result.rawFinishReason
              ? redact(result.rawFinishReason, key)
              : null
            : observed.runtime.finishReason
      };
      const payload = final.payload;
      if (runtime.finishReason !== "stop") {
        throw new PeerRuntimeFailure(
          {
            code: runtime.finishReason === "length" ? "truncated_output" : "invalid_finish_reason",
            message: `Peer API stopped with ${runtime.finishReason ?? "unknown"}`,
            retryable: true
          },
          { runtime, rawContent, payload }
        );
      }
      if (!rawContent.trim())
        throw new PeerRuntimeFailure(
          { code: "empty_content", message: "Peer API returned empty final content", retryable: true },
          { runtime, rawContent }
        );
      if (payload === undefined) {
        throw new PeerRuntimeFailure(
          { code: "malformed_json", message: "Peer API returned malformed final JSON", retryable: true },
          { runtime, rawContent }
        );
      }
      return { ...runtime, payload, rawContent };
    }
  };
}
