import { z } from "zod";
import { hashJson, sha256 } from "../peer/hash.js";
import {
  SyncIdSchema as BuildIdSchema,
  SyncHashSchema as BuildHashSchema,
  SyncVersionIdSchema as BuildVersionIdSchema,
  SyncPathSchema as BuildPathSchema,
  SyncContentHashesSchema as BuildContentHashesSchema,
  freezeSyncValue as freezeBuildValue,
  type SyncReadonly as BuildReadonly
} from "../agent-sync/kernel/primitives.js";
export {
  BuildIdSchema,
  BuildHashSchema,
  BuildVersionIdSchema,
  BuildPathSchema,
  BuildContentHashesSchema,
  freezeBuildValue,
  type BuildReadonly
};

export const BUILD_SCHEMA_VERSION = 1;
export const BUILD_PLAN_VERSION = "build-plan-v1";
export const BUILD_ACTION_VERSION = "build-action-v1";
export const BUILD_BUDGET_VERSION = "build-budget-v1";
export const BUILD_CHECK_VERSION = "build-check-v1";
export const BUILD_PUBLISH_VERSION = "build-publish-v1";
export const BUILD_RESULT_VERSION = "build-result-v1";

export const BuildMemberSchema = z.enum(["member-a", "member-b"]);
const positive = z.number().int().positive().safe();
const nonnegative = z.number().int().nonnegative().safe();
export const BUILD_BUDGET_DEFAULTS = Object.freeze({
  maxCallsPerTask: 12,
  maxOutputTokensPerCall: 4096,
  maxAllocatedOutputTokensPerTask: 49152,
  maxCalls: 36,
  maxAllocatedOutputTokens: 147456,
  callTimeoutMs: 120000,
  taskTimeoutMs: 900000,
  runTimeoutMs: 2700000
});
export const BuildBudgetSchema = z
  .object({
    budgetVersion: z.literal(BUILD_BUDGET_VERSION),
    maxCallsPerTask: positive.max(BUILD_BUDGET_DEFAULTS.maxCallsPerTask),
    maxOutputTokensPerCall: positive.max(BUILD_BUDGET_DEFAULTS.maxOutputTokensPerCall),
    maxAllocatedOutputTokensPerTask: positive.max(BUILD_BUDGET_DEFAULTS.maxAllocatedOutputTokensPerTask),
    maxCalls: positive.max(BUILD_BUDGET_DEFAULTS.maxCalls),
    maxAllocatedOutputTokens: positive.max(BUILD_BUDGET_DEFAULTS.maxAllocatedOutputTokens),
    callTimeoutMs: positive.max(BUILD_BUDGET_DEFAULTS.callTimeoutMs),
    taskTimeoutMs: positive.max(BUILD_BUDGET_DEFAULTS.taskTimeoutMs),
    runTimeoutMs: positive.max(BUILD_BUDGET_DEFAULTS.runTimeoutMs)
  })
  .strict()
  .superRefine((budget, ctx) => {
    if (
      budget.maxCallsPerTask > budget.maxCalls ||
      budget.maxOutputTokensPerCall > budget.maxAllocatedOutputTokensPerTask ||
      budget.maxAllocatedOutputTokensPerTask > budget.maxAllocatedOutputTokens
    )
      ctx.addIssue({ code: "custom", message: "Incoherent per-call/task/run budget" });
    if (budget.callTimeoutMs > budget.taskTimeoutMs || budget.taskTimeoutMs > budget.runTimeoutMs)
      ctx.addIssue({ code: "custom", message: "Incoherent call/task/run deadlines" });
  });
export type BuildBudget = BuildReadonly<z.infer<typeof BuildBudgetSchema>>;

export const BUILD_CHECK_GROUPS = ["common", "state-format", "report", "identity", "final"] as const;
export const BuildCheckGroupSchema = z.enum(BUILD_CHECK_GROUPS);
export type BuildCheckGroup = z.infer<typeof BuildCheckGroupSchema>;
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
const normalizePaths = (paths: string[]) => [...new Set(paths)].sort();
const ScopeSchema = z
  .object({ read: z.array(BuildPathSchema), write: z.array(BuildPathSchema).min(1) })
  .strict()
  .transform(({ read, write }) => ({
    read: normalizePaths(read.filter((path) => !write.includes(path))),
    write: normalizePaths(write)
  }));
