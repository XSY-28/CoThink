import { z } from "zod";
import { hashJson, sha256 } from "../../peer/hash.js";
import {
  SyncIdSchema as Id,
  SyncHashSchema as Hash,
  SyncVersionIdSchema as Version,
  SyncPathSchema as Path,
  SyncContentHashesSchema as ContentHashes,
  freezeSyncValue,
  type SyncReadonly
} from "../kernel/primitives.js";

export const AGENT_SYNC_PROJECT_VERSION = "agent-sync-project-v1";
export const AGENT_SYNC_STATE_VERSION = "agent-sync-state-v1";
export const AGENT_SYNC_REQUEST_VERSION = "agent-sync-request-v1";
export const AGENT_SYNC_LEASE_VERSION = "agent-sync-lease-v1";
export const AGENT_SYNC_TOOL_RECEIPT_VERSION = "agent-sync-tool-receipt-v1";
export const AGENT_SYNC_CANDIDATE_VERSION = "agent-sync-candidate-v1";
export const AGENT_SYNC_WORKSPACE_VERSION = "agent-sync-workspace-v1";
export const AGENT_SYNC_CHECK_VERSION = "agent-sync-check-v1";
export const AGENT_SYNC_PUBLISH_VERSION = "agent-sync-publish-v1";
const positive = z.number().int().positive().safe();
const nonnegative = z.number().int().nonnegative().safe();
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
const reject = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: "custom", message });
export const AGENT_SYNC_RESOURCE_DEFAULTS = Object.freeze({
  taskTimeoutMs: 900000,
  runTimeoutMs: 2700000,
  checkTimeoutMs: 120000,
  maxSessionRequests: 4096,
  maxEditsPerRequest: 32,
  maxTextBytes: 262144
});
export const AgentSyncResourcesSchema = z
  .object({
    taskTimeoutMs: positive.max(900000).default(900000),
    runTimeoutMs: positive.max(2700000).default(2700000),
    checkTimeoutMs: positive.max(120000).default(120000),
    maxSessionRequests: positive.max(10000).default(4096),
    maxEditsPerRequest: positive.max(128).default(32),
    maxTextBytes: positive.max(1048576).default(262144)
  })
  .strict()
  .superRefine((resources, ctx) => {
    if (resources.checkTimeoutMs > resources.taskTimeoutMs || resources.taskTimeoutMs > resources.runTimeoutMs)
      reject(ctx, "Incoherent check/task/run deadlines");
  });
export type AgentSyncResources = SyncReadonly<z.infer<typeof AgentSyncResourcesSchema>>;
const normalizedPaths = (paths: string[]) => [...new Set(paths)].sort();
const Scope = z
  .object({ read: z.array(Path), write: z.array(Path).min(1) })
  .strict()
  .transform(({ read, write }) => ({
    read: normalizedPaths(read.filter((path) => !write.includes(path))),
    write: normalizedPaths(write)
  }));
const ProjectObject = z
  .object({
    projectVersion: z.literal(AGENT_SYNC_PROJECT_VERSION),
    projectKey: Id,
    memberIds: z.array(Id).min(1).max(32),
    manifest: z
      .array(z.object({ path: Path, access: z.enum(["read-only", "writable"]), contentHash: Hash.nullable() }).strict())
      .min(1)
      .max(256),
    tasks: z
      .array(z.object({ taskId: Id, workerId: Id, scope: Scope, dependsOn: z.array(Id), checkProfileId: Id }).strict())
      .min(1)
      .max(128),
    profiles: z.array(z.object({ profileId: Id, checkIds: z.array(Id).min(1) }).strict()).min(1),
    finalProfileId: Id,
    checkConfigurationHash: Hash,
    resources: AgentSyncResourcesSchema.default({})
  })
  .strict();
