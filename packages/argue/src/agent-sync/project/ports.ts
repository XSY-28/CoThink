import { z } from "zod";
import { hashJson } from "../../peer/hash.js";
import { SyncIdSchema, freezeSyncValue, type SyncReadonly } from "../kernel/primitives.js";
import type { StateWriter } from "../kernel/types.js";
import { createPortResultValidators } from "../kernel/ports.js";
import { projectKernel, projectCheckSelection } from "./state.js";
import {
  AGENT_SYNC_REQUEST_VERSION,
  AgentSyncLeaseSchema,
  AgentSyncWorkspaceRequestSchema,
  AgentSyncToolResultSchema,
  AgentSyncCheckReceiptSchema,
  AgentSyncPublishReceiptSchema,
  type AgentSyncState,
  type AgentSyncLease,
  type AgentSyncWorkspaceRequest,
  type AgentSyncToolResult,
  type AgentSyncCheckReceipt,
  type AgentSyncPublishReceipt
} from "./contracts.js";
type Result<K extends AgentSyncToolResult["kind"]> = Extract<AgentSyncToolResult, { kind: K }>;
export interface AgentSyncWorkspacePort {
  freezeInput(lease: AgentSyncLease, requestId: string): Promise<Result<"frozen">>;
  inspect(lease: AgentSyncLease, requestId: string, path: string): Promise<Result<"inspected">>;
  edit(
    lease: AgentSyncLease,
    requestId: string,
    edits: readonly { path: string; text: string; expectedContentHash: string | null }[]
  ): Promise<Result<"edited">>;
  seal(lease: AgentSyncLease, requestId: string): Promise<Result<"sealed">>;
}
export const AgentSyncVerifierRequestSchema = z
  .object({
    requestVersion: z.literal(AGENT_SYNC_REQUEST_VERSION),
    requestId: SyncIdSchema,
    lease: AgentSyncLeaseSchema,
    candidate: AgentSyncToolResultSchema.options[3]
  })
  .strict();
export type AgentSyncVerifierRequest = SyncReadonly<z.infer<typeof AgentSyncVerifierRequestSchema>>;
export interface AgentSyncVerifierResponse {
  readonly requestId: string;
  readonly receipt: AgentSyncCheckReceipt;
}
export interface AgentSyncVerifierPort {
  check(request: AgentSyncVerifierRequest): Promise<AgentSyncVerifierResponse>;
}
export const AgentSyncPublisherRequestSchema = z
  .object({
    requestVersion: z.literal(AGENT_SYNC_REQUEST_VERSION),
    operation: z.literal("publish"),
    requestId: SyncIdSchema,
    lease: AgentSyncLeaseSchema
  })
  .strict();
export type AgentSyncPublisherRequest = SyncReadonly<z.infer<typeof AgentSyncPublisherRequestSchema>>;
export interface AgentSyncPublisherResponse {
  readonly status: "accepted";
  readonly receipt: AgentSyncPublishReceipt;
  readonly export?: unknown;
}
export interface AgentSyncPublisherPort {
  finish(lease: AgentSyncLease, requestId: string): Promise<AgentSyncPublisherResponse>;
}
export interface AgentSyncPorts {
  readonly workspace: AgentSyncWorkspacePort;
  readonly verifier: AgentSyncVerifierPort;
  readonly publisher: AgentSyncPublisherPort;
}
export type AgentSyncStateWriter = StateWriter<AgentSyncState>;
const VerifierResponse = z.object({ requestId: SyncIdSchema, receipt: AgentSyncCheckReceiptSchema }).strict();
const PublisherResponse = z
  .object({ status: z.literal("accepted"), receipt: AgentSyncPublishReceiptSchema, export: z.unknown().optional() })
  .strict();
/** Canonical host publish identity. Positional port callers construct this strict envelope internally. */
export function agentSyncPublishRequestHash(
  state: AgentSyncState,
  lease: AgentSyncLease,
  requestId: string,
  trustedExportTarget?: string
): string {
  const request = AgentSyncPublisherRequestSchema.parse({
    requestVersion: AGENT_SYNC_REQUEST_VERSION,
    operation: "publish",
    lease,
    requestId
  });
  return hashJson({
    requestVersion: request.requestVersion,
    projectKey: state.projectKey,
    runId: state.runId,
    planHash: state.plan.planHash,
    operation: request.operation,
    lease: request.lease,
    requestId: request.requestId,
    exportTarget: trustedExportTarget ?? null
  });
}
const validators = createPortResultValidators<
  string,
  AgentSyncLease,
  AgentSyncWorkspaceRequest,
  AgentSyncToolResult,
  AgentSyncCheckReceipt,
  AgentSyncPublishReceipt,
  AgentSyncState,
  AgentSyncVerifierRequest,
  AgentSyncVerifierResponse,
  AgentSyncPublisherResponse
>(
  {
    label: "Agent sync",
    parseLease: (input) => AgentSyncLeaseSchema.parse(input),
    parseWorkspaceRequest: (input) => AgentSyncWorkspaceRequestSchema.parse(input),
    parseToolResult: (input) => AgentSyncToolResultSchema.parse(input),
    parseVerifierRequest: (input) => AgentSyncVerifierRequestSchema.parse(input),
    parseVerifierResponse: (input) => VerifierResponse.parse(input),
    parsePublisherResponse: (input) => PublisherResponse.parse(input),
    freezeTool: freezeSyncValue,
    freezeVerifier: freezeSyncValue,
    freezePublisher: freezeSyncValue,
    checkSelection: projectCheckSelection,
    evidenceKeys: [
      "toolchainHash",
      "isolationHash",
      "imageDigest",
      "configurationHash",
      "programsHash",
      "argumentsHash"
    ],
    configurationHash: (state) => state.plan.checkConfigurationHash,
    publicationRequestHash: agentSyncPublishRequestHash
  },
  projectKernel
);
export const validateAgentSyncWorkspacePortResult = validators.workspace;
export const validateAgentSyncVerifierPortResult = validators.verifier;
export const validateAgentSyncPublisherPortResult = validators.publisher;
