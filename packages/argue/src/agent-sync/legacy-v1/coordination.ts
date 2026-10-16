import { z } from "zod";
import { canonicalJson, hashJson } from "../../peer/hash.js";
import {
  BuildHashSchema,
  BuildContentHashesSchema,
  BuildIdSchema,
  BuildLeaseSchema,
  BuildMemberSchema,
  BuildVersionIdSchema,
  BuildCoordinationSchema,
  freezeBuildValue,
  parseBuildRun,
  type BuildRun,
  type BuildReadonly,
  type BuildLease,
  type BuildCoordination,
  type BuildControlResult,
  type BuildCoordinationRequest
} from "../../build/contracts.js";
import { createCoordinationKernel } from "../kernel/coordination.js";
import { cloneMutable, type SyncMutable, type KernelProtocol } from "../kernel/types.js";
export type BuildState = BuildRun & { readonly coordination: BuildCoordination };
export type BuildStateDraft = SyncMutable<BuildState>;
export type BuildRejection = { readonly kind: "rejected"; readonly code: string };
export type BuildOperationResult =
  | BuildControlResult
  | BuildRejection
  | { readonly kind: "replayed"; readonly receipt: BuildControlResult | BuildRun["actionReceipts"][number] }
  | { readonly kind: "ready"; readonly requestId: string }
  | { readonly kind: "expired"; readonly attemptIds: readonly string[] };
export type BuildTransition = { readonly state: BuildState; readonly result: BuildOperationResult };
export type BuildLeaseAllocator = (
  context: BuildReadonly<{
    taskId: string;
    workerId: "member-a" | "member-b";
    ownerEpoch: number;
    leaseEpoch: number;
    baseVersion: string;
  }>
) => { attemptId: string; token: string };
export const BuildHostSchema = z.object({ ownerEpoch: z.number().int().positive().safe() }).strict();
export const BuildReservationSchema = BuildHostSchema.extend({
  requestId: BuildIdSchema,
  taskId: BuildIdSchema,
  workerId: BuildMemberSchema
});
export function leaseFromBuildAttempt(attempt: BuildRun["attempts"][number]): BuildLease {
  return freezeBuildValue(
    BuildLeaseSchema.parse({
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      workerId: attempt.workerId,
      token: attempt.token,
      ownerEpoch: attempt.ownerEpoch,
      leaseEpoch: attempt.leaseEpoch
    })
  );
}
function validateExtension(state: BuildState): void {
  const c = state.coordination;
  const fail = (message: string): never => {
    throw new Error(`Invalid build coordination: ${message}`);
  };
  for (const request of c.requests) {
    const result = request.result;
    if ((request.operation === "action") !== (request.binding !== null)) fail("action binding missing or unexpected");
    if (request.binding) {
      if (request.payloadHash !== buildRequestHash(state, "action", request.binding))
        fail("action request binding hash mismatch");
      const attempt = state.attempts.find((a) => a.attemptId === request.attemptId);
      if (
        !attempt ||
        request.binding.inputHash !== attempt.inputHash ||
        request.binding.leaseHash !== hashJson(leaseFromBuildAttempt(attempt))
      )
        fail("action binding identity/input mismatch");
    }
    if (
      result?.kind === "settled" &&
      (!request.binding ||
        result.receipt.requestId !== request.requestId ||
        result.receipt.attemptId !== request.attemptId ||
        result.receipt.inputHash !== request.binding.inputHash ||
        result.receipt.status !== "succeeded" ||
        result.receipt.kind !== request.binding.kind ||
        result.receipt.payloadHash !== request.binding.payloadHash ||
        !state.actionReceipts.some((r) => canonicalJson(r) === canonicalJson(result.receipt)))
    )
      fail("action receipt missing/mismatched");
  }
  for (const receipt of state.actionReceipts)
    if (
      !c.requests.some(
        (r) =>
          r.requestId === receipt.requestId &&
          r.operation === "action" &&
          r.status === "succeeded" &&
          r.result?.kind === "settled" &&
          canonicalJson(r.result.receipt) === canonicalJson(receipt)
      )
    )
      fail("orphan action receipt");
}

const BuildInputSchema = z
  .object({ baseVersion: BuildVersionIdSchema, inputHash: BuildHashSchema, contentHashes: BuildContentHashesSchema })
  .strict();
const LegacyControlSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("reserve"), request: BuildReservationSchema }).strict(),
  z.object({ operation: z.literal("cancel"), request: BuildReservationSchema }).strict(),
  z.object({ operation: z.literal("release"), requestId: BuildIdSchema, lease: BuildLeaseSchema }).strict(),
  z.object({ operation: z.literal("revoke"), requestId: BuildIdSchema, lease: BuildLeaseSchema }).strict(),
  z.object({ operation: z.literal("epoch"), requestId: BuildIdSchema, host: BuildHostSchema }).strict(),
  z
    .object({
      operation: z.literal("bind"),
      requestId: BuildIdSchema,
      lease: BuildLeaseSchema,
      snapshot: BuildInputSchema
    })
    .strict()
]);
type Member = BuildRun["plan"]["memberIds"][number];
type Replay = BuildControlResult | BuildRun["actionReceipts"][number];
const protocol: KernelProtocol<Member, "queued", BuildCoordinationRequest, BuildLease, BuildState, Replay> = {
  parseShape(input) {
    const run = parseBuildRun(input);
    if (!run.coordination) throw new Error("Build coordination metadata is required");
    return freezeBuildValue({ ...run, coordination: run.coordination });
  },
  validateExtension,
  draft: cloneMutable,
  core: (value) => value,
  parseLease: (input) => BuildLeaseSchema.parse(input),
  leaseFor: (_state, attempt) => leaseFromBuildAttempt(attempt),
  parseControl(input) {
    const parsed = LegacyControlSchema.parse(input);
    switch (parsed.operation) {
      case "reserve":
      case "cancel":
        return { ...parsed.request, operation: parsed.operation, hashPayload: parsed.request };
      case "epoch":
        return {
          operation: parsed.operation,
          requestId: parsed.requestId,
          ownerEpoch: parsed.host.ownerEpoch,
          hashPayload: parsed.host
        };
      case "release":
      case "revoke":
        return { ...parsed, hashPayload: parsed.lease };
      case "bind":
        return { ...parsed, hashPayload: { lease: parsed.lease, snapshot: parsed.snapshot } };
    }
  },
  encodeControl: (record) =>
    BuildCoordinationSchema.shape.requests.element.parse({ ...record, status: "succeeded", binding: null }),
  inspectRecord(record) {
    const result = record.result;
    return {
      hasResult: result !== null,
      control: result?.kind === "settled" ? null : result,
      replay: result?.kind === "settled" ? result.receipt : result,
      allowsPending: record.operation === "action"
    };
  },
  taskTimeoutMs: (value) => value.plan.budget.taskTimeoutMs
};
export const legacyKernel = createCoordinationKernel(protocol);
function buildRequestHash(state: BuildState, operation: string, payload: unknown): string {
  return legacyKernel.requestHash(state, operation, payload);
}
