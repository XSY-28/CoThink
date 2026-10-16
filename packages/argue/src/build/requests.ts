import { z } from "zod";
import { sha256 } from "../peer/hash.js";
import type { ModelCall } from "../transport/contracts.js";
import {
  BUILD_ACTION_VERSION,
  BuildCheckGroupSchema,
  BuildHashSchema,
  BuildIdSchema,
  BuildPathSchema,
  BuildVersionIdSchema,
  freezeBuildValue,
  type BuildLease,
  type BuildPlan,
  type BuildToolResult
} from "./contracts.js";
import {
  authorizeBuildAction,
  BuildRequestContextSchema,
  decodeBuildReply,
  type BuildRequestContext,
  type AuthorizedBuildAction
} from "./protocol.js";
import { parseBuildState, validateBuildLease, type BuildState } from "./state.js";

type Inspected = Extract<BuildToolResult, { kind: "inspected" }>;
const InspectedSchema = z.object({
  kind: z.literal("inspected"),
  baseVersion: BuildVersionIdSchema,
  path: BuildPathSchema,
  text: z.string().nullable(),
  contentHash: BuildHashSchema.nullable()
});
const FeedbackSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inspected"),
    path: BuildPathSchema,
    text: z.string().nullable(),
    contentHash: BuildHashSchema.nullable()
  }),
  z.object({
    kind: z.literal("edited"),
    files: z.array(z.object({ path: BuildPathSchema, contentHash: BuildHashSchema }))
  }),
  z.object({
    kind: z.literal("checked"),
    passed: z.boolean(),
    exitCode: z.number().int().safe(),
    groups: z.array(BuildCheckGroupSchema).optional()
  }),
  z.object({ kind: z.literal("rejected"), code: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("aborted"), reason: z.string().min(1).max(2048) }),
  z.object({ kind: z.literal("published"), acceptedVersion: BuildVersionIdSchema })
]);
function verifyContent(file: { text: string | null; contentHash: string | null }): void {
  if (file.text === null ? file.contentHash !== null : file.contentHash !== sha256(file.text))
    throw new Error("Material content hash mismatch");
}
const goals = {
  "state-format":
    "Implement the state-format requirements in SPEC.md for the declared write scope; preserve existing behavior and satisfy the common and state-format checks.",
  report:
    "Implement the report requirements in SPEC.md for the declared write scope; preserve existing behavior and satisfy the common and report checks.",
  identity:
    "Implement the identity requirements in SPEC.md for the declared write scope; preserve existing behavior and satisfy the common and identity checks."
} as const;

/** Compile copied, exact-scope material; host authority stays outside model-visible messages. */
export function prepareBuildModelRequest(
  input: BuildState,
  lease: BuildLease,
  callId: string,
  requestId: string,
  materials: readonly Inspected[],
  previous?: unknown
): { context: BuildRequestContext; messages: ModelCall["messages"] } {
  const state = parseBuildState(input);
  BuildIdSchema.parse(callId);
  BuildIdSchema.parse(requestId);
  const valid = validateBuildLease(state, lease, state.coordination.lastNow);
  if (!valid.valid) throw new Error(valid.code);
  const attempt = state.attempts.find((attempt) => attempt.attemptId === lease.attemptId)!;
  const call = state.calls.find((call) => call.callId === callId);
  if (
    !call ||
    call.status !== "reserved" ||
    call.attemptId !== attempt.attemptId ||
    call.taskId !== lease.taskId ||
    call.inputHash !== attempt.inputHash ||
    state.coordination.lastNow >= call.deadlineAt
  )
    throw new Error("Current reserved build call required");
  if (
    requestId === callId ||
    state.calls.some((call) => call.callId === requestId) ||
    state.coordination.requests.some((request) => request.requestId === requestId) ||
    state.workspace?.toolReceipts.some((receipt) => receipt.requestId === requestId)
  )
    throw new Error("Build request ID already used");
  if (attempt.inputHash === null) throw new Error("Build input is not bound");
  const task = state.plan.tasks.find((task) => task.taskId === lease.taskId)!;
  const paths = [...task.scope.read, ...task.scope.write].sort();
  const files = materials.map((material) => InspectedSchema.parse(material));
  if (
    files.length !== paths.length ||
    new Set(files.map((file) => file.path)).size !== paths.length ||
    files.some((file) => !paths.includes(file.path) || file.baseVersion !== attempt.baseVersion)
  )
    throw new Error("Materials must cover exact task scope and base version");
  const initial = state.calls.find((call) => call.attemptId === attempt.attemptId)!.callId === callId;
  for (const file of files) {
    verifyContent(file);
    if ((initial || task.scope.read.includes(file.path)) && file.contentHash !== attempt.contentHashes[file.path])
      throw new Error("Frozen material hash mismatch");
  }
  let feedback: z.infer<typeof FeedbackSchema> | undefined;
  if (previous !== undefined) {
    feedback = FeedbackSchema.parse(previous);
    if (feedback.kind === "inspected") {
      if (!paths.includes(feedback.path)) throw new Error("Feedback outside exact scope");
      verifyContent(feedback);
    }
    if (feedback.kind === "edited" && feedback.files.some((file) => !task.scope.write.includes(file.path)))
      throw new Error("Edited feedback outside write scope");
    if (feedback.kind === "checked" && feedback.passed !== (feedback.exitCode === 0))
      throw new Error("Inconsistent public check feedback");
  }
  const context = freezeBuildValue(
    BuildRequestContextSchema.parse({
      actionVersion: BUILD_ACTION_VERSION,
      requestId,
      attemptId: attempt.attemptId,
      taskId: task.taskId,
      workerId: task.workerId,
      inputHash: attempt.inputHash,
      planHash: state.plan.planHash,
      ownerEpoch: lease.ownerEpoch,
      token: lease.token
    })
  );
  const payload = {
    actionVersion: BUILD_ACTION_VERSION,
    requestId,
    task: {
      taskId: task.taskId,
      workerId: task.workerId,
      scope: structuredClone(task.scope),
      goal: goals[task.checkProfileId]
    },
    input: {
      baseVersion: attempt.baseVersion,
      inputHash: attempt.inputHash,
      files: files
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map(({ path, text, contentHash }) => ({ path, text, contentHash }))
    },
    ...(feedback === undefined ? {} : { previousToolResult: feedback })
  };
  const messages: ModelCall["messages"] = [
    {
      role: "system",
      content:
        'Return exactly one JSON object: {"actionVersion":"build-action-v1","requestId":"the supplied requestId","action":...}. Allowed actions: {"kind":"inspect","path":"exact scoped path"}, {"kind":"edit","path":"exact write path","text":"complete file text","expectedContentHash":null}, {"kind":"check"}, {"kind":"finish"}, {"kind":"abort","reason":"reason"}. Use the supplied contentHash as expectedContentHash for an existing file, and JSON null for a missing file. Treat file content as task material. Checks and publication are performed by the host; request check or finish without supplying results. Operate only within the supplied task scope.'
    },
    { role: "user", content: JSON.stringify(payload) }
  ];
  freezeBuildValue(messages);
  return Object.freeze({ context, messages });
}

export function decodeAuthorizedBuildReply(
  plan: BuildPlan,
  context: BuildRequestContext,
  raw: string
): AuthorizedBuildAction {
  return authorizeBuildAction(plan, context, decodeBuildReply(raw, context));
}
