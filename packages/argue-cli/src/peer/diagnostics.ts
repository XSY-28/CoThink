import {
  MEMBER_IDS,
  PEER_PROMPT_VERSION,
  PeerMemberConfigSchema,
  PeerRuntimeFailure,
  applyRoundPair,
  buildMemberRequest,
  createPeerSession,
  validateMemberReply,
  type MemberId,
  type MemberReply,
  type MemberRequest,
  type MemberRuntime,
  type PeerMemberConfig,
  type PeerSession,
  type PeerUsage,
  type RuntimeReply
} from "@onevcat/argue";
import { createPeerApiRuntime, validatePeerApiRequest } from "../runtime/peer-api.js";

export interface PeerConnectionCheck {
  phase: "opening" | "review";
  ok: boolean;
  error?: { code: string; message: string };
  usage?: PeerUsage;
}
export interface PeerConnectionReport {
  ok: boolean;
  calls: number;
  results: Array<{
    memberId: MemberId;
    protocol: string;
    modelId: string;
    baseUrl: string;
    checks: PeerConnectionCheck[];
  }>;
}
export interface PeerConnectionOptions {
  memberId?: MemberId;
  /** Per-call bound; at most four calls are attempted. */
  timeoutMs?: number;
  maxOutputTokens?: number;
  runtime?: MemberRuntime;
  signal?: AbortSignal;
}

const fail = (code: string, message: string) => new PeerRuntimeFailure({ code, message, retryable: false });
const failedCheck = (code: string, message: string): PeerConnectionCheck => ({
  phase: "opening",
  ok: false,
  error: { code, message }
});
const providerCodes = new Set([
  "authentication_failed",
  "rate_limited",
  "request_timeout",
  "cancelled",
  "provider_unavailable",
  "provider_error",
  "transport_error",
  "invalid_http_response",
  "truncated_output",
  "invalid_finish_reason",
  "empty_content",
  "malformed_json",
  "invalid_generation_options",
  "unsupported_protocol",
  "unsupported_output_mode",
  "missing_api_key"
]);

/** Keep only observed numeric usage, never provider text, cost annotations or raw bodies. */
function numericUsage(value: PeerUsage | undefined): PeerUsage | undefined {
  if (!value) return undefined;
  const usage: PeerUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "estimatedCost"] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function validateLocalMember(memberId: MemberId, member: PeerMemberConfig, env: Record<string, string | undefined>) {
  if (!PeerMemberConfigSchema.safeParse(member).success || member.id !== memberId)
    throw fail("invalid_configuration", "Member configuration is invalid.");
  if (member.protocol !== "openai-compatible" && member.protocol !== "anthropic-compatible")
    throw fail("unsupported_protocol", "Only OpenAI-compatible and Anthropic-compatible protocols are supported.");
  if (member.protocol === "anthropic-compatible" && member.outputMode !== "prompt_json")
    throw fail("unsupported_output_mode", "Anthropic-compatible transport requires prompt_json output mode.");
  const url = new URL(member.baseUrl);
  if (
    !/^https?:$/u.test(url.protocol) ||
    url.username ||
    url.password ||
    /[\s\\]/u.test(member.baseUrl) ||
    /^https?:\/\/[^/?#]*@/iu.test(member.baseUrl)
  )
    throw fail("invalid_configuration", "API endpoint must be HTTP(S) without embedded credentials.");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(member.apiKeyEnv))
    throw fail("invalid_configuration", "API key environment variable name is invalid.");
  if (!env[member.apiKeyEnv]?.trim())
    throw fail("missing_api_key", `Environment variable ${member.apiKeyEnv} is not set.`);
}

function envelope(state: PeerSession, memberId: MemberId, payload: unknown): MemberReply {
  const request = buildMemberRequest(state, memberId);
  return { memberId, jobId: request.jobId, snapshotId: request.snapshotId, inputHash: request.inputHash, payload };
}