const ProfileSchema = z
  .object({
    profileId: BuildCheckGroupSchema,
    groups: z.array(BuildCheckGroupSchema).min(1),
    checksHash: BuildHashSchema
  })
  .strict();
const versions = {
  buildSchemaVersion: z.literal(BUILD_SCHEMA_VERSION),
  planVersion: z.literal(BUILD_PLAN_VERSION),
  actionVersion: z.literal(BUILD_ACTION_VERSION),
  checkVersion: z.literal(BUILD_CHECK_VERSION),
  publishVersion: z.literal(BUILD_PUBLISH_VERSION),
  resultVersion: z.literal(BUILD_RESULT_VERSION)
};
const PlanObjectSchema = z
  .object({
    ...versions,
    projectKey: BuildIdSchema,
    memberIds: z.array(BuildMemberSchema).length(2),
    manifest: z
      .array(
        z
          .object({
            path: BuildPathSchema,
            access: z.enum(["read-only", "writable"]),
            contentHash: BuildHashSchema.nullable()
          })
          .strict()
      )
      .min(1),
    tasks: z
      .array(
        z
          .object({
            taskId: BuildIdSchema,
            workerId: BuildMemberSchema,
            scope: ScopeSchema,
            dependsOn: z.array(BuildIdSchema),
            checkProfileId: z.enum(["state-format", "report", "identity"])
          })
          .strict()
      )
      .min(1),
    profiles: z.array(ProfileSchema).length(5),
    budget: BuildBudgetSchema
  })
  .strict();
type PlanDefinition = z.infer<typeof PlanObjectSchema>;
function validatePlan(plan: PlanDefinition, ctx: z.RefinementCtx) {
  const reject = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!unique(plan.memberIds)) reject("Duplicate members");
  if (!unique(plan.tasks.map((task) => task.taskId))) reject("Duplicate tasks");
  if (!unique(plan.manifest.map((entry) => entry.path.toLowerCase()))) reject("Duplicate/ASCII alias manifest paths");
  const files = new Map(plan.manifest.map((entry) => [entry.path, entry]));
  if (plan.manifest.some((entry) => entry.access === "read-only" && entry.contentHash === null))
    reject("Read-only source must exist");
  const taskIds = new Set(plan.tasks.map((task) => task.taskId));
  for (const task of plan.tasks) {
    if (!plan.memberIds.includes(task.workerId)) reject("Unknown task worker");
    for (const path of [...task.scope.read, ...task.scope.write])
      if (!files.has(path)) reject("Unknown exact scope path");
    for (const path of task.scope.write)
      if (files.get(path)?.access !== "writable") reject("Write scope includes read-only file");
    if (!unique(task.dependsOn) || task.dependsOn.some((id) => !taskIds.has(id) || id === task.taskId))
      reject("Invalid task dependency");
    if (!plan.profiles.some((profile) => profile.profileId === task.checkProfileId))
      reject("Unknown task check profile");
  }
  // Kahn traversal: validate the graph only; no task scheduling or locks here.
  const visited = new Set<string>();
  while (true) {
    const ready = plan.tasks.filter(
      (task) => !visited.has(task.taskId) && task.dependsOn.every((id) => visited.has(id))
    );
    if (!ready.length) break;
    for (const task of ready) visited.add(task.taskId);
  }
  if (visited.size !== taskIds.size) reject("Dependency cycle or missing prerequisite");
  if (!unique(plan.profiles.map((profile) => profile.profileId))) reject("Duplicate check profile");
  for (const profile of plan.profiles) {
    const expected =
      profile.profileId === "final"
        ? [...BUILD_CHECK_GROUPS]
        : profile.profileId === "common"
          ? ["common"]
          : ["common", profile.profileId];
    if (
      !unique(profile.groups) ||
      profile.groups.length !== expected.length ||
      expected.some((group) => !profile.groups.includes(group as BuildCheckGroup))
    )
      reject("Profile must preserve common and required regression groups");
  }
}
export const BuildPlanSchema = PlanObjectSchema.superRefine(validatePlan);
export type BuildPlan = BuildReadonly<PlanDefinition & { planHash: string }>;
export const FrozenBuildPlanSchema = PlanObjectSchema.extend({ planHash: BuildHashSchema }).superRefine((plan, ctx) => {
  validatePlan(plan, ctx);
  const { planHash, ...definition } = plan;
  if (planHash !== hashJson(definition)) ctx.addIssue({ code: "custom", message: "Frozen plan hash mismatch" });
});
export function freezeBuildPlan(input: unknown): BuildPlan {
  const definition = BuildPlanSchema.parse(input);
  return freezeBuildValue({ ...definition, planHash: hashJson(definition) });
}

