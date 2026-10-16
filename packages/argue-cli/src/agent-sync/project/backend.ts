import type {
  AgentSyncPorts,
  AgentSyncProject,
  AgentSyncState,
  AgentSyncLease,
  AgentSyncToolResult,
  AgentSyncCheckReceipt,
  AgentSyncPublishReceipt
} from "@onevcat/argue/agent-sync/project";
import type { FileAgentSyncWriter } from "./storage.js";
import { protocol } from "./backend-protocol.js";
import { ManagedWorkspace, type WorkspaceOptions } from "../kernel/workspace.js";
import {
  ManagedPublisher,
  type PublisherOptions as SharedPublisherOptions,
  type PublicationResult
} from "../kernel/publisher.js";
import { exportManagedVersion, recoverManaged, type ExportOptions } from "../kernel/recovery.js";
import type { Verifier, VerificationDefinition, VerificationCandidate } from "../kernel/verification-types.js";
export interface AgentSyncCheckDefinition extends VerificationDefinition<string> {
  configurationHash: string;
  programsHash: string;
  argumentsHash: string;
}
export type AgentSyncVerifier = Verifier<string, AgentSyncCheckReceipt, AgentSyncCheckDefinition>;
export type AgentSyncVerificationCandidate = VerificationCandidate;
export type PublisherOptions = SharedPublisherOptions<FileAgentSyncWriter>;
export type AgentSyncPublicationResult = PublicationResult<AgentSyncPublishReceipt>;
export type { WorkspaceOptions };
export type AgentSyncExportFaultOptions = ExportOptions;
export class Workspace extends ManagedWorkspace<
  AgentSyncProject,
  AgentSyncLease,
  AgentSyncCheckReceipt,
  AgentSyncPublishReceipt,
  AgentSyncToolResult,
  AgentSyncState,
  string
> {
  constructor(writer: FileAgentSyncWriter, options: WorkspaceOptions = {}) {
    super(writer, protocol, options);
  }
}
export class Publisher extends ManagedPublisher<
  AgentSyncProject,
  AgentSyncLease,
  AgentSyncCheckReceipt,
  AgentSyncPublishReceipt,
  AgentSyncToolResult,
  AgentSyncState,
  string,
  AgentSyncCheckDefinition
> {
  constructor(writer: FileAgentSyncWriter, verifier: AgentSyncVerifier, options: PublisherOptions = {}) {
    super(writer, protocol, verifier, options);
  }
}
export function exportAcceptedVersion(
  writer: FileAgentSyncWriter,
  input: { version?: string; target: string },
  options: ExportOptions = {}
) {
  return exportManagedVersion(writer, input, options, false);
}
export async function recoverAgentSyncProject(writer: FileAgentSyncWriter) {
  const result = await recoverManaged(writer, false);
  return result;
}
import { ManagedLocalAdapter, type LocalAdapterOptions } from "../kernel/local-sync-adapter.js";
export type LocalAgentSyncAdapterOptions = LocalAdapterOptions<AgentSyncLease, AgentSyncPublishReceipt>;
export class LocalAgentSyncAdapter {
  readonly ports: AgentSyncPorts;
  constructor(writer: FileAgentSyncWriter, verifier: AgentSyncVerifier, options: LocalAgentSyncAdapterOptions = {}) {
    this.ports = new ManagedLocalAdapter(writer, protocol, verifier, options).ports;
  }
}
