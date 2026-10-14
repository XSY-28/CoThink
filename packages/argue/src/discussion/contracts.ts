import { z } from "zod";

export const DISCUSSION_SCHEMA_VERSION = 2;
export const DISCUSSION_PROMPT_VERSION = "peer-v6";
export const DISCUSSION_CODEC_VERSION = "discussion-json-v1";
export const DISCUSSION_POLICY_VERSION = "discussion-policy-v1";

/** Routing header only. The executable state schema arrives with the protocol. */
export const DiscussionSessionHeaderSchema = z.object({
  schemaVersion: z.literal(DISCUSSION_SCHEMA_VERSION),
  promptVersion: z.literal(DISCUSSION_PROMPT_VERSION),
  codecVersion: z.literal(DISCUSSION_CODEC_VERSION),
  policyVersion: z.literal(DISCUSSION_POLICY_VERSION),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  revision: z.number().int().nonnegative()
});
export type DiscussionSessionHeader = z.infer<typeof DiscussionSessionHeaderSchema>;

export type AgentId = string;
export type Effort = "low" | "standard" | "high";
export type Complexity = "simple" | "moderate" | "complex";

export interface AgentWeights {
  readonly participationWeight: number;
  readonly decisionWeight: number;
}

export interface DiscussionPolicy {
  readonly policyVersion: typeof DISCUSSION_POLICY_VERSION;
  readonly effort: Effort;
  readonly weights: Readonly<Record<AgentId, AgentWeights>>;
  /** Frozen roster permutation used for rotating equal allocation remainders. */
  readonly roundingOrder: readonly AgentId[];
  readonly maxRounds?: number;
  readonly maxCalls: number;
  readonly maxAllocatedOutputTokens: number;
  readonly maxDurationMs: number;
  readonly callTimeoutMs: number;
}

/** Recursive readonly contracts; reducers return new, deeply frozen snapshots. */
export type DiscussionReadonly<T> = T extends readonly (infer U)[]
  ? readonly DiscussionReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DiscussionReadonly<T[K]> }
    : T;
const discussionText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Text must contain non-whitespace content");
const discussionId = discussionText;
export const DiscussionSourceRefSchema = z
  .object({ sourceId: discussionId, startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .strict();
export const DiscussionSourceSchema = z
  .object({
    sourceId: discussionId,
    name: z.string().optional(),
    content: z.string(),
    contentHash: discussionId,
    lineCount: z.number().int().positive()
  })
  .strict();
export const DiscussionClaimDraftSchema = z
  .object({
    statement: discussionText,
    rationale: discussionText,
    assumptions: z.array(discussionText).default([]),
    sourceRefs: z.array(DiscussionSourceRefSchema).default([])
  })
  .strict();
export const DiscussionClaimVersionSchema = DiscussionClaimDraftSchema.extend({
  claimId: discussionId,
  versionId: discussionId,
  authorId: discussionId,
  segmentId: z.number().int().positive(),
  roundIndex: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  previousVersionId: discussionId.optional(),
  withdrawn: z.boolean(),
  withdrawalReason: discussionText.optional()
}).strict();
export const OpeningAnswerDraftSchema = z
  .object({
    body: discussionText,
    basisDraftIndices: z.array(z.number().int().nonnegative()),
    limitations: z.array(discussionText).default([]),
    unresolvedObjectionIds: z.array(discussionId)
  })
  .strict();
export const DiscussionAnswerDraftSchema = z
  .object({
    previousVersionId: discussionId,
    body: discussionText,
    basisVersionIds: z.array(discussionId),
    limitations: z.array(discussionText).default([]),
    unresolvedObjectionIds: z.array(discussionId)
  })
  .strict();
export const AnswerVersionSchema = z
  .object({
    answerVersionId: discussionId,
    authorId: discussionId,
    previousVersionId: discussionId.optional(),
    segmentId: z.number().int().positive(),
    roundIndex: z.number().int().nonnegative(),
    body: discussionText,
    basisVersionIds: z.array(discussionId),
    limitations: z.array(discussionText),
    unresolvedObjectionIds: z.array(discussionId)
  })
  .strict();
export const ImportantObjectionDraftSchema = z
  .object({
    targetAnswerVersionId: discussionId,
    targetClaimVersionId: discussionId.optional(),
    severity: z.enum(["material", "blocking"]),
    summary: discussionText,
    impact: discussionText,
    evidenceNeeded: discussionText
  })
  .strict();
export const ImportantObjectionSchema = ImportantObjectionDraftSchema.extend({
  objectionId: discussionId,
  authorId: discussionId,
  segmentId: z.number().int().positive(),
  roundIndex: z.number().int().nonnegative()
}).strict();
export const DiscussionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claim"), versionId: discussionId }).strict(),
  z.object({ kind: z.literal("answer"), answerVersionId: discussionId }).strict()
]);
export const DiscussionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("propose"), claim: DiscussionClaimDraftSchema }).strict(),
  z.object({ kind: z.literal("revise"), targetVersionId: discussionId, claim: DiscussionClaimDraftSchema }).strict(),
  z.object({ kind: z.literal("withdraw"), targetVersionId: discussionId, rationale: discussionText }).strict(),
  z
    .object({
      kind: z.literal("ask"),
      target: DiscussionTargetSchema,
      recipientId: discussionId,
      rationale: discussionText,
      sourceRefs: z.array(DiscussionSourceRefSchema).default([])
    })
    .strict(),
  z
    .object({
      kind: z.literal("challenge"),
      target: DiscussionTargetSchema,
      recipientId: discussionId,
      rationale: discussionText,
      sourceRefs: z.array(DiscussionSourceRefSchema).default([])
    })
    .strict(),
  z
    .object({
      kind: z.literal("reply"),
      replyTo: discussionId,
      rationale: discussionText,
      sourceRefs: z.array(DiscussionSourceRefSchema).default([])
    })
    .strict(),
  z.object({ kind: z.literal("object"), objection: ImportantObjectionDraftSchema }).strict()
]);
const stanceSchema = z.enum(["accept", "reject", "uncertain"]);
const reviewMetadata = {
  stance: stanceSchema,
  rationale: discussionText,
  sourceRefs: z.array(DiscussionSourceRefSchema).default([])
};
export const DiscussionReviewPositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claim"), versionId: discussionId, ...reviewMetadata }).strict(),
  z.object({ kind: z.literal("answer"), answerVersionId: discussionId, ...reviewMetadata }).strict(),
  z
    .object({
      kind: z.literal("objection"),
      objectionId: discussionId,
      ...reviewMetadata,
      status: z.enum(["retained", "resolved", "withdrawn"]).optional(),
      summary: discussionText.optional(),
      impact: discussionText.optional(),
      evidenceNeeded: discussionText.optional()
    })
    .strict()
]);
export const DiscussionOpeningTurnSchema = z
  .object({
    phase: z.literal("opening"),
    claims: z.array(DiscussionClaimDraftSchema).max(3),
    answer: OpeningAnswerDraftSchema,
    complexity: z.enum(["simple", "moderate", "complex"]),
    complexityRationale: discussionText,
    evidenceRequests: z.array(discussionText).default([])
  })
  .strict();