type Definition = z.infer<typeof ProjectObject>;
function validateProject(project: Definition, ctx: z.RefinementCtx) {
  if (!unique(project.memberIds)) reject(ctx, "Duplicate members");
  if (!unique(project.tasks.map((task) => task.taskId))) reject(ctx, "Duplicate tasks");
  if (!unique(project.profiles.map((profile) => profile.profileId))) reject(ctx, "Duplicate profiles");
  const namespace = new Map<string, { spelling: string; kind: "file" | "directory" }>();
  for (const entry of project.manifest) {
    const segments = entry.path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const spelling = segments.slice(0, i).join("/");
      const kind = i === segments.length ? "file" : "directory";
      const previous = namespace.get(spelling.toLowerCase());
      if (previous && (previous.spelling !== spelling || previous.kind !== kind || kind === "file"))
        reject(ctx, "Manifest namespace collision or case alias");
      namespace.set(spelling.toLowerCase(), { spelling, kind });
    }
    if (entry.access === "read-only" && entry.contentHash === null) reject(ctx, "Read-only source must exist");
  }
  const files = new Map(project.manifest.map((entry) => [entry.path, entry]));
  const taskIds = new Set(project.tasks.map((task) => task.taskId));
  const profiles = new Set(project.profiles.map((profile) => profile.profileId));
  if (!profiles.has(project.finalProfileId)) reject(ctx, "Unknown final profile");
  for (const profile of project.profiles) if (!unique(profile.checkIds)) reject(ctx, "Duplicate profile checks");
  for (const task of project.tasks) {
    if (!project.memberIds.includes(task.workerId)) reject(ctx, "Unknown task worker");
    if (!profiles.has(task.checkProfileId)) reject(ctx, "Unknown task profile");
    if ([...task.scope.read, ...task.scope.write].some((path) => !files.has(path)))
      reject(ctx, "Unknown exact scope path");
    if (task.scope.write.some((path) => files.get(path)?.access !== "writable"))
      reject(ctx, "Write scope must be writable");
    if (!unique(task.dependsOn) || task.dependsOn.some((id) => !taskIds.has(id) || id === task.taskId))
      reject(ctx, "Invalid dependency");
  }
  const visited = new Set<string>();
  while (true) {
    const ready = project.tasks.filter(
      (task) => !visited.has(task.taskId) && task.dependsOn.every((id) => visited.has(id))
    );
    if (!ready.length) break;
    for (const task of ready) visited.add(task.taskId);
  }
  if (visited.size !== taskIds.size) reject(ctx, "Dependency cycle or missing prerequisite");
}
export const AgentSyncProjectSchema = ProjectObject.superRefine(validateProject);
export const FrozenAgentSyncProjectSchema = ProjectObject.extend({ planHash: Hash }).superRefine((project, ctx) => {
  validateProject(project, ctx);
  const { planHash, ...definition } = project;
  if (planHash !== hashJson(definition)) reject(ctx, "Frozen project hash mismatch");
});
export type AgentSyncProject = SyncReadonly<z.infer<typeof FrozenAgentSyncProjectSchema>>;
export function freezeAgentSyncProject(input: unknown): AgentSyncProject {
  const definition = AgentSyncProjectSchema.parse(input);
  return freezeSyncValue({ ...definition, planHash: hashJson(definition) });
}
export const AgentSyncLeaseSchema = z
  .object({
    leaseVersion: z.literal(AGENT_SYNC_LEASE_VERSION),
    projectKey: Id,
    runId: Id,
    planHash: Hash,
    attemptId: Id,
    taskId: Id,
    workerId: Id,
    ownerEpoch: positive,
    leaseEpoch: positive,
    token: z.string().min(1).max(512)
  })
  .strict();
export type AgentSyncLease = SyncReadonly<z.infer<typeof AgentSyncLeaseSchema>>;
const candidateFields = {
  candidateVersion: z.literal(AGENT_SYNC_CANDIDATE_VERSION),
  baseVersion: Version,
  version: Version,
  overlayHash: Hash,
  candidateHash: Hash
};
export const AgentSyncCandidateSchema = z.object({ ...candidateFields, attemptId: Id }).strict();
export type AgentSyncCandidate = SyncReadonly<z.infer<typeof AgentSyncCandidateSchema>>;
export const AgentSyncStagedFileSchema = z.object({ path: Path, blobId: Version, contentHash: Hash }).strict();
export type AgentSyncStagedFile = SyncReadonly<z.infer<typeof AgentSyncStagedFileSchema>>;
const Text = z
  .string()
  .max(1048576)
  .refine(
    (text) =>
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text) && !text.includes("\0"),
    "Text must be plain UTF-8 without NUL or unpaired surrogates"
  );
