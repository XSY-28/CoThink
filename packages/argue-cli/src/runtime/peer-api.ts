import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
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

function redact(text: string, apiKeys: readonly string[]): string {
  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const key of apiKeys) {
    // Match literal and mixed Unicode-escaped keys even in malformed JSON or
    // provider error messages. Preserve unrelated escapes in diagnostic text.
    const pattern = key
      .split("")
      .map((character) => {
        const hex = character
          .charCodeAt(0)
          .toString(16)
          .padStart(4, "0")
          .replace(/[a-f]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
        return `(?:${escapePattern(character)}|\\\\u${hex})`;
      })
      .join("");
    text = text.replace(new RegExp(pattern, "g"), "[REDACTED]");
  }
  return text;
}

function redactDecoded(value: unknown, apiKey: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, apiKey);
  if (Array.isArray(value)) return value.map((item) => redactDecoded(item, apiKey));
  const object = record(value);
  if (object)
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [redact(key, apiKey), redactDecoded(item, apiKey)])
    );
  return value;
}

function finalContentFields(content: string, apiKey: readonly string[]) {
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

function responseFields(
  body: string | undefined,
  apiKey: readonly string[],
  request: MemberRequest,
  diagnostic = false
) {
  if (request.protocol === "anthropic-compatible") return anthropicResponseFields(body, apiKey, request, diagnostic);
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

function anthropicResponseFields(
  body: string | undefined,
  apiKey: readonly string[],
  request: MemberRequest,
  diagnostic: boolean
) {
  let parsed: unknown;
  try {
    parsed = body === undefined ? undefined : JSON.parse(body);
  } catch {
    /* retain malformed HTTP response for diagnosis */
  }
  const object = record(parsed);
  const blocks = Array.isArray(object?.content) ? object.content.map(record) : undefined;
  const final = finalContentFields(
    blocks
      ?.filter((block) => block?.type === "text")
      .map((block) => string(block?.text) ?? "")
      .join("") ?? "",
    apiKey
  );
  const envelope = redactDecoded(parsed, apiKey);
  const rawUsage = record(object?.usage);
  const usage: PeerUsage = {};
  // Anthropic reports uncached input separately. Core's inputTokens is the total.
  const iterations = Array.isArray(rawUsage?.iterations) ? rawUsage.iterations.map(record) : [];
  const hasIterations =
    iterations.length > 0 &&
    iterations.every(
      (item) => nonnegative(item?.input_tokens) !== undefined && nonnegative(item?.output_tokens) !== undefined
    );
  const inputTokens = hasIterations
    ? nonnegative(iterations.reduce((sum, item) => sum + (nonnegative(item?.input_tokens) ?? 0), 0))
    : nonnegative(rawUsage?.input_tokens);
  const outputTokens = hasIterations
    ? nonnegative(iterations.reduce((sum, item) => sum + (nonnegative(item?.output_tokens) ?? 0), 0))
    : nonnegative(rawUsage?.output_tokens);
  if (inputTokens !== undefined)
    usage.inputTokens =
      inputTokens +
      (nonnegative(rawUsage?.cache_creation_input_tokens) ?? 0) +
      (nonnegative(rawUsage?.cache_read_input_tokens) ?? 0);
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (usage.inputTokens !== undefined && outputTokens !== undefined)
    usage.totalTokens = usage.inputTokens + outputTokens;
  // Tool content can never stand in for a final peer answer, even if the provider
  // incorrectly labels the response end_turn.
  const reason = blocks?.some((block) => string(block?.type)?.includes("tool_use"))
    ? "tool_use"
    : string(object?.stop_reason);
  const runtime: RuntimeMetadata = {
    modelId: redact(string(object?.model) || request.modelId, apiKey),
    protocol: request.protocol,
    generationOptions: request.generationOptions,
    usage,
    finishReason:
      reason === "end_turn" ? "stop" : reason === "max_tokens" ? "length" : reason ? redact(reason, apiKey) : null
  };
  return {
    runtime,
    rawContent:
      diagnostic && !blocks
        ? parsed === undefined
          ? redact(body ?? "", apiKey)
          : JSON.stringify(envelope)
        : final.rawContent,
    payload: diagnostic && !blocks ? envelope : final.payload
  };
}

const nativeGenerationSchema = z
  .object({
    temperature: z.number().finite().min(0).max(1).optional(),
    top_p: z.number().finite().min(0).max(1).optional(),
    top_k: z.number().int().nonnegative().optional(),
    stop_sequences: z.array(z.string()).optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    thinking: z
      .union([
        z.object({ type: z.literal("disabled") }).strict(),
        z.object({ type: z.literal("adaptive") }).strict(),
        z
          .object({
            type: z.literal("enabled"),
            budget_tokens: z.number().int().min(1024).optional(),
            budgetTokens: z.number().int().min(1024).optional()
          })
          .strict()
      ])
      .optional()
  })
  .strict();

function nativeSettings(request: MemberRequest) {
  const parsed = nativeGenerationSchema.safeParse(request.generationOptions);
  const invalid = (message: string): never => {
    throw new PeerRuntimeFailure({ code: "invalid_generation_options", message, retryable: false });
  };
  // Do not silently drop unknown settings or allow provider-side tools/history
  // features to enter this stateless answer-only transport through options.
  if (!parsed.success) return invalid("Unsupported or invalid native Anthropic generation options");
  const { temperature, top_p: topP, top_k: topK, stop_sequences: stopSequences, thinking, effort } = parsed.data;
  const budget = thinking?.type === "enabled" ? (thinking.budget_tokens ?? thinking.budgetTokens ?? 1024) : undefined;
  if (
    thinking?.type === "enabled" &&
    thinking.budget_tokens !== undefined &&
    thinking.budgetTokens !== undefined &&
    thinking.budget_tokens !== thinking.budgetTokens
  )
    invalid("Native thinking budget_tokens and budgetTokens conflict");
  if (budget !== undefined && budget >= request.maxOutputTokens)
    invalid("Native thinking budget must be less than maxOutputTokens");
  if (temperature !== undefined && topP !== undefined)
    invalid("Native Anthropic temperature and top_p cannot be combined");
  if (
    thinking &&
    thinking.type !== "disabled" &&
    (temperature !== undefined || topP !== undefined || topK !== undefined)
  )
    invalid("Native thinking cannot be combined with temperature, top_p or top_k");
  // The SDK adds the thinking budget to maxOutputTokens. Preserve the frozen
  // request's total native max_tokens cap instead of expanding it invisibly.
  return {
    maxOutputTokens: request.maxOutputTokens - (typeof budget === "number" ? budget : 0),
    temperature,
    topP,
    topK,
    stopSequences,
    providerOptions: {
      anthropic: {
        ...(effort === undefined ? {} : { effort }),
        ...(thinking === undefined
          ? {}
          : { thinking: thinking.type === "enabled" ? { type: "enabled", budgetTokens: budget } : thinking })
      }
    }
  };
}

function statusOf(error: unknown): number | undefined {
  const candidate = record(error);
  return typeof candidate?.statusCode === "number" ? candidate.statusCode : undefined;
}

function failure(
  error: unknown,
  key: readonly string[],
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

/** Pure transport preflight: no environment lookup, provider creation or HTTP. */
export function validatePeerApiRequest(request: MemberRequest): void {
  if (request.protocol !== "openai-compatible" && request.protocol !== "anthropic-compatible")
    throw new PeerRuntimeFailure({
      code: "unsupported_protocol",
      message: `Unsupported peer protocol: ${request.protocol}`,
      retryable: false
    });
  if (request.protocol === "anthropic-compatible") {
    if (request.outputMode !== "prompt_json")
      throw new PeerRuntimeFailure({
        code: "unsupported_output_mode",
        message: "Native Anthropic transport requires prompt_json output mode",
        retryable: false
      });
    nativeSettings(request);
  }
}

/** One frozen request maps to one HTTP attempt. No mutable conversation state is held here. */
export function createPeerApiRuntime(
  env: Record<string, string | undefined> = process.env,
  credentialEnvNames: readonly string[] = []
): MemberRuntime {
  return {
    async respond(request, signal) {
      validatePeerApiRequest(request);
      const native = request.protocol === "anthropic-compatible";
      const key = env[request.apiKeyEnv]?.trim();
      if (!key)
        throw new PeerRuntimeFailure({
          code: "missing_api_key",
          message: `Environment variable ${request.apiKeyEnv} is not set`,
          retryable: false
        });
      // Scope is explicit: do not redact arbitrary settings from process.env.
      // Longer credentials first avoid partially exposing overlapping keys.
      const redactionKeys = [
        ...new Set([
          key,
          ...credentialEnvNames.map((name) => env[name]?.trim()).filter((value): value is string => !!value)
        ])
      ].sort((left, right) => right.length - left.length);
      let observedBody: string | undefined;
      const captureFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (response.status === 200) observedBody = await response.clone().text();
        return response;
      };
      const provider = createOpenAICompatible({
        name: "argue-peer",
        baseURL: request.baseUrl,
        apiKey: key,
        supportsStructuredOutputs: false,
        fetch: captureFetch
      });
      const nativeProvider = native
        ? createAnthropic({ baseURL: request.baseUrl, apiKey: key, fetch: captureFetch })
        : undefined;
      // The installed OpenAI-compatible SDK owns this field as `reasoningEffort`.
      // Passing `reasoning_effort` through its generic option spread is overwritten
      // by the SDK's own undefined mapping and never reaches the HTTP request.
      const { reasoning_effort: reasoningEffort, ...otherGenerationOptions } = request.generationOptions;
      const providerOptions = {
        ...otherGenerationOptions,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(request.outputMode === "json_object" ? { response_format: { type: "json_object" } } : {})
      };
      let result;
      try {
        result = await generateText({
          model: nativeProvider ? nativeProvider.messages(request.modelId) : provider.chatModel(request.modelId),
          messages: request.messages,
          maxRetries: 0,
          abortSignal: signal,
          ...(native
            ? nativeSettings(request)
            : { maxOutputTokens: request.maxOutputTokens, providerOptions: { "argue-peer": providerOptions } })
        });
      } catch (error) {
        if (error instanceof PeerRuntimeFailure) throw error;
        throw failure(error, redactionKeys, observedBody, request, signal);
      }
      const observed = responseFields(observedBody, redactionKeys, request);
      const final = observedBody === undefined ? finalContentFields(result.text, redactionKeys) : observed;
      const rawContent = final.rawContent;
      const runtime = {
        ...observed.runtime,
        modelId:
          observedBody === undefined
            ? redact(result.response.modelId ?? request.modelId, redactionKeys)
            : observed.runtime.modelId,
        finishReason:
          observedBody === undefined
            ? result.rawFinishReason
              ? redact(result.rawFinishReason, redactionKeys)
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