export const DiscussionExchangeTurnSchema = z
  .object({
    phase: z.literal("discussion"),
    actions: z.array(DiscussionActionSchema),
    answer: DiscussionAnswerDraftSchema,
    readyToReview: z.boolean(),
    evidenceRequests: z.array(discussionText).default([])
  })
  .strict();
export const DiscussionReviewTurnSchema = z
  .object({
    phase: z.literal("review"),
    reviewSetHash: discussionId,
    positions: z.array(DiscussionReviewPositionSchema),
    evidenceRequests: z.array(discussionText).default([])
  })
  .strict();
export const DiscussionProtocolTurnSchema = z.discriminatedUnion("phase", [
  DiscussionOpeningTurnSchema,
  DiscussionExchangeTurnSchema,
  DiscussionReviewTurnSchema
]);
export const DiscussionReplySchema = z
  .object({ memberId: discussionId, snapshotId: discussionId, payload: z.unknown() })
  .strict();
export const SealedDiscussionReplySchema = DiscussionReplySchema.extend({
  payload: DiscussionProtocolTurnSchema,
  payloadHash: discussionId
}).strict();
export const DiscussionMessageSchema = z
  .object({
    messageId: discussionId,
    authorId: discussionId,
    recipientId: discussionId,
    kind: z.enum(["ask", "challenge", "reply"]),
    target: DiscussionTargetSchema.optional(),
    replyTo: discussionId.optional(),
    rationale: discussionText,
    sourceRefs: z.array(DiscussionSourceRefSchema),
    segmentId: z.number().int().positive(),
    roundIndex: z.number().int().nonnegative(),
    respondedBy: z.array(discussionId)
  })
  .strict();
export const ReviewEpochSchema = z
  .object({
    epochId: z.number().int().positive(),
    contextHash: discussionId,
    segmentId: z.number().int().positive(),
    contextVersion: z.number().int().positive(),
    roundIndex: z.number().int().positive(),
    expectedMembers: z.array(discussionId).min(2),
    claimVersions: z.array(DiscussionClaimVersionSchema),
    answerVersions: z.array(AnswerVersionSchema),
    objections: z.array(ImportantObjectionSchema),
    reviewSetHash: discussionId,
    status: z.enum(["pending", "committed"]),
    reviews: z.array(z.object({ memberId: discussionId, turn: DiscussionReviewTurnSchema }).strict())
  })
  .strict();
export const ObjectionResolutionSchema = z
  .object({
    objectionId: discussionId,
    authorId: discussionId,
    status: z.enum(["retained", "resolved", "withdrawn"]),
    epochId: z.number().int().positive()
  })
  .strict();