export const AgentSyncToolResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frozen"), baseVersion: Version, inputHash: Hash, contentHashes: ContentHashes }).strict(),
  z
    .object({
      kind: z.literal("inspected"),
      baseVersion: Version,
      path: Path,
      text: Text.nullable(),
      contentHash: Hash.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal("edited"),
      baseVersion: Version,
      overlayHash: Hash,
      files: z.array(AgentSyncStagedFileSchema)
    })
    .strict(),
  z.object({ kind: z.literal("sealed"), ...candidateFields }).strict()
]);
export type AgentSyncToolResult = SyncReadonly<z.infer<typeof AgentSyncToolResultSchema>>;
const requestBase = {
  requestVersion: z.literal(AGENT_SYNC_REQUEST_VERSION),
  requestId: Id,
  lease: AgentSyncLeaseSchema
};
export const AgentSyncWorkspaceRequestSchema = z
  .discriminatedUnion("operation", [
    z.object({ ...requestBase, operation: z.literal("freeze") }).strict(),
    z.object({ ...requestBase, operation: z.literal("inspect"), path: Path }).strict(),
    z
      .object({
        ...requestBase,
        operation: z.literal("edit"),
        edits: z.array(z.object({ path: Path, text: Text, expectedContentHash: Hash.nullable() }).strict()).min(1)
      })
      .strict(),
    z.object({ ...requestBase, operation: z.literal("seal") }).strict()
  ])
  .superRefine((request, ctx) => {
    if (request.operation === "edit" && !unique(request.edits.map((edit) => edit.path)))
      reject(ctx, "Duplicate edit paths");
  });
export type AgentSyncWorkspaceRequest = SyncReadonly<z.infer<typeof AgentSyncWorkspaceRequestSchema>>;
export const AgentSyncToolReceiptSchema = z
  .object({
    receiptVersion: z.literal(AGENT_SYNC_TOOL_RECEIPT_VERSION),
    requestId: Id,
    attemptId: Id,
    operation: z.enum(["freeze", "inspect", "edit", "seal"]),
    requestHash: Hash,
    request: AgentSyncWorkspaceRequestSchema,
    outputHash: Hash,
    result: AgentSyncToolResultSchema
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const kinds = { freeze: "frozen", inspect: "inspected", edit: "edited", seal: "sealed" };
    if (
      receipt.requestId !== receipt.request.requestId ||
      receipt.attemptId !== receipt.request.lease.attemptId ||
      receipt.operation !== receipt.request.operation ||
      receipt.result.kind !== kinds[receipt.operation] ||
      receipt.outputHash !== hashJson(receipt.result)
    )
      reject(ctx, "Tool request/receipt mismatch");
  });
export type AgentSyncToolReceipt = SyncReadonly<z.infer<typeof AgentSyncToolReceiptSchema>>;
export const AgentSyncWorkspaceSchema = z
  .object({
    workspaceVersion: z.literal(AGENT_SYNC_WORKSPACE_VERSION),
    staging: z.array(
      z
        .object({ attemptId: Id, baseVersion: Version, files: z.array(AgentSyncStagedFileSchema), overlayHash: Hash })
        .strict()
    ),
    candidates: z.array(AgentSyncCandidateSchema),
    toolReceipts: z.array(AgentSyncToolReceiptSchema)
  })
  .strict();
export type AgentSyncWorkspace = SyncReadonly<z.infer<typeof AgentSyncWorkspaceSchema>>;
const ImageDigest = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/);
const checkContext = {
  toolchainHash: Hash,
  isolationHash: Hash,
  configurationHash: Hash,
  programsHash: Hash,
  argumentsHash: Hash,
  planHash: Hash,
  imageDigest: ImageDigest
};
export const AgentSyncCheckReceiptSchema = z
  .object({
    checkVersion: z.literal(AGENT_SYNC_CHECK_VERSION),
    receiptId: Id,
    attemptId: Id,
    candidateHash: Hash,
    checksHash: Hash,
    groups: z.array(Id).min(1),
    ...checkContext,
    exitCode: z.number().int().safe(),
    passed: z.boolean(),
    baseVersion: Version,
    version: Version,
    sourceHashBefore: Hash,
    sourceHashAfter: Hash
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!unique(receipt.groups) || receipt.passed !== (receipt.exitCode === 0))
      reject(ctx, "Inconsistent host check result");
    if (receipt.passed && receipt.sourceHashBefore !== receipt.sourceHashAfter)
      reject(ctx, "Successful check changed immutable source");
  });
