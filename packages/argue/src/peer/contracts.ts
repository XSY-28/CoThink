import { z } from "zod";

export const PEER_SCHEMA_VERSION = 1;
export const PEER_PROMPT_VERSION = "peer-v4";
export const MEMBER_IDS = ["member-a", "member-b"] as const;
export const MemberIdSchema = z.enum(MEMBER_IDS);
export type MemberId = z.infer<typeof MemberIdSchema>;
export const PeerPhaseSchema = z.enum(["opening", "discussion", "review"]);
export type PeerPhase = z.infer<typeof PeerPhaseSchema>;
const text = z.string().min(1);
const id = text;
export type PeerJsonValue = string | number | boolean | null | PeerJsonValue[] | { [key: string]: PeerJsonValue };
export const PeerJsonValueSchema: z.ZodType<PeerJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(PeerJsonValueSchema),
    z.record(PeerJsonValueSchema)
  ])
);
/** Adapter-specific generation tuning must not replace frozen protocol or transport fields. */
const PROTECTED_GENERATION_KEYS = new Set([
  "messages",
  "input",
  "prompt",
  "system",
  "instructions",
  "role",
  "content",
  "memberid",
  "authorid",
  "sessionid",
  "jobid",
  "attemptid",
  "snapshotid",
  "sharedsnapshotid",
  "inputhash",
  "model",
  "modelid",
  "protocol",
  "baseurl",
  "apikey",
  "apikeyenv",
  "authorization",
  "headers",
  "url",
  "endpoint",
  "maxoutputtokens",
  "maxcompletiontokens",
  "maxtokens",
  "maxinputcharacters",
  "maxinputtokens",
  "maxretries",
  "retries",
  "timeout",
  "timeoutms",
  "deadline",
  "calltimeoutms",
  "segmenttimeoutms",
  "maxcalls",
  "mindiscussionrounds",
  "maxdiscussionrounds",
  "outputmode",
  "outputschema",
  "responseformat",
  "responseschema",
  "jsonschema",
  "schema",
  "format",
  "tools",
  "toolchoice",
  "functions",
  "functioncall",
  "n",
  "stream",
  "streamoptions"
]);
const normalizedOptionKey = (key: string) => key.replace(/[-_\s]/g, "").toLowerCase();
export const GenerationOptionsSchema = z.record(PeerJsonValueSchema).superRefine((options, ctx) => {
  const visit = (value: PeerJsonValue, path: (string | number)[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const itemPath = [...path, key];
        if (PROTECTED_GENERATION_KEYS.has(normalizedOptionKey(key))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: itemPath, message: `Protected generation option: ${key}` });
        }
        visit(item, itemPath);
      }
    }
  };
  visit(options, []);
});
export const MemberProviderConfigSchema = z
  .object({
    protocol: text,
    baseUrl: z.string().url(),
    modelId: text,
    apiKeyEnv: text,
    outputMode: z.enum(["json_object", "prompt_json"]),
    generationOptions: GenerationOptionsSchema.default({}),
    maxInputCharacters: z.number().int().positive().optional()
  })
  .strict();
export const PeerMemberConfigSchema = MemberProviderConfigSchema.extend({ id: MemberIdSchema }).strict();
export type PeerMemberConfig = z.infer<typeof PeerMemberConfigSchema>;
const MembersSchema = z
  .object({ "member-a": PeerMemberConfigSchema, "member-b": PeerMemberConfigSchema })
  .strict()
  .refine(
    (m) => m["member-a"].id === "member-a" && m["member-b"].id === "member-b",
    "Member identity must match its key"
  );