/** A reducer-created two-author fixture: no actual probe response enters this state. */
function reviewFixture(opening: PeerSession): PeerSession {
  const synthesize = (memberId: MemberId) =>
    envelope(opening, memberId, {
      phase: "opening",
      conclusion: "Synthetic format fixture only; no model quality judgment.",
      evidenceRequests: [],
      claims: [
        {
          statement: `Synthetic ${memberId} connection-test claim.`,
          rationale: "This claim exists only to test exact frozen review coverage.",
          assumptions: ["Synthetic fixture, not a factual assertion."],
          sourceRefs: []
        }
      ]
    });
  const discussion = applyRoundPair(opening, [synthesize("member-a"), synthesize("member-b")]);
  const ready = (memberId: MemberId) =>
    envelope(discussion, memberId, {
      phase: "discussion",
      conclusion: "Synthetic fixture ready for format review.",
      evidenceRequests: [],
      actions: [],
      readyToReview: true
    });
  return applyRoundPair(discussion, [ready("member-a"), ready("member-b")]);
}

/** Race the adapter against our own deadline even if an injected runtime ignores abort. */
async function boundedReply(
  runtime: MemberRuntime,
  request: MemberRequest,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const abortFailure = () =>
    controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError"
      ? fail("request_timeout", "Connection check reached its deadline.")
      : fail("cancelled", "Connection check was cancelled.");
  const onAbort = () => rejectAbort?.(abortFailure());
  const onExternalAbort = () => controller.abort();
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  controller.signal.addEventListener("abort", onAbort, { once: true });
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (signal?.aborted) controller.abort();
  timer = setTimeout(() => controller.abort(new DOMException("Diagnostic deadline", "TimeoutError")), timeoutMs);
  try {
    if (controller.signal.aborted) throw abortFailure();
    const result = await Promise.race([
      Promise.resolve().then(() => runtime.respond(request, controller.signal)),
      aborted
    ]);
    if (controller.signal.aborted) throw abortFailure();
    return result;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Two synthetic phase checks per member, with zero retries, repair calls or persisted sessions. */
export async function testPeerConnections(
  members: Record<MemberId, PeerMemberConfig>,
  env: Record<string, string | undefined>,
  options: PeerConnectionOptions = {}
): Promise<PeerConnectionReport> {
  const secrets = MEMBER_IDS.flatMap((id) => {
    const value = env[members[id]?.apiKeyEnv];
    return value ? [value, value.trim()].filter(Boolean) : [];
  }).sort((a, b) => b.length - a.length);
  const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
  const selected = options.memberId && MEMBER_IDS.includes(options.memberId) ? [options.memberId] : [...MEMBER_IDS];
  const report: PeerConnectionReport = {
    ok: false,
    calls: 0,
    results: selected.map((memberId) => ({
      memberId,
      protocol: redact(members[memberId]?.protocol ?? ""),
      modelId: redact(members[memberId]?.modelId ?? ""),
      baseUrl: redact(members[memberId]?.baseUrl ?? ""),
      checks: []
    }))
  };
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputTokens = options.maxOutputTokens ?? 2048;
  const invalidOptions =
    (options.memberId !== undefined && !MEMBER_IDS.includes(options.memberId)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1;
  if (invalidOptions || options.signal?.aborted) {
    for (const result of report.results)
      result.checks.push(
        failedCheck(
          invalidOptions ? "invalid_options" : "cancelled",
          invalidOptions ? "Diagnostic limits or selected member are invalid." : "Connection check was cancelled."
        )
      );
    return report;
  }
  for (const result of report.results) {
    try {
      validateLocalMember(result.memberId, members[result.memberId], env);
    } catch (error) {
      result.checks.push(
        failedCheck(
          error instanceof PeerRuntimeFailure ? error.peerError.code : "invalid_configuration",
          redact(error instanceof PeerRuntimeFailure ? error.peerError.message : "Member configuration is invalid.")
        )
      );
    }
  }
  if (report.results.some((result) => result.checks.length)) {
    for (const result of report.results)
      if (!result.checks.length)
        result.checks.push(
          failedCheck(
            "preflight_blocked",
            "No calls were sent because another selected member failed local validation."
          )
        );
    return report;
  }

  let opening: PeerSession;
  let review: PeerSession;
  const requests = new Map<MemberId, [MemberRequest, MemberRequest]>();
  try {
    opening = createPeerSession({
      sessionId: "cothink-synthetic-connection-test",
      schemaVersion: 1,
      sourceCommit: "synthetic-diagnostic",
      promptVersion: PEER_PROMPT_VERSION,
      createdAt: new Date().toISOString(),
      question: "Synthetic connection and JSON-format check: propose a harmless test claim.",
      goal: "Check transport, structured opening and exact frozen review coverage; this is not a model quality test.",
      constraints: ["All task content is synthetic. No copied sources or factual conclusions are required."],
      members: MEMBER_IDS.map((id) => members[id]),
      limits: {
        minDiscussionRounds: 1,
        maxDiscussionRounds: 1,
        maxCalls: 4,
        maxOutputTokens,
        callTimeoutMs: timeoutMs,
        segmentTimeoutMs: timeoutMs * 4
      }
    });
    review = reviewFixture(opening);
    // Compile both phases before sending anything, so input limits cannot consume quota first.
    for (const id of selected) requests.set(id, [buildMemberRequest(opening, id), buildMemberRequest(review, id)]);
  } catch {
    for (const result of report.results)
      result.checks.push(
        failedCheck(
          "invalid_configuration",
          "Cannot compile the shared synthetic protocol contexts within configured limits."
        )
      );
    return report;
  }

  for (const result of report.results) {
    try {
      for (const request of requests.get(result.memberId)!) validatePeerApiRequest(request);
    } catch (error) {
      const code =
        error instanceof PeerRuntimeFailure && providerCodes.has(error.peerError.code)
          ? error.peerError.code
          : "invalid_configuration";
      result.checks.push(failedCheck(code, `Connection configuration failed local validation (${code}).`));
    }
  }
  if (report.results.some((result) => result.checks.length)) {
    for (const result of report.results)
      if (!result.checks.length)
        result.checks.push(
          failedCheck(
            "preflight_blocked",
            "No calls were sent because another selected member failed local validation."
          )
        );
    return report;
  }

  const runtime =
    options.runtime ??
    createPeerApiRuntime(
      env,
      Object.values(members).map((member) => member.apiKeyEnv)
    );
  for (const result of report.results) {
    const pair = requests.get(result.memberId)!;
    for (const [index, state] of [opening, review].entries()) {
      const request = { ...pair[index]!, deadline: new Date(Date.now() + timeoutMs).toISOString() };
      const phase = index === 0 ? "opening" : "review";
      if (options.signal?.aborted) {
        result.checks.push({
          phase,
          ok: false,
          error: { code: "cancelled", message: "Connection check was cancelled." }
        });
        break;
      }
      report.calls++;
      let usage: PeerUsage | undefined;
      try {
        const reply = await boundedReply(runtime, request, timeoutMs, options.signal);
        usage = numericUsage(reply.usage);
        if (reply.finishReason !== "stop")
          throw fail(
            reply.finishReason === "length" ? "truncated_output" : "invalid_finish_reason",
            "Final output was not complete."
          );
        try {
          validateMemberReply(state, {
            memberId: request.memberId,
            jobId: request.jobId,
            snapshotId: request.snapshotId,
            inputHash: request.inputHash,
            payload: reply.payload
          });
        } catch {
          throw fail(
            "invalid_peer_reply",
            "Reply failed frozen protocol shape, identity, source or review coverage validation."
          );
        }
        result.checks.push({ phase, ok: true, ...(usage ? { usage } : {}) });
      } catch (error) {
        const failure = error instanceof PeerRuntimeFailure ? error : undefined;
        const code =
          failure && (providerCodes.has(failure.peerError.code) || failure.peerError.code === "invalid_peer_reply")
            ? failure.peerError.code
            : "runtime_error";
        usage ??= numericUsage(failure?.runtime?.usage);
        result.checks.push({
          phase,
          ok: false,
          error: {
            code,
            message:
              code === "invalid_peer_reply"
                ? "Reply failed frozen protocol shape, identity, source or review coverage validation."
                : `Connection check failed (${code}).`
          },
          ...(usage ? { usage } : {})
        });
        break;
      }
    }
  }
  report.ok = report.results.every((result) => result.checks.length === 2 && result.checks.every((check) => check.ok));
  return report;
}