/** Structural schema only; parseDiscussionSession also replays committed history. */
export const DiscussionSessionSchema = DiscussionSessionHeaderSchema.extend({
  policy: z.custom<DiscussionPolicy>(),
  policyHash: discussionId,
  question: discussionText,
  constraints: z.array(discussionText),
  sources: z.array(DiscussionSourceSchema),
  segmentId: z.number().int().positive(),
  contextVersion: z.number().int().positive(),
  memberIds: z.array(discussionId).min(2),
  phase: z.enum(["opening", "discussion", "review"]),
  roundIndex: z.number().int().nonnegative(),
  committedSeq: z.number().int().nonnegative(),
  claimVersions: z.array(DiscussionClaimVersionSchema),
  answerVersions: z.array(AnswerVersionSchema),
  objections: z.array(ImportantObjectionSchema),
  messages: z.array(DiscussionMessageSchema),
  reviewEpochs: z.array(ReviewEpochSchema),
  objectionResolutions: z.array(ObjectionResolutionSchema),
  complexities: z.custom<Record<string, Complexity>>(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === "string" &&
          ["simple", "moderate", "complex"].includes((value as Record<string, unknown>)[key] as string)
      )
  ),
  committedBatches: z.array(
    z
      .object({
        snapshotId: discussionId,
        phase: z.enum(["opening", "discussion", "review"]),
        roundIndex: z.number().int().nonnegative(),
        replies: z.array(SealedDiscussionReplySchema)
      })
      .strict()
  ),
  pendingBatch: z
    .object({
      snapshotId: discussionId,
      phase: z.enum(["opening", "discussion", "review"]),
      expectedMembers: z.array(discussionId),
      sealedReplies: z.array(SealedDiscussionReplySchema)
    })
    .strict()
    .optional()
}).strict();
export type DiscussionSourceRef = DiscussionReadonly<z.infer<typeof DiscussionSourceRefSchema>>;
export type DiscussionSource = DiscussionReadonly<z.infer<typeof DiscussionSourceSchema>>;
export type DiscussionClaimDraft = DiscussionReadonly<z.infer<typeof DiscussionClaimDraftSchema>>;
export type DiscussionClaimVersion = DiscussionReadonly<z.infer<typeof DiscussionClaimVersionSchema>>;
export type OpeningAnswerDraft = DiscussionReadonly<z.infer<typeof OpeningAnswerDraftSchema>>;
export type DiscussionAnswerDraft = DiscussionReadonly<z.infer<typeof DiscussionAnswerDraftSchema>>;
export type AnswerVersion = DiscussionReadonly<z.infer<typeof AnswerVersionSchema>>;
export type ImportantObjection = DiscussionReadonly<z.infer<typeof ImportantObjectionSchema>>;
export type DiscussionAction = DiscussionReadonly<z.infer<typeof DiscussionActionSchema>>;
export type DiscussionProtocolTurn = DiscussionReadonly<z.infer<typeof DiscussionProtocolTurnSchema>>;
export type DiscussionReviewTurn = DiscussionReadonly<z.infer<typeof DiscussionReviewTurnSchema>>;
export type DiscussionReply = DiscussionReadonly<z.infer<typeof DiscussionReplySchema>>;
export type SealedDiscussionReply = DiscussionReadonly<z.infer<typeof SealedDiscussionReplySchema>>;
export type ReviewEpoch = DiscussionReadonly<z.infer<typeof ReviewEpochSchema>>;
export type DiscussionSession = DiscussionReadonly<z.infer<typeof DiscussionSessionSchema>>;
export interface DiscussionSessionInput {
  readonly sessionId: string;
  readonly question: string;
  readonly constraints?: readonly string[];
  readonly memberIds: readonly AgentId[];
  readonly policy: unknown;
  readonly sources?: readonly { readonly sourceId: string; readonly name?: string; readonly content: string }[];
}
export interface DiscussionSemanticSnapshot {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly segmentId: number;
  readonly contextVersion: number;
  readonly phase: DiscussionSession["phase"];
  readonly roundIndex: number;
  readonly committedSeq: number;
  readonly question: string;
  readonly constraints: readonly string[];
  readonly memberIds: readonly AgentId[];
  readonly sources: readonly DiscussionSource[];
  readonly claimVersions: readonly DiscussionClaimVersion[];
  readonly answerVersions: readonly AnswerVersion[];
  readonly objections: readonly ImportantObjection[];
  /** Read-only historical text: never valid new basis or review slots. */
  readonly historicalClaimVersions: readonly DiscussionClaimVersion[];
  readonly historicalAnswerVersions: readonly AnswerVersion[];
  readonly messages: DiscussionSession["messages"];
  readonly reviewEpoch?: ReviewEpoch;
  readonly lastReviews: readonly { readonly memberId: string; readonly turn: DiscussionReviewTurn }[];
}