const MembersInputSchema = z.union([
  z
    .object({ "member-a": MemberProviderConfigSchema, "member-b": MemberProviderConfigSchema })
    .strict()
    .transform((m) => ({
      "member-a": { ...m["member-a"], id: "member-a" as const },
      "member-b": { ...m["member-b"], id: "member-b" as const }
    })),
  z
    .array(PeerMemberConfigSchema)
    .length(2)
    .refine((m) => new Set(m.map((x) => x.id)).size === 2, "Both fixed members are required")
    .transform((m) => ({
      "member-a": m.find((x) => x.id === "member-a")!,
      "member-b": m.find((x) => x.id === "member-b")!
    }))
]);
export const PeerLimitsSchema = z
  .object({
    minDiscussionRounds: z.number().int().positive().default(2),
    maxDiscussionRounds: z.number().int().positive().default(3),
    maxCalls: z.number().int().positive().default(12),
    maxOutputTokens: z.number().int().positive().default(4096),
    callTimeoutMs: z.number().int().positive().default(180000),
    segmentTimeoutMs: z.number().int().positive().default(600000),
    maxSourceCharacters: z.number().int().positive().default(20000),
    maxInputCharacters: z.number().int().positive().default(100000)
  })
  .strict()
  .refine((l) => l.minDiscussionRounds <= l.maxDiscussionRounds, "Minimum rounds must not exceed maximum rounds");
export type PeerLimits = z.infer<typeof PeerLimitsSchema>;
const configFields = {
  sessionId: id,
  schemaVersion: z.literal(1),
  question: text,
  goal: z.string().default(""),
  constraints: z.array(text).default([]),
  sourceCommit: text,
  promptVersion: z.enum(["peer-v1", "peer-v2", "peer-v3", "peer-v4"]).default(PEER_PROMPT_VERSION),
  createdAt: z.string().datetime(),
  limits: PeerLimitsSchema.default({})
};
export const SessionConfigInputSchema = z.object({ ...configFields, members: MembersInputSchema }).strict();
export const SessionConfigSchema = z.object({ ...configFields, members: MembersSchema }).strict();
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionConfigInput = z.input<typeof SessionConfigInputSchema>;
export const ContextSourceInputSchema = z
  .object({ sourceId: id, content: z.string(), segmentId: z.number().int().positive(), name: text.optional() })
  .strict();
