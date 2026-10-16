import {
  AgentSyncLeaseSchema,
  AgentSyncWorkspaceRequestSchema,
  AgentSyncToolResultSchema,
  AgentSyncCheckReceiptSchema,
  AgentSyncPublishReceiptSchema,
  AgentSyncVerifierRequestSchema,
  parseAgentSyncState,
  validateAgentSyncLease,
  expireAgentSyncState,
  bindAgentSyncInput,
  SyncIdSchema,
  agentSyncPublishRequestHash,
  agentSyncPublicationChecks,
  validateAgentSyncVerifierPortResult,
  validateAgentSyncPublisherPortResult,
  AgentSyncError,
  editLimitViolation,
  AGENT_SYNC_REQUEST_VERSION,
  AGENT_SYNC_WORKSPACE_VERSION,
  AGENT_SYNC_TOOL_RECEIPT_VERSION,
  AGENT_SYNC_CANDIDATE_VERSION,
  AGENT_SYNC_PUBLISH_VERSION,
  type AgentSyncProject,
  type AgentSyncState,
  type AgentSyncLease,
  type AgentSyncToolResult,
  type AgentSyncCheckReceipt,
  type AgentSyncPublishReceipt
} from "@onevcat/argue/agent-sync/project";
import type { BackendProtocol } from "../kernel/backend-types.js";
import { freeze } from "../kernel/backend-types.js";
export const protocol = freeze<
  BackendProtocol<
    AgentSyncProject,
    AgentSyncLease,
    AgentSyncCheckReceipt,
    AgentSyncPublishReceipt,
    AgentSyncToolResult,
    AgentSyncState,
    string
  >
>({
  workspaceVersion: AGENT_SYNC_WORKSPACE_VERSION,
  toolMetadata: { receiptVersion: AGENT_SYNC_TOOL_RECEIPT_VERSION },
  candidateMetadata: { candidateVersion: AGENT_SYNC_CANDIDATE_VERSION },
  publishVersion: AGENT_SYNC_PUBLISH_VERSION,
  evidenceKeys: [
    "toolchainHash",
    "isolationHash",
    "imageDigest",
    "configurationHash",
    "programsHash",
    "argumentsHash"
  ] as const,
  allowLegacyChecks: false,
  parseState: parseAgentSyncState,
  parseLease: (raw) => AgentSyncLeaseSchema.parse(raw),
  parseId: (raw) => SyncIdSchema.parse(raw),
  workspace: (raw) => {
    const code = editLimitViolation(raw, { maxEditsPerRequest: 128, maxTextBytes: 1048576 });
    if (code) throw new AgentSyncError(code);
    return AgentSyncWorkspaceRequestSchema.parse({ requestVersion: AGENT_SYNC_REQUEST_VERSION, ...raw });
  },
  tool: (raw) =>
    AgentSyncToolResultSchema.parse(
      typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "sealed"
        ? { candidateVersion: AGENT_SYNC_CANDIDATE_VERSION, ...raw }
        : raw
    ),
  parseCheck: (raw) => AgentSyncCheckReceiptSchema.parse(raw),
  parsePublish: (raw) => AgentSyncPublishReceiptSchema.parse(raw),
  validateLease: validateAgentSyncLease,
  expire: (state, now) => expireAgentSyncState(state, { ownerEpoch: state.ownerEpoch }, now).state,
  bind: (state, lease, requestId, input, now) =>
    bindAgentSyncInput(
      state,
      { requestVersion: AGENT_SYNC_REQUEST_VERSION, operation: "bind", lease, requestId, snapshot: input },
      now
    ),
  groups: agentSyncPublicationChecks,
  publishHash: agentSyncPublishRequestHash,
  extraRequestIds: () => [],
  validateResources: (state, request) => {
    const code = editLimitViolation(request, state.plan.resources);
    if (code) throw new AgentSyncError(code);
  },
  configurationHash: (state) => state.plan.checkConfigurationHash,
  verifierRequest: (raw) => AgentSyncVerifierRequestSchema.parse(raw),
  validateVerifier: (state, request, response) =>
    validateAgentSyncVerifierPortResult(state, AgentSyncVerifierRequestSchema.parse(request), response),
  validatePublisher: validateAgentSyncPublisherPortResult
});
