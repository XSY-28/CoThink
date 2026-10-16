import { SharedAgentSyncService } from "../kernel/service.js";
import type {
  ServiceOptions,
  ServiceProtocol,
  ServiceStatus,
  ServiceRecovery,
  WorkerClient
} from "../kernel/service-types.js";
import {
  BuildIdSchema,
  BuildHashSchema,
  BuildMemberSchema,
  BuildLeaseSchema,
  BuildWorkspaceRequestSchema,
  type BuildLease,
  type BuildToolResult,
  type BuildWorkspaceRequest
} from "../../build/contracts.js";
import { legacyKernel, type BuildState, type BuildOperationResult } from "./coordination.js";
import { recoverBuildCalls } from "../../build/budget.js";
import {
  BuildVerifierRequestSchema,
  legacyPortValidators,
  buildPublishRequestHash,
  type BuildVerifierRequest,
  type BuildVerifierResponse,
  type BuildPublisherResponse
} from "./ports.js";
export { AgentSyncError } from "../kernel/service.js";
export type {
  AgentSyncDiff,
  AgentSyncDiffOptions,
  AgentSyncExportOptions,
  AgentSyncExportResult,
  AgentSyncHostOperations
} from "../kernel/service-types.js";
type Member = BuildLease["workerId"];
export type AgentSyncServiceOptions = ServiceOptions<
  Member,
  BuildState,
  BuildLease,
  BuildToolResult,
  BuildVerifierRequest,
  BuildVerifierResponse,
  BuildPublisherResponse
>;
export type AgentSyncStatus = ServiceStatus<BuildState, "agent-sync-service-v1">;
export type AgentSyncRecovery = ServiceRecovery<BuildState, "agent-sync-service-v1">;
export type AgentSyncWorkerClient = WorkerClient<
  BuildLease,
  BuildToolResult,
  BuildOperationResult,
  BuildVerifierResponse,
  BuildPublisherResponse
>;
const protocol: ServiceProtocol<
  Member,
  BuildState,
  BuildLease,
  BuildWorkspaceRequest,
  BuildToolResult,
  BuildVerifierRequest,
  BuildVerifierResponse,
  BuildPublisherResponse,
  BuildOperationResult,
  "agent-sync-service-v1"
> = {
  serviceVersion: "agent-sync-service-v1",
  id: BuildIdSchema,
  hash: BuildHashSchema,
  member: BuildMemberSchema,
  lease: BuildLeaseSchema,
  parse: legacyKernel.parse,
  workspace: (request) => BuildWorkspaceRequestSchema.parse(request),
  verifier: (request) => BuildVerifierRequestSchema.parse(request),
  publisher: (lease, requestId) => {
    BuildLeaseSchema.parse(lease);
    BuildIdSchema.parse(requestId);
  },
  leaseFor: (_state, attempt) =>
    BuildLeaseSchema.parse({
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      workerId: attempt.workerId,
      token: attempt.token,
      ownerEpoch: attempt.ownerEpoch,
      leaseEpoch: attempt.leaseEpoch
    }),
  validateNow: legacyKernel.validateNow,
  validateLease: legacyKernel.validateLease,
  reserve: (state, workerId, taskId, requestId, now, allocate) =>
    legacyKernel.reserve(
      state,
      { operation: "reserve", request: { workerId, taskId, requestId, ownerEpoch: state.ownerEpoch } },
      now,
      allocate
    ),
  cancel: (state, workerId, taskId, requestId, now) =>
    legacyKernel.cancel(
      state,
      { operation: "cancel", request: { workerId, taskId, requestId, ownerEpoch: state.ownerEpoch } },
      now
    ),
  release: (state, lease, requestId, now) =>
    legacyKernel.release(state, { operation: "release", lease, requestId }, now),
  advanceOwner: (state, requestId, now) =>
    legacyKernel.advanceOwner(state, { operation: "epoch", requestId, host: { ownerEpoch: state.ownerEpoch } }, now),
  epochHash: (state, _id, ownerEpoch) => legacyKernel.requestHash(state, "epoch", { ownerEpoch }),
  publishHash: buildPublishRequestHash,
  validateWorkspace: legacyPortValidators.workspace,
  validateVerifier: legacyPortValidators.verifier,
  validatePublisher: legacyPortValidators.publisher,
  rejected: (code) => ({ kind: "rejected", code }),
  extraRequestIds: (state) => state.calls.map((call) => call.callId),
  recoverExtension: recoverBuildCalls
};
/** Explicit legacy format adapter; the authority algorithm lives only in the kernel. */
export class AgentSyncService extends SharedAgentSyncService<
  Member,
  BuildState,
  BuildLease,
  BuildWorkspaceRequest,
  BuildToolResult,
  BuildVerifierRequest,
  BuildVerifierResponse,
  BuildPublisherResponse,
  BuildOperationResult,
  "agent-sync-service-v1"
> {
  constructor(options: AgentSyncServiceOptions) {
    super(options, protocol);
  }
}