export const ContextSourceSchema = ContextSourceInputSchema.extend({
  contentHash: id,
  lineCount: z.number().int().positive()
}).strict();
export type ContextSourceInput = z.infer<typeof ContextSourceInputSchema>;
export type ContextSource = z.infer<typeof ContextSourceSchema>;
export const SourceRefSchema = z
  .object({ sourceId: id, startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;
export const ClaimDraftSchema = z
  .object({
    statement: text,
    rationale: text,
    assumptions: z.array(text),
    sourceRefs: z.array(SourceRefSchema),
    alternativeToVersionId: id.optional()
  })
  .strict();
export type ClaimDraft = z.infer<typeof ClaimDraftSchema>;
export const EvidenceRequestSchema = z
  .object({ targetVersionId: id.optional(), request: text, rationale: text })
  .strict();
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;
export const MessageTargetSchema = z.union([
  z.object({ versionId: id }).strict(),
  z.object({ messageId: id }).strict()
]);
const messageFields = { rationale: text, sourceRefs: z.array(SourceRefSchema) };
export const PeerActionSchema = z.discriminatedUnion("kind", [
  ClaimDraftSchema.extend({ kind: z.literal("propose") }).strict(),
  ClaimDraftSchema.extend({ kind: z.literal("revise"), targetVersionId: id }).strict(),
  z.object({ kind: z.literal("withdraw"), targetVersionId: id, rationale: text }).strict(),
  z.object({ kind: z.literal("challenge"), targetVersionId: id, ...messageFields }).strict(),
  z.object({ kind: z.literal("ask"), target: MessageTargetSchema, ...messageFields }).strict(),
  z.object({ kind: z.literal("reply"), replyTo: id, ...messageFields }).strict()
]);
export type PeerAction = z.infer<typeof PeerActionSchema>;
const turnFields = { conclusion: z.string(), evidenceRequests: z.array(EvidenceRequestSchema) };
export const OpeningTurnSchema = z
  .object({ phase: z.literal("opening"), ...turnFields, claims: z.array(ClaimDraftSchema).max(3) })
  .strict();
export const DiscussionTurnSchema = z
  .object({
    phase: z.literal("discussion"),
    ...turnFields,
    actions: z.array(PeerActionSchema),
    readyToReview: z.boolean()
  })
  .strict();
export const AssessmentSchema = z.enum(["accept", "reject", "uncertain"]);
export type Assessment = z.infer<typeof AssessmentSchema>;
export const ReviewPositionSchema = z.object({ versionId: id, stance: AssessmentSchema, ...messageFields }).strict();
export type ReviewPosition = z.infer<typeof ReviewPositionSchema>;
export const ReviewTurnSchema = z
  .object({ phase: z.literal("review"), ...turnFields, reviewSetHash: id, positions: z.array(ReviewPositionSchema) })
  .strict();
export const PeerTurnSchema = z.discriminatedUnion("phase", [
  OpeningTurnSchema,
  DiscussionTurnSchema,
  ReviewTurnSchema
]);
export type OpeningTurn = z.infer<typeof OpeningTurnSchema>;
export type DiscussionTurn = z.infer<typeof DiscussionTurnSchema>;
export type ReviewTurn = z.infer<typeof ReviewTurnSchema>;
export type PeerTurn = z.infer<typeof PeerTurnSchema>;
export const ClaimVersionSchema = ClaimDraftSchema.extend({
  claimId: id,
  versionId: id,
  authorId: MemberIdSchema,
  segmentId: z.number().int().positive(),
  roundIndex: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  previousVersionId: id.optional(),
  withdrawn: z.boolean(),
  withdrawalReason: text.optional()
}).strict();
export type ClaimVersion = z.infer<typeof ClaimVersionSchema>;
export const PeerMessageSchema = z
  .object({
    messageId: id,
    authorId: MemberIdSchema,
    recipientId: MemberIdSchema,
    segmentId: z.number().int().positive(),
    roundIndex: z.number().int().positive(),
    kind: z.enum(["challenge", "ask", "reply"]),
    targetVersionId: id.optional(),
    targetMessageId: id.optional(),
    replyTo: id.optional(),
    ...messageFields,
    respondedBy: z.array(id)
  })
  .strict();
export type PeerMessage = z.infer<typeof PeerMessageSchema>;
export const MemberReviewSchema = ReviewTurnSchema.extend({
  memberId: MemberIdSchema,
  segmentId: z.number().int().positive()
}).strict();
export type MemberReview = z.infer<typeof MemberReviewSchema>;
export const MemberReplySchema = z
  .object({ memberId: MemberIdSchema, jobId: id, snapshotId: id, inputHash: id, payload: z.unknown() })
  .strict();
export type MemberReply = z.infer<typeof MemberReplySchema>;
export interface ValidatedMemberReply extends Omit<MemberReply, "payload"> {
  payload: PeerTurn;
}
export type RoundPair = readonly [MemberReply, MemberReply];
export const RoundRecordSchema = z
  .object({
    segmentId: z.number().int().positive(),
    roundIndex: z.number().int().nonnegative(),
    phase: PeerPhaseSchema,
    snapshotId: id,
    replies: z
      .array(
        z
          .object({ memberId: MemberIdSchema, jobId: id, snapshotId: id, inputHash: id, payload: PeerTurnSchema })
          .strict()
      )
      .length(2)
  })
  .strict();
export type PeerRoundRecord = z.infer<typeof RoundRecordSchema>;
export const PeerSegmentSchema = z
  .object({
    segmentId: z.number().int().positive(),
    phase: PeerPhaseSchema,
    roundIndex: z.number().int().nonnegative(),
    snapshotId: id,
    expectedMembers: z.tuple([z.literal("member-a"), z.literal("member-b")]),
    status: z.enum(["active", "completed"]),
    completionReason: z.enum(["reviewed", "no_active_claims"]).optional(),
    startedAt: z.string().datetime(),
    deadline: z.string().datetime(),
    minDiscussionRounds: z.number().int().positive(),
    maxDiscussionRounds: z.number().int().positive(),
    maxCalls: z.number().int().positive(),
    reviewSetHash: id.optional(),
    reviewVersions: z.array(id),
    reviews: z.array(MemberReviewSchema),
    note: z.string().optional()
  })
  .strict();
export type PeerSegment = z.infer<typeof PeerSegmentSchema>;
export const UsageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    estimatedCost: z.number().nonnegative().optional(),
    currency: z.string().optional(),
    priceSnapshot: z.record(PeerJsonValueSchema).optional()
  })
  .strict();