const AttemptSchema = z
  .object({
    attemptId: BuildIdSchema,
    taskId: BuildIdSchema,
    workerId: BuildMemberSchema,
    ownerEpoch: positive,
    leaseEpoch: positive.optional(),
    token: z.string().min(1).max(512),
    baseVersion: BuildVersionIdSchema,
    inputHash: BuildHashSchema.nullable(),
    contentHashes: BuildContentHashesSchema,
    startedAt: nonnegative,
    deadlineAt: nonnegative,
    status: z.enum(["running", "checking", "publishing", "completed", "paused", "cancelled"])
  })
  .strict();
const CallSchema = z
  .object({
    callId: BuildIdSchema,
    attemptId: BuildIdSchema,
    taskId: BuildIdSchema,
    inputHash: BuildHashSchema,
    allocatedOutputTokens: positive,
    reservedAt: nonnegative,
    deadlineAt: nonnegative,
    status: z.enum(["reserved", "succeeded", "failed", "cancelled", "unknown"])
  })
  .strict();
const ActionReceiptSchema = z
  .object({
    requestId: BuildIdSchema,
    attemptId: BuildIdSchema,
    inputHash: BuildHashSchema,
    payloadHash: BuildHashSchema,
    kind: z.enum(["inspect", "edit", "check", "finish", "abort"]),
    status: z.enum(["succeeded", "rejected"]),
    outputHash: BuildHashSchema.nullable()
  })
  .strict();
const ImageDigestSchema = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/);
/** Legacy stage-0 evidence remains readable; new stage-3 context is all-or-none. */
export const BuildCheckReceiptSchema = z
  .object({
    checkVersion: z.literal(BUILD_CHECK_VERSION),
    receiptId: BuildIdSchema,
    attemptId: BuildIdSchema,
    candidateHash: BuildHashSchema,
    checksHash: BuildHashSchema,
    groups: z.array(BuildCheckGroupSchema).min(1),
    toolchainHash: BuildHashSchema,
    isolationHash: BuildHashSchema,
    exitCode: z.number().int().safe(),
    passed: z.boolean(),
    baseVersion: BuildVersionIdSchema.optional(),
    version: BuildVersionIdSchema.optional(),
    planHash: BuildHashSchema.optional(),
    imageDigest: ImageDigestSchema.optional(),
    sourceHashBefore: BuildHashSchema.optional(),
    sourceHashAfter: BuildHashSchema.optional()
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!unique(receipt.groups) || receipt.passed !== (receipt.exitCode === 0))
      ctx.addIssue({ code: "custom", message: "Inconsistent host check receipt" });
    const context = [
      receipt.baseVersion,
      receipt.version,
      receipt.planHash,
      receipt.imageDigest,
      receipt.sourceHashBefore,
      receipt.sourceHashAfter
    ];
    if (context.some((v) => v !== undefined) && context.some((v) => v === undefined))
      ctx.addIssue({ code: "custom", message: "Incomplete isolated check context" });
    if (receipt.passed && receipt.sourceHashBefore !== receipt.sourceHashAfter)
      ctx.addIssue({ code: "custom", message: "Successful check changed immutable source" });
  });
