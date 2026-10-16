import { SharedAgentSyncService } from "../kernel/service.js";
import type {
  ServiceOptions,
  ServiceProtocol,
  ServiceStatus,
  ServiceRecovery,
  WorkerClient
} from "../kernel/service-types.js";
import { SyncIdSchema, SyncHashSchema } from "../kernel/primitives.js";
import { projectKernel, type AgentSyncOperationResult } from "./state.js";
import {
  AGENT_SYNC_REQUEST_VERSION,
  AgentSyncLeaseSchema,
  AgentSyncWorkspaceRequestSchema,
  AgentSyncControlRequestSchema,
  type AgentSyncLease,
  type AgentSyncState,
  type AgentSyncToolResult,
  type AgentSyncWorkspaceRequest
} from "./contracts.js";
import {
  AgentSyncVerifierRequestSchema,
  AgentSyncPublisherRequestSchema,
  agentSyncPublishRequestHash,
  validateAgentSyncWorkspacePortResult,
  validateAgentSyncVerifierPortResult,
  validateAgentSyncPublisherPortResult,
  type AgentSyncVerifierRequest,
  type AgentSyncVerifierResponse,
  type AgentSyncPublisherResponse
} from "./ports.js";
export { AgentSyncError } from "../kernel/service.js";
export type {
  AgentSyncDiff,
  AgentSyncDiffOptions,
  AgentSyncExportOptions,
  AgentSyncExportResult,
  AgentSyncHostOperations
} from "../kernel/service-types.js";
export type AgentSyncServiceOptions = ServiceOptions<
  string,
  AgentSyncState,
  AgentSyncLease,
  AgentSyncToolResult,
  AgentSyncVerifierRequest,
  AgentSyncVerifierResponse,
  AgentSyncPublisherResponse
>;
export type AgentSyncStatus = ServiceStatus<AgentSyncState, "agent-sync-project-service-v1">;
export type AgentSyncRecovery = ServiceRecovery<AgentSyncState, "agent-sync-project-service-v1">;
export type AgentSyncWorkerClient = WorkerClient<
  AgentSyncLease,
  AgentSyncToolResult,
  AgentSyncOperationResult,
  AgentSyncVerifierResponse,
  AgentSyncPublisherResponse
>;
const protocol: ServiceProtocol<
  string,
  AgentSyncState,
  AgentSyncLease,
  AgentSyncWorkspaceRequest,
  AgentSyncToolResult,
  AgentSyncVerifierRequest,
  AgentSyncVerifierResponse,
  AgentSyncPublisherResponse,
  AgentSyncOperationResult,
  "agent-sync-project-service-v1"
> = {
  serviceVersion: "agent-sync-project-service-v1",
  id: SyncIdSchema,
  hash: SyncHashSchema,
  member: SyncIdSchema,
  lease: AgentSyncLeaseSchema,
  parse: projectKernel.parse,
  workspace: (request) =>
    AgentSyncWorkspaceRequestSchema.parse({ requestVersion: AGENT_SYNC_REQUEST_VERSION, ...request }),
  verifier: (request) =>
    AgentSyncVerifierRequestSchema.parse({ requestVersion: AGENT_SYNC_REQUEST_VERSION, ...request }),
  publisher: (lease, requestId) => {
    AgentSyncPublisherRequestSchema.parse({
      requestVersion: AGENT_SYNC_REQUEST_VERSION,
      operation: "publish",
      lease,
      requestId
    });
  },
  leaseFor: projectKernel.leaseFor,
  validateNow: projectKernel.validateNow,
  validateLease: projectKernel.validateLease,
  reserve: (state, workerId, taskId, requestId, now, allocate) =>
    projectKernel.reserve(
      state,
      AgentSyncControlRequestSchema.parse({
        requestVersion: AGENT_SYNC_REQUEST_VERSION,
        operation: "reserve",
        workerId,
        taskId,
        requestId,
        ownerEpoch: state.ownerEpoch
      }),
      now,
      allocate
    ),
  cancel: (state, workerId, taskId, requestId, now) =>
    projectKernel.cancel(
      state,
      AgentSyncControlRequestSchema.parse({
        requestVersion: AGENT_SYNC_REQUEST_VERSION,
        operation: "cancel",
        workerId,
        taskId,
        requestId,
        ownerEpoch: state.ownerEpoch
      }),
      now
    ),
  release: (state, lease, requestId, now) =>
    projectKernel.release(
      state,
      AgentSyncControlRequestSchema.parse({
        requestVersion: AGENT_SYNC_REQUEST_VERSION,
        operation: "release",
        lease,
        requestId
      }),
      now
    ),
  advanceOwner: (state, requestId, now) =>
    projectKernel.advanceOwner(
      state,
      AgentSyncControlRequestSchema.parse({
        requestVersion: AGENT_SYNC_REQUEST_VERSION,
        operation: "epoch",
        requestId,
        ownerEpoch: state.ownerEpoch
      }),
      now
    ),
  epochHash: (state, requestId, ownerEpoch) =>
    projectKernel.requestHash(
      state,
      "epoch",
      AgentSyncControlRequestSchema.parse({
        requestVersion: AGENT_SYNC_REQUEST_VERSION,
        operation: "epoch",
        requestId,
        ownerEpoch
      })
    ),
  publishHash: agentSyncPublishRequestHash,
  validateWorkspace: validateAgentSyncWorkspacePortResult,
  validateVerifier: validateAgentSyncVerifierPortResult,
  validatePublisher: validateAgentSyncPublisherPortResult,
  rejected: (code) => ({ kind: "rejected", code }),
  resources: (state) => state.plan.resources
};
/** The worker factory validates ID syntax immediately. Declared membership is checked
 * against the authoritative frozen project at the first operation, after async open.
 * Session limits do not reset on recover: exhausted sessions allow status/close and
 * readonly queries; new IDs (including recovery) require an explicit new session. */
export class AgentSyncService extends SharedAgentSyncService<
  string,
  AgentSyncState,
  AgentSyncLease,
  AgentSyncWorkspaceRequest,
  AgentSyncToolResult,
  AgentSyncVerifierRequest,
  AgentSyncVerifierResponse,
  AgentSyncPublisherResponse,
  AgentSyncOperationResult,
  "agent-sync-project-service-v1"
> {
  constructor(options: AgentSyncServiceOptions) {
    super(options, protocol);
  }
}