export type PeerUsage = z.infer<typeof UsageSchema>;
export const RuntimeMetadataSchema = z
  .object({
    modelId: text,
    protocol: text,
    generationOptions: GenerationOptionsSchema,
    usage: UsageSchema,
    finishReason: z.string().nullable()
  })
  .strict();
export type RuntimeMetadata = z.infer<typeof RuntimeMetadataSchema>;
export interface RuntimeReply extends RuntimeMetadata {
  payload: unknown;
  rawContent: string;
}
export const PeerErrorSchema = z.object({ code: text, message: text, retryable: z.boolean() }).strict();
export type PeerError = z.infer<typeof PeerErrorSchema>;
export const PeerAttemptSchema = z
  .object({
    jobId: id,
    attemptId: id,
    inputHash: id,
    memberId: MemberIdSchema,
    status: z.enum(["running", "valid", "invalid", "failed", "cancelled", "unknown", "late"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    deadline: z.string().datetime(),
    acceptance: z.enum(["active", "invalidated", "accepted"]),
    cancellation: z.enum(["none", "requested", "confirmed", "unknown"]),
    runtime: RuntimeMetadataSchema.optional(),
    rawContent: z.string().optional(),
    payload: z.unknown().optional(),
    error: PeerErrorSchema.optional()
  })
  .strict();
export type PeerAttempt = z.infer<typeof PeerAttemptSchema>;
/** Durable semantic input; execution deadline/attempt IDs never participate in inputHash. */
export const FrozenMemberInputSchema = z
  .object({
    messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict()),
    outputSchema: z.record(PeerJsonValueSchema),
    outputMode: z.enum(["json_object", "prompt_json"]),
    maxOutputTokens: z.number().int().positive(),
    modelId: text,
    protocol: text,
    baseUrl: z.string().url(),
    apiKeyEnv: text,
    generationOptions: GenerationOptionsSchema
  })
  .strict();
export type FrozenMemberInput = z.infer<typeof FrozenMemberInputSchema>;
export const PeerJobSchema = z
  .object({
    jobId: id,
    memberId: MemberIdSchema,
    segmentId: z.number().int().positive(),
    roundIndex: z.number().int().nonnegative(),
    phase: PeerPhaseSchema,
    snapshotId: id,
    inputHash: id,
    status: z.enum(["pending", "running", "sealed", "failed", "unknown", "committed"]),
    activeAttemptId: id.optional(),
    frozenInput: FrozenMemberInputSchema.optional(),
    sealedReply: z
      .object({ memberId: MemberIdSchema, jobId: id, snapshotId: id, inputHash: id, payload: PeerTurnSchema })
      .strict()
      .optional()
  })
  .strict();
export type PeerJob = z.infer<typeof PeerJobSchema>;
export const PeerEventSchema = z
  .object({
    seq: z.number().int().positive(),
    type: text,
    at: z.string().datetime(),
    segmentId: z.number().int().positive(),
    jobId: id.optional(),
    attemptId: id.optional(),
    data: z.record(PeerJsonValueSchema)
  })
  .strict();
export type PeerEvent = z.infer<typeof PeerEventSchema>;
export const PeerSessionSchema = z
  .object({
    config: SessionConfigSchema,
    revision: z.number().int().nonnegative(),
    eventSeq: z.number().int().nonnegative(),
    status: z.enum(["active", "paused", "completed"]),
    pauseReason: PeerErrorSchema.optional(),
    currentSegmentId: z.number().int().positive(),
    sources: z.array(ContextSourceSchema),
    segments: z.array(PeerSegmentSchema).min(1),
    claimVersions: z.array(ClaimVersionSchema),
    messages: z.array(PeerMessageSchema),
    rounds: z.array(RoundRecordSchema),
    jobs: z.array(PeerJobSchema),
    attempts: z.array(PeerAttemptSchema),
    events: z.array(PeerEventSchema)
  })
  .strict();
export type PeerSession = z.infer<typeof PeerSessionSchema>;
export const SharedPeerContextSchema = z
  .object({
    question: text,
    goal: z.string(),
    constraints: z.array(text),
    sources: z.array(ContextSourceSchema),
    segmentId: z.number().int().positive(),
    roundIndex: z.number().int().nonnegative(),
    phase: PeerPhaseSchema,
    note: z.string().optional(),
    claimVersions: z.array(ClaimVersionSchema),
    messages: z.array(PeerMessageSchema),
    rounds: z.array(RoundRecordSchema),
    reviewVersions: z.array(id),
    reviewSetHash: id.optional()
  })
  .strict();
export type SharedPeerContext = z.infer<typeof SharedPeerContextSchema>;
export const MemberRequestSchema = FrozenMemberInputSchema.extend({
  jobId: id,
  memberId: MemberIdSchema,
  snapshotId: id,
  sharedSnapshotId: id,
  phase: PeerPhaseSchema,
  inputHash: id,
  deadline: z.string().datetime(),
  sharedContext: SharedPeerContextSchema
}).strict();
export type MemberRequest = z.infer<typeof MemberRequestSchema>;
export interface MemberRuntime {
  respond(request: MemberRequest, signal: AbortSignal): Promise<RuntimeReply>;
}
/** commit(-1, initial) creates; every subsequent durable write compares revision and increments once. */
export interface PeerStore {
  load(sessionId: string): Promise<PeerSession>;
  commit(expectedRevision: number, next: PeerSession): Promise<void>;
}
export const PeerClaimLabelSchema = z.enum([
  "jointly_accepted",
  "jointly_rejected",
  "disputed",
  "uncertain",
  "incomplete_review"
]);
export type PeerClaimLabel = z.infer<typeof PeerClaimLabelSchema>;
export const PeerResultV1Schema = z
  .object({
    kind: z.literal("peer"),
    resultVersion: z.literal("peer.v1"),
    schemaVersion: z.literal(1),
    sessionId: id,
    question: text,
    goal: z.string(),
    constraints: z.array(text),
    members: MembersSchema,
    sources: z.array(ContextSourceSchema),
    segmentId: z.number().int().positive(),
    status: z.enum(["active", "paused", "completed"]),
    completionReason: z.enum(["reviewed", "no_active_claims"]).optional(),
    reviewStatus: z.enum(["complete", "incomplete_review", "not_called_no_active_claims"]),
    initialJudgments: z.array(
      z.object({ memberId: MemberIdSchema, conclusion: z.string(), claims: z.array(ClaimDraftSchema) }).strict()
    ),
    conclusions: z.array(
      z
        .object({
          memberId: MemberIdSchema,
          conclusion: z.string(),
          origin: z.enum(["opening", "discussion", "review"])
        })
        .strict()
    ),
    claims: z.array(
      z
        .object({
          version: ClaimVersionSchema,
          label: PeerClaimLabelSchema,
          positions: z.array(z.object({ memberId: MemberIdSchema, position: ReviewPositionSchema }).strict())
        })
        .strict()
    ),
    claimVersions: z.array(ClaimVersionSchema),
    messages: z.array(PeerMessageSchema),
    unrespondedMessages: z.array(PeerMessageSchema),
    evidenceRequests: z.array(
      EvidenceRequestSchema.extend({
        memberId: MemberIdSchema,
        segmentId: z.number().int().positive(),
        phase: PeerPhaseSchema
      }).strict()
    ),
    rounds: z.array(RoundRecordSchema),
    reviews: z.array(MemberReviewSchema),
    attempts: z.array(PeerAttemptSchema),
    usage: UsageSchema,
    integrity: z
      .object({
        revision: z.number().int().nonnegative(),
        committedRounds: z.number().int().nonnegative(),
        uncommittedJobIds: z.array(id),
        pauseReason: PeerErrorSchema.optional()
      })
      .strict()
  })
  .strict();
export type PeerResultV1 = z.infer<typeof PeerResultV1Schema>;