export type BuildCheckReceipt = BuildReadonly<z.infer<typeof BuildCheckReceiptSchema>>;
export const BuildPublishReceiptSchema = z
  .object({
    publishVersion: z.literal(BUILD_PUBLISH_VERSION),
    receiptId: BuildIdSchema,
    attemptId: BuildIdSchema,
    requestId: BuildIdSchema,
    checkReceiptId: BuildIdSchema,
    baseVersion: BuildVersionIdSchema,
    acceptedVersion: BuildVersionIdSchema,
    candidateHash: BuildHashSchema,
    checksHash: BuildHashSchema,
    requestHash: BuildHashSchema.optional(),
    planHash: BuildHashSchema.optional(),
    ownerEpoch: positive.optional(),
    leaseEpoch: positive.optional(),
    inputHash: BuildHashSchema.optional(),
    overlayHash: BuildHashSchema.optional(),
    toolchainHash: BuildHashSchema.optional(),
    isolationHash: BuildHashSchema.optional(),
    imageDigest: ImageDigestSchema.optional()
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const context = [
      receipt.requestHash,
      receipt.planHash,
      receipt.ownerEpoch,
      receipt.leaseEpoch,
      receipt.inputHash,
      receipt.overlayHash,
      receipt.toolchainHash,
      receipt.isolationHash,
      receipt.imageDigest
    ];
    if (context.some((v) => v !== undefined) && context.some((v) => v === undefined))
      ctx.addIssue({ code: "custom", message: "Incomplete publication context" });
  });
export type BuildPublishReceipt = BuildReadonly<z.infer<typeof BuildPublishReceiptSchema>>;
/** Pure coordination metadata; optional on stage-0 snapshots, required by parseBuildState. */
export const BuildLeaseSchema = z
  .object({
    attemptId: BuildIdSchema,
    taskId: BuildIdSchema,
    workerId: BuildMemberSchema,
    ownerEpoch: positive,
    leaseEpoch: positive,
    token: z.string().min(1).max(512)
  })
  .strict();
export type BuildLease = BuildReadonly<z.infer<typeof BuildLeaseSchema>>;
export const BuildWaitReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dependency"), taskIds: z.array(BuildIdSchema).min(1) }).strict(),
  z.object({ kind: z.literal("worker"), attemptIds: z.array(BuildIdSchema).min(1) }).strict(),
  z
    .object({
      kind: z.literal("lock"),
      paths: z.array(BuildPathSchema).min(1),
      attemptIds: z.array(BuildIdSchema).min(1)
    })
    .strict(),
  z.object({ kind: z.literal("queue"), taskIds: z.array(BuildIdSchema).min(1) }).strict()
]);
export type BuildWaitReason = BuildReadonly<z.infer<typeof BuildWaitReasonSchema>>;
const ControlResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("granted"), lease: BuildLeaseSchema }).strict(),
  z
    .object({ kind: z.literal("waiting"), taskId: BuildIdSchema, reasons: z.array(BuildWaitReasonSchema).min(1) })
    .strict(),
  z.object({ kind: z.literal("released"), attemptId: BuildIdSchema }).strict(),
  z.object({ kind: z.literal("revoked"), attemptId: BuildIdSchema }).strict(),
  z.object({ kind: z.literal("cancelled"), taskId: BuildIdSchema }).strict(),
  z.object({ kind: z.literal("bound"), attemptId: BuildIdSchema }).strict(),
  z.object({ kind: z.literal("epoch_advanced"), ownerEpoch: positive }).strict(),
  z.object({ kind: z.literal("settled"), receipt: ActionReceiptSchema }).strict()
]);
export const BuildCoordinationSchema = z
  .object({
    coordinationVersion: z.literal("build-scope-v1"),
    lastNow: nonnegative,
    nextSequence: nonnegative,
    taskEpochs: z.record(nonnegative),
    taskStates: z.record(
      z.enum(["queued", "waiting", "running", "checking", "publishing", "completed", "paused", "cancelled"])
    ),
    locks: z.array(
      z
        .object({
          path: BuildPathSchema,
          mode: z.enum(["R", "W"]),
          taskId: BuildIdSchema,
          attemptId: BuildIdSchema,
          leaseEpoch: positive
        })
        .strict()
    ),
    requests: z.array(
      z
        .object({
          requestId: BuildIdSchema,
          payloadHash: BuildHashSchema,
          operation: z.enum(["reserve", "release", "revoke", "cancel", "bind", "epoch", "action"]),
          status: z.enum(["pending", "succeeded", "invalidated"]),
          attemptId: BuildIdSchema.nullable(),
          binding: z
            .object({
              kind: z.enum(["inspect", "edit", "check", "finish", "abort"]),
              inputHash: BuildHashSchema,
              payloadHash: BuildHashSchema,
              leaseHash: BuildHashSchema
            })
            .strict()
            .nullable(),
          result: ControlResultSchema.nullable()
        })
        .strict()
    )
  })
  .strict();