export type AgentSyncCheckReceipt = SyncReadonly<z.infer<typeof AgentSyncCheckReceiptSchema>>;
export const AgentSyncPublishReceiptSchema = z
  .object({
    publishVersion: z.literal(AGENT_SYNC_PUBLISH_VERSION),
    receiptId: Id,
    attemptId: Id,
    requestId: Id,
    checkReceiptId: Id,
    baseVersion: Version,
    acceptedVersion: Version,
    candidateHash: Hash,
    checksHash: Hash,
    requestHash: Hash,
    ownerEpoch: positive,
    leaseEpoch: positive,
    inputHash: Hash,
    overlayHash: Hash,
    ...checkContext
  })
  .strict();
export type AgentSyncPublishReceipt = SyncReadonly<z.infer<typeof AgentSyncPublishReceiptSchema>>;
export const AgentSyncWaitReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dependency"), taskIds: z.array(Id).min(1) }).strict(),
  z.object({ kind: z.literal("worker"), attemptIds: z.array(Id).min(1) }).strict(),
  z.object({ kind: z.literal("lock"), paths: z.array(Path).min(1), attemptIds: z.array(Id).min(1) }).strict(),
  z.object({ kind: z.literal("queue"), taskIds: z.array(Id).min(1) }).strict()
]);
export type AgentSyncWaitReason = SyncReadonly<z.infer<typeof AgentSyncWaitReasonSchema>>;
export const AgentSyncControlResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("granted"), lease: AgentSyncLeaseSchema }).strict(),
  z.object({ kind: z.literal("waiting"), taskId: Id, reasons: z.array(AgentSyncWaitReasonSchema).min(1) }).strict(),
  z.object({ kind: z.literal("released"), attemptId: Id }).strict(),
  z.object({ kind: z.literal("revoked"), attemptId: Id }).strict(),
  z.object({ kind: z.literal("cancelled"), taskId: Id }).strict(),
  z.object({ kind: z.literal("epoch_advanced"), ownerEpoch: positive }).strict(),
  z.object({ kind: z.literal("bound"), attemptId: Id }).strict()
]);
export type AgentSyncControlResult = SyncReadonly<z.infer<typeof AgentSyncControlResultSchema>>;
const controlBase = { requestVersion: z.literal(AGENT_SYNC_REQUEST_VERSION), requestId: Id };
export const AgentSyncControlRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({ ...controlBase, operation: z.literal("reserve"), ownerEpoch: positive, workerId: Id, taskId: Id })
    .strict(),
  z.object({ ...controlBase, operation: z.literal("cancel"), ownerEpoch: positive, workerId: Id, taskId: Id }).strict(),
  z.object({ ...controlBase, operation: z.literal("release"), lease: AgentSyncLeaseSchema }).strict(),
  z.object({ ...controlBase, operation: z.literal("revoke"), lease: AgentSyncLeaseSchema }).strict(),
  z.object({ ...controlBase, operation: z.literal("epoch"), ownerEpoch: positive }).strict(),
  z
    .object({
      ...controlBase,
      operation: z.literal("bind"),
      lease: AgentSyncLeaseSchema,
      snapshot: z.object({ baseVersion: Version, inputHash: Hash, contentHashes: ContentHashes }).strict()
    })
    .strict()
]);
export type AgentSyncControlRequest = SyncReadonly<z.infer<typeof AgentSyncControlRequestSchema>>;
const TaskStatus = z.enum([
  "pending",
  "waiting",
  "running",
  "checking",
  "publishing",
  "completed",
  "paused",
  "cancelled"
]);
export const AgentSyncCoordinationSchema = z
  .object({
    lastNow: nonnegative,
    nextSequence: nonnegative,
    taskEpochs: z.record(Id, nonnegative),
    taskStates: z.record(Id, TaskStatus),
    locks: z.array(
      z.object({ path: Path, mode: z.enum(["R", "W"]), taskId: Id, attemptId: Id, leaseEpoch: positive }).strict()
    ),
    requests: z.array(
      z
        .object({
          requestVersion: z.literal(AGENT_SYNC_REQUEST_VERSION),
          requestId: Id,
          payloadHash: Hash,
          operation: z.enum(["reserve", "release", "revoke", "epoch", "bind", "cancel"]),
          status: z.enum(["pending", "succeeded", "invalidated"]),
          attemptId: Id.nullable(),
          result: AgentSyncControlResultSchema.nullable()
        })
        .strict()
    )
  })
  .strict();
export type AgentSyncCoordination = SyncReadonly<z.infer<typeof AgentSyncCoordinationSchema>>;
export type AgentSyncCoordinationRequest = AgentSyncCoordination["requests"][number];
const Attempt = z
  .object({
    attemptId: Id,
    taskId: Id,
    workerId: Id,
    token: z.string().min(1).max(512),
    ownerEpoch: positive,
    leaseEpoch: positive,
    baseVersion: Version,
    inputHash: Hash.nullable(),
    contentHashes: ContentHashes,
    startedAt: nonnegative,
    deadlineAt: nonnegative,
    status: z.enum(["running", "checking", "publishing", "completed", "paused", "cancelled"])
  })
  .strict();
const StateObject = z
  .object({
    stateVersion: z.literal(AGENT_SYNC_STATE_VERSION),
    projectKey: Id,
    runId: Id,
    revision: nonnegative,
    ownerEpoch: positive,
    plan: FrozenAgentSyncProjectSchema,
    acceptedVersion: Version,
    status: z.enum(["active", "paused", "completed", "cancelled"]),
    startedAt: nonnegative,
    deadlineAt: nonnegative,
    acceptedTasks: z.array(Id),
    waiting: z.array(z.object({ taskId: Id, sequence: nonnegative }).strict()),
    attempts: z.array(Attempt),
    coordination: AgentSyncCoordinationSchema,
    workspace: AgentSyncWorkspaceSchema.optional(),
    checkReceipts: z.array(AgentSyncCheckReceiptSchema),
    publishReceipts: z.array(AgentSyncPublishReceiptSchema)
  })
  .strict();