export type BuildCoordination = BuildReadonly<z.infer<typeof BuildCoordinationSchema>>;
export type BuildControlResult = BuildReadonly<z.infer<typeof ControlResultSchema>>;
export type BuildCoordinationRequest = BuildCoordination["requests"][number];
export type BuildAttempt = BuildRun["attempts"][number];
export const BuildStagedFileSchema = z
  .object({ path: BuildPathSchema, blobId: BuildVersionIdSchema, contentHash: BuildHashSchema })
  .strict();
const BuildCandidateSchema = z
  .object({
    attemptId: BuildIdSchema,
    baseVersion: BuildVersionIdSchema,
    version: BuildVersionIdSchema,
    overlayHash: BuildHashSchema,
    candidateHash: BuildHashSchema
  })
  .strict();
export const BuildToolResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("frozen"),
      baseVersion: BuildVersionIdSchema,
      inputHash: BuildHashSchema,
      contentHashes: BuildContentHashesSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspected"),
      baseVersion: BuildVersionIdSchema,
      path: BuildPathSchema,
      text: z.string().nullable(),
      contentHash: BuildHashSchema.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("edited"),
      baseVersion: BuildVersionIdSchema,
      overlayHash: BuildHashSchema,
      files: z.array(BuildStagedFileSchema)
    })
    .strict(),
  z
    .object({
      kind: z.literal("sealed"),
      baseVersion: BuildVersionIdSchema,
      version: BuildVersionIdSchema,
      overlayHash: BuildHashSchema,
      candidateHash: BuildHashSchema
    })
    .strict()
]);
const toolRequestBase = { requestId: BuildIdSchema, lease: BuildLeaseSchema };
export const BuildWorkspaceRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...toolRequestBase, operation: z.literal("freeze") }).strict(),
  z.object({ ...toolRequestBase, operation: z.literal("inspect"), path: BuildPathSchema }).strict(),
  z
    .object({
      ...toolRequestBase,
      operation: z.literal("edit"),
      edits: z
        .array(
          z
            .object({ path: BuildPathSchema, text: z.string(), expectedContentHash: BuildHashSchema.nullable() })
            .strict()
        )
        .min(1)
    })
    .strict(),
  z.object({ ...toolRequestBase, operation: z.literal("seal") }).strict()
]);
export type BuildWorkspaceRequest = BuildReadonly<z.infer<typeof BuildWorkspaceRequestSchema>>;
export const BuildWorkspaceSchema = z
  .object({
    workspaceVersion: z.literal("build-workspace-v1"),
    staging: z.array(
      z
        .object({
          attemptId: BuildIdSchema,
          baseVersion: BuildVersionIdSchema,
          overlayHash: BuildHashSchema,
          files: z.array(BuildStagedFileSchema)
        })
        .strict()
    ),
    candidates: z.array(BuildCandidateSchema),
    toolReceipts: z.array(
      z
        .object({
          requestId: BuildIdSchema,
          attemptId: BuildIdSchema,
          operation: z.enum(["freeze", "inspect", "edit", "seal"]),
          requestHash: BuildHashSchema,
          request: BuildWorkspaceRequestSchema,
          outputHash: BuildHashSchema,
          result: BuildToolResultSchema
        })
        .strict()
    )
  })
  .strict();