type State = z.infer<typeof StateObject>;
/** Format and cross-reference validation only. Live authority/history belongs to the shared kernel. */
function validateState(state: State, ctx: z.RefinementCtx) {
  const fail = (message: string) => reject(ctx, message);
  const tasks = new Map(state.plan.tasks.map((task) => [task.taskId, task]));
  const attempts = new Map(state.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const exactTasks = (map: Record<string, unknown>) =>
    Object.keys(map).length === tasks.size && [...tasks.keys()].every((id) => Object.hasOwn(map, id));
  if (state.projectKey !== state.plan.projectKey) fail("Project/plan mismatch");
  if (!exactTasks(state.coordination.taskEpochs) || !exactTasks(state.coordination.taskStates))
    fail("Coordination maps must cover exact tasks");
  if (!unique(state.acceptedTasks) || state.acceptedTasks.some((id) => !tasks.has(id))) fail("Invalid accepted tasks");
  if (
    !unique(state.waiting.map((item) => item.taskId)) ||
    !unique(state.waiting.map((item) => item.sequence)) ||
    state.waiting.some((item) => !tasks.has(item.taskId))
  )
    fail("Invalid waiting references");
  if (!unique(state.attempts.map((item) => item.attemptId))) fail("Duplicate attempts");
  if (state.deadlineAt <= state.startedAt || state.deadlineAt - state.startedAt > state.plan.resources.runTimeoutMs)
    fail("Run deadline exceeds resources");
  for (const attempt of state.attempts) {
    const task = tasks.get(attempt.taskId);
    if (!task || task.workerId !== attempt.workerId || attempt.ownerEpoch > state.ownerEpoch) {
      fail("Invalid attempt identity");
      continue;
    }
    const paths = [...task.scope.read, ...task.scope.write];
    if (
      attempt.inputHash === null
        ? Object.keys(attempt.contentHashes).length !== 0
        : Object.keys(attempt.contentHashes).length !== paths.length ||
          paths.some((path) => !Object.hasOwn(attempt.contentHashes, path))
    )
      fail("Bound input must cover exact scope");
    if (
      attempt.startedAt < state.startedAt ||
      attempt.deadlineAt <= attempt.startedAt ||
      attempt.deadlineAt > state.deadlineAt ||
      attempt.deadlineAt - attempt.startedAt > state.plan.resources.taskTimeoutMs
    )
      fail("Attempt deadline exceeds resources");
  }
  const leaseMatches = (lease: z.infer<typeof AgentSyncLeaseSchema>) => {
    const attempt = attempts.get(lease.attemptId);
    return (
      lease.projectKey === state.projectKey &&
      lease.runId === state.runId &&
      lease.planHash === state.plan.planHash &&
      attempt &&
      lease.taskId === attempt.taskId &&
      lease.workerId === attempt.workerId &&
      lease.ownerEpoch === attempt.ownerEpoch &&
      lease.leaseEpoch === attempt.leaseEpoch &&
      lease.token === attempt.token
    );
  };
  for (const lock of state.coordination.locks) {
    const attempt = attempts.get(lock.attemptId);
    const task = attempt && tasks.get(attempt.taskId);
    if (
      !attempt ||
      !task ||
      lock.taskId !== attempt.taskId ||
      lock.leaseEpoch !== attempt.leaseEpoch ||
      !(lock.mode === "W" ? task.scope.write : task.scope.read).includes(lock.path)
    )
      fail("Invalid lock references");
  }
  if (!unique(state.coordination.requests.map((request) => request.requestId))) fail("Duplicate coordination requests");
  for (const request of state.coordination.requests) {
    if (request.attemptId !== null && !attempts.has(request.attemptId)) fail("Unknown coordination attempt");
    const result = request.result;
    if (!result) continue;
    if (result.kind === "granted" && !leaseMatches(result.lease)) fail("Invalid granted lease context");
    if ("attemptId" in result && !attempts.has(result.attemptId)) fail("Unknown control result attempt");
    if ("taskId" in result && !tasks.has(result.taskId)) fail("Unknown control result task");
    if (result.kind === "waiting")
      for (const reason of result.reasons) {
        if ("taskIds" in reason && reason.taskIds.some((id) => !tasks.has(id))) fail("Unknown wait task");
        if ("attemptIds" in reason && reason.attemptIds.some((id) => !attempts.has(id))) fail("Unknown wait attempt");
        if (
          reason.kind === "lock" &&
          reason.paths.some((path) => !state.plan.manifest.some((entry) => entry.path === path))
        )
          fail("Unknown wait path");
      }
  }
  const w = state.workspace;
  if (w) {
    if (
      !unique(w.staging.map((item) => item.attemptId)) ||
      !unique(w.candidates.map((item) => `${item.attemptId}:${item.version}`)) ||
      !unique(w.toolReceipts.map((item) => item.requestId))
    )
      fail("Duplicate workspace identity");
    for (const overlay of w.staging) {
      const attempt = attempts.get(overlay.attemptId);
      const task = attempt && tasks.get(attempt.taskId);
      if (
        !attempt ||
        !task ||
        overlay.baseVersion !== attempt.baseVersion ||
        !unique(overlay.files.map((file) => file.path)) ||
        overlay.files.some((file) => !task.scope.write.includes(file.path))
      )
        fail("Invalid staging attempt/scope");
    }
    for (const candidate of w.candidates)
      if (candidate.baseVersion !== attempts.get(candidate.attemptId)?.baseVersion)
        fail("Invalid candidate attempt/base");
    for (const receipt of w.toolReceipts) {
      const attempt = attempts.get(receipt.attemptId);
      const task = attempt && tasks.get(attempt.taskId);
      if (
        !attempt ||
        !task ||
        !leaseMatches(receipt.request.lease) ||
        receipt.result.baseVersion !== attempt.baseVersion
      ) {
        fail("Invalid tool receipt context");
        continue;
      }
      if (
        receipt.requestHash !==
        hashJson({
          projectKey: state.projectKey,
          runId: state.runId,
          planHash: state.plan.planHash,
          request: receipt.request
        })
      )
        fail("Tool receipt request hash mismatch");
      const request = receipt.request;
      const result = receipt.result;
      if (
        request.operation === "inspect" &&
        (![...task.scope.read, ...task.scope.write].includes(request.path) ||
          result.kind !== "inspected" ||
          result.path !== request.path)
      )
        fail("Inspect scope mismatch");
      if (
        request.operation === "edit" &&
        (request.edits.some((edit) => !task.scope.write.includes(edit.path)) ||
          result.kind !== "edited" ||
          request.edits.some(
            (edit) => !result.files.some((file) => file.path === edit.path && file.contentHash === sha256(edit.text))
          ))
      )
        fail("Edit request/result mismatch");
      if (
        result.kind === "frozen" &&
        (result.inputHash !== attempt.inputHash || hashJson(result.contentHashes) !== hashJson(attempt.contentHashes))
      )
        fail("Frozen input mismatch");
      if (
        result.kind === "inspected" &&
        ((result.text === null) !== (result.contentHash === null) ||
          (result.text !== null && sha256(result.text) !== result.contentHash))
      )
        fail("Inspected content mismatch");
      if (
        result.kind === "edited" &&
        (!unique(result.files.map((file) => file.path)) ||
          result.files.some((file) => !task.scope.write.includes(file.path)))
      )
        fail("Edited scope mismatch");
      if (
        result.kind === "sealed" &&
        !w.candidates.some(
          (candidate) =>
            candidate.attemptId === attempt.attemptId &&
            candidate.baseVersion === result.baseVersion &&
            candidate.version === result.version &&
            candidate.candidateHash === result.candidateHash &&
            candidate.overlayHash === result.overlayHash
        )
      )
        fail("Missing sealed candidate");
    }
  }
  for (const ids of [
    state.checkReceipts.map((receipt) => receipt.receiptId),
    state.publishReceipts.map((receipt) => receipt.receiptId),
    state.publishReceipts.map((receipt) => receipt.requestId)
  ])
    if (!unique(ids)) fail("Duplicate evidence identity");
  if (!unique([...state.checkReceipts, ...state.publishReceipts].map((receipt) => receipt.receiptId)))
    fail("Receipt identity reused across evidence kinds");
  const requestIds = [
    ...state.coordination.requests.map((request) => request.requestId),
    ...(w?.toolReceipts.map((receipt) => receipt.requestId) ?? []),
    ...state.publishReceipts.map((receipt) => receipt.requestId)
  ];
  if (!unique(requestIds)) fail("Request identity reused across operations");
  for (const receipt of state.checkReceipts) {
    const attempt = attempts.get(receipt.attemptId);
    // Formal checks describe the Publisher's combined candidate on its current
    // accepted base. Their publication receipt supplies the exact cross-binding;
    // ordinary checks still describe an attempt's private sealed candidate.
    const formal = state.publishReceipts.some((publication) => publication.checkReceiptId === receipt.receiptId);
    if (
      !attempt ||
      receipt.planHash !== state.plan.planHash ||
      receipt.configurationHash !== state.plan.checkConfigurationHash ||
      (!formal &&
        (receipt.baseVersion !== attempt.baseVersion ||
          !w?.candidates.some(
            (candidate) =>
              candidate.attemptId === receipt.attemptId &&
              candidate.candidateHash === receipt.candidateHash &&
              candidate.version === receipt.version &&
              candidate.baseVersion === receipt.baseVersion
          )))
    )
      fail("Check receipt context/candidate mismatch");
    const checkIds = new Set(state.plan.profiles.flatMap((profile) => profile.checkIds));
    if (receipt.groups.some((id) => !checkIds.has(id))) fail("Unknown check group");
  }
  for (const receipt of state.publishReceipts) {
    const check = state.checkReceipts.find((item) => item.receiptId === receipt.checkReceiptId);
    const attempt = attempts.get(receipt.attemptId);
    const staged = w?.staging.find((item) => item.attemptId === receipt.attemptId);
    // Publication consumes durable staging directly; sealing is optional. With
    // no staging, it consumes the canonical empty overlay on the attempt's base.
    const originalOverlayHash =
      attempt &&
      hashJson({
        attemptId: attempt.attemptId,
        baseVersion: attempt.baseVersion,
        files: staged?.files ?? []
      });
    if (
      !check?.passed ||
      !attempt ||
      receipt.overlayHash !== originalOverlayHash ||
      (staged !== undefined && staged.overlayHash !== originalOverlayHash) ||
      check.attemptId !== receipt.attemptId ||
      check.candidateHash !== receipt.candidateHash ||
      check.checksHash !== receipt.checksHash ||
      check.baseVersion !== receipt.baseVersion ||
      check.version !== receipt.acceptedVersion ||
      receipt.planHash !== state.plan.planHash ||
      receipt.ownerEpoch !== attempt.ownerEpoch ||
      receipt.leaseEpoch !== attempt.leaseEpoch ||
      receipt.inputHash !== attempt.inputHash
    ) {
      fail("Publish evidence reference mismatch");
      continue;
    }
    for (const key of [
      "toolchainHash",
      "isolationHash",
      "configurationHash",
      "programsHash",
      "argumentsHash",
      "planHash",
      "imageDigest"
    ] as const)
      if (receipt[key] !== check[key]) fail("Publication/check configuration mismatch");
  }
}
export const AgentSyncStateSchema = StateObject.superRefine(validateState);
export type AgentSyncState = SyncReadonly<z.infer<typeof AgentSyncStateSchema>>;
export type AgentSyncAttempt = AgentSyncState["attempts"][number];