export type BuildWorkspace = BuildReadonly<z.infer<typeof BuildWorkspaceSchema>>;
export type BuildStagedFile = BuildReadonly<z.infer<typeof BuildStagedFileSchema>>;
export type BuildToolResult = BuildReadonly<z.infer<typeof BuildToolResultSchema>>;
export type BuildToolReceipt = BuildWorkspace["toolReceipts"][number];
export type BuildCandidate = BuildWorkspace["candidates"][number];
export const BuildRunSchema = z
  .object({
    ...versions,
    budgetVersion: z.literal(BUILD_BUDGET_VERSION),
    projectKey: BuildIdSchema,
    runId: BuildIdSchema,
    revision: nonnegative,
    ownerEpoch: positive,
    plan: FrozenBuildPlanSchema,
    acceptedVersion: BuildVersionIdSchema,
    status: z.enum(["active", "paused", "completed", "cancelled"]),
    startedAt: nonnegative,
    deadlineAt: nonnegative,
    acceptedTasks: z.array(BuildIdSchema),
    waiting: z.array(z.object({ taskId: BuildIdSchema, sequence: nonnegative }).strict()),
    attempts: z.array(AttemptSchema),
    calls: z.array(CallSchema),
    actionReceipts: z.array(ActionReceiptSchema),
    checkReceipts: z.array(BuildCheckReceiptSchema),
    publishReceipts: z.array(BuildPublishReceiptSchema),
    coordination: BuildCoordinationSchema.optional(),
    workspace: BuildWorkspaceSchema.optional()
  })
  .strict()
  .superRefine((run, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    const tasks = new Map(run.plan.tasks.map((task) => [task.taskId, task]));
    const attempts = new Map(run.attempts.map((attempt) => [attempt.attemptId, attempt]));
    if (run.projectKey !== run.plan.projectKey) reject("Project/plan mismatch");
    if (run.deadlineAt <= run.startedAt || run.deadlineAt - run.startedAt > run.plan.budget.runTimeoutMs)
      reject("Run deadline exceeds frozen budget");
    if (!unique(run.acceptedTasks) || run.acceptedTasks.some((id) => !tasks.has(id)))
      reject("Invalid accepted task references");
    if (
      !unique(run.waiting.map((item) => item.taskId)) ||
      !unique(run.waiting.map((item) => item.sequence)) ||
      run.waiting.some((item) => !tasks.has(item.taskId))
    )
      reject("Invalid waiting references");
    if (!unique(run.attempts.map((item) => item.attemptId))) reject("Duplicate attempts");
    for (const attempt of run.attempts) {
      const task = tasks.get(attempt.taskId);
      if (!task || task.workerId !== attempt.workerId || attempt.ownerEpoch > run.ownerEpoch) {
        reject("Invalid attempt identity");
        continue;
      }
      const paths = [...task.scope.read, ...task.scope.write];
      if (
        attempt.inputHash === null
          ? Object.keys(attempt.contentHashes).length !== 0
          : Object.keys(attempt.contentHashes).length !== paths.length ||
            paths.some((path) => !Object.hasOwn(attempt.contentHashes, path))
      )
        reject("Bound attempt hashes must cover exact scope; unbound attempts have no content input");
      if (
        attempt.startedAt < run.startedAt ||
        attempt.deadlineAt <= attempt.startedAt ||
        attempt.deadlineAt > run.deadlineAt ||
        attempt.deadlineAt - attempt.startedAt > run.plan.budget.taskTimeoutMs
      )
        reject("Attempt deadline exceeds frozen budget");
    }
    if (!unique(run.calls.map((item) => item.callId))) reject("Duplicate model calls");
    for (const call of run.calls) {
      const attempt = attempts.get(call.attemptId);
      if (!attempt || attempt.taskId !== call.taskId || attempt.inputHash !== call.inputHash)
        reject("Invalid model call reference");
      if (
        call.allocatedOutputTokens > run.plan.budget.maxOutputTokensPerCall ||
        call.deadlineAt <= call.reservedAt ||
        call.deadlineAt - call.reservedAt > run.plan.budget.callTimeoutMs ||
        (attempt && (call.reservedAt < attempt.startedAt || call.deadlineAt > attempt.deadlineAt))
      )
        reject("Call allocation or deadline exceeds frozen budget");
    }
    // Every reserved/dispatched call counts, including failed/cancelled/unknown; no refunds.
    if (
      run.calls.length > run.plan.budget.maxCalls ||
      run.calls.reduce((sum, call) => sum + call.allocatedOutputTokens, 0) > run.plan.budget.maxAllocatedOutputTokens
    )
      reject("Run allocation exceeds frozen budget");
    for (const task of run.plan.tasks) {
      const calls = run.calls.filter((call) => call.taskId === task.taskId);
      if (
        calls.length > run.plan.budget.maxCallsPerTask ||
        calls.reduce((sum, call) => sum + call.allocatedOutputTokens, 0) >
          run.plan.budget.maxAllocatedOutputTokensPerTask
      )
        reject("Task allocation exceeds frozen budget");
    }
    for (const list of [
      run.actionReceipts.map((item) => item.requestId),
      run.checkReceipts.map((item) => item.receiptId),
      run.publishReceipts.map((item) => item.receiptId)
    ])
      if (!unique(list)) reject("Duplicate receipt IDs");
    for (const receipt of [...run.actionReceipts, ...run.checkReceipts, ...run.publishReceipts])
      if (!attempts.has(receipt.attemptId)) reject("Unknown receipt attempt");
    for (const receipt of run.actionReceipts)
      if (attempts.get(receipt.attemptId)?.inputHash !== receipt.inputHash) reject("Action receipt input mismatch");
    if (run.workspace) {
      const w = run.workspace;
      if (
        !unique(w.staging.map((x) => x.attemptId)) ||
        !unique(w.candidates.map((x) => `${x.attemptId}:${x.version}`)) ||
        !unique(w.toolReceipts.map((x) => x.requestId))
      )
        reject("Duplicate workspace identity");
      const overlayHash = (
        attemptId: string,
        baseVersion: string,
        files: readonly z.infer<typeof BuildStagedFileSchema>[]
      ) => hashJson({ attemptId, baseVersion, files });
      for (const overlay of w.staging) {
        const attempt = attempts.get(overlay.attemptId);
        const task = attempt && tasks.get(attempt.taskId);
        if (
          !attempt ||
          !task ||
          attempt.baseVersion !== overlay.baseVersion ||
          !unique(overlay.files.map((x) => x.path)) ||
          overlay.files.some((x) => !task.scope.write.includes(x.path)) ||
          overlay.overlayHash !== overlayHash(overlay.attemptId, overlay.baseVersion, overlay.files)
        )
          reject("Invalid private staging reference or hash");
      }
      for (const candidate of w.candidates)
        if (
          !attempts.has(candidate.attemptId) ||
          attempts.get(candidate.attemptId)?.baseVersion !== candidate.baseVersion
        )
          reject("Invalid candidate attempt/base");
      for (const receipt of w.toolReceipts) {
        const attempt = attempts.get(receipt.attemptId);
        const task = attempt && tasks.get(attempt.taskId);
        const result = receipt.result;
        if (
          !attempt ||
          !task ||
          result.baseVersion !== attempt.baseVersion ||
          receipt.outputHash !== hashJson(result)
        ) {
          reject("Invalid workspace receipt reference/hash");
          continue;
        }
        const request = receipt.request;
        if (
          request.requestId !== receipt.requestId ||
          request.lease.attemptId !== receipt.attemptId ||
          request.operation !== receipt.operation ||
          request.lease.taskId !== attempt.taskId ||
          request.lease.workerId !== attempt.workerId ||
          request.lease.ownerEpoch !== attempt.ownerEpoch ||
          request.lease.leaseEpoch !== attempt.leaseEpoch ||
          request.lease.token !== attempt.token ||
          receipt.requestHash !==
            hashJson({ projectKey: run.projectKey, runId: run.runId, planHash: run.plan.planHash, request })
        )
          reject("Workspace request/receipt identity mismatch");
        if (
          request.operation === "inspect" &&
          (![...task.scope.read, ...task.scope.write].includes(request.path) ||
            result.kind !== "inspected" ||
            result.path !== request.path)
        )
          reject("Inspect request scope mismatch");
        if (
          request.operation === "edit" &&
          (!unique(request.edits.map((x) => x.path)) ||
            request.edits.some((x) => !task.scope.write.includes(x.path)) ||
            result.kind !== "edited" ||
            request.edits.some(
              (edit) => !result.files.some((file) => file.path === edit.path && file.contentHash === sha256(edit.text))
            ))
        )
          reject("Edit request/receipt mismatch");
        const kinds = { freeze: "frozen", inspect: "inspected", edit: "edited", seal: "sealed" };
        if (result.kind !== kinds[receipt.operation]) reject("Workspace receipt operation mismatch");
        if (run.coordination?.requests.some((x) => x.requestId === receipt.requestId))
          reject("Workspace request ID reuses control/model request");
        if (
          result.kind === "frozen" &&
          (result.inputHash !== attempt.inputHash || hashJson(result.contentHashes) !== hashJson(attempt.contentHashes))
        )
          reject("Frozen receipt input mismatch");
        if (
          result.kind === "inspected" &&
          (![...task.scope.read, ...task.scope.write].includes(result.path) ||
            (result.text === null) !== (result.contentHash === null) ||
            (result.text !== null && result.contentHash !== sha256(result.text)))
        )
          reject("Inspect receipt scope/content mismatch");
        if (
          result.kind === "edited" &&
          (!unique(result.files.map((x) => x.path)) ||
            result.files.some((x) => !task.scope.write.includes(x.path)) ||
            result.overlayHash !== overlayHash(attempt.attemptId, attempt.baseVersion, result.files))
        )
          reject("Edit receipt scope/overlay mismatch");
        if (
          result.kind === "sealed" &&
          !w.candidates.some(
            (c) =>
              hashJson(c) ===
              hashJson({
                attemptId: attempt.attemptId,
                ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "kind"))
              })
          )
        )
          reject("Seal receipt missing candidate");
      }
    }
    for (const receipt of run.publishReceipts) {
      const check = run.checkReceipts.find((item) => item.receiptId === receipt.checkReceiptId);
      if (
        !check?.passed ||
        check.attemptId !== receipt.attemptId ||
        check.candidateHash !== receipt.candidateHash ||
        check.checksHash !== receipt.checksHash
      )
        reject("Publish receipt has no matching successful host check");
      if (receipt.requestHash !== undefined) {
        const attempt = attempts.get(receipt.attemptId);
        if (
          !check ||
          check.version !== receipt.acceptedVersion ||
          check.baseVersion !== receipt.baseVersion ||
          check.planHash !== receipt.planHash ||
          receipt.planHash !== run.plan.planHash ||
          check.toolchainHash !== receipt.toolchainHash ||
          check.isolationHash !== receipt.isolationHash ||
          check.imageDigest !== receipt.imageDigest ||
          !attempt ||
          attempt.inputHash !== receipt.inputHash ||
          attempt.ownerEpoch !== receipt.ownerEpoch ||
          attempt.leaseEpoch !== receipt.leaseEpoch ||
          attempt.status !== "completed" ||
          !run.acceptedTasks.includes(attempt.taskId)
        )
          reject("Publication context does not match isolated evidence and completed attempt");
      }
    }
  });
export type BuildRun = BuildReadonly<z.infer<typeof BuildRunSchema>>;
/** Format and reference validation; stage 2 will add durable ownership/replay validation. */
export function parseBuildRun(input: unknown): BuildRun {
  return freezeBuildValue(BuildRunSchema.parse(input));
}
