import type {
  BuildSyncPorts,
  BuildPlan,
  BuildState,
  BuildLease,
  BuildToolResult,
  BuildCheckReceipt,
  BuildPublishReceipt,
  BuildCheckGroup
} from "@onevcat/argue/agent-sync/legacy-v1";
import type { FileBuildWriter } from "./storage.js";
import { protocol } from "./backend-protocol.js";
import { ManagedWorkspace, type WorkspaceOptions } from "../kernel/workspace.js";
import {
  ManagedPublisher,
  type PublisherOptions as SharedPublisherOptions,
  type PublicationResult
} from "../kernel/publisher.js";
import { exportManagedVersion, recoverManaged, type ExportOptions } from "../kernel/recovery.js";
import type { Verifier, VerificationDefinition, VerificationCandidate } from "../kernel/verification-types.js";
export type BuildCheckDefinition = Pick<
  VerificationDefinition<BuildCheckGroup>,
  "groups" | "checksHash" | "toolchainHash" | "isolationHash" | "imageDigest"
>;
export type BuildVerifier = Verifier<BuildCheckGroup, BuildCheckReceipt, BuildCheckDefinition>;
export type BuildVerificationCandidate = VerificationCandidate;
export type PublisherOptions = SharedPublisherOptions<FileBuildWriter>;
export type BuildPublicationResult = PublicationResult<BuildPublishReceipt>;
export type { WorkspaceOptions };
export type BuildExportOptions = ExportOptions;
export class Workspace extends ManagedWorkspace<
  BuildPlan,
  BuildLease,
  BuildCheckReceipt,
  BuildPublishReceipt,
  BuildToolResult,
  BuildState,
  BuildCheckGroup
> {
  constructor(writer: FileBuildWriter, options: WorkspaceOptions = {}) {
    super(writer, protocol, options);
  }
}
export class Publisher extends ManagedPublisher<
  BuildPlan,
  BuildLease,
  BuildCheckReceipt,
  BuildPublishReceipt,
  BuildToolResult,
  BuildState,
  BuildCheckGroup,
  BuildCheckDefinition
> {
  constructor(writer: FileBuildWriter, verifier: BuildVerifier, options: PublisherOptions = {}) {
    super(writer, protocol, verifier, options);
  }
}
export function exportAcceptedVersion(
  writer: FileBuildWriter,
  input: { version?: string; target: string },
  options: ExportOptions = {}
) {
  return exportManagedVersion(writer, input, options, true);
}
export async function recoverBuild(writer: FileBuildWriter) {
  const result = await recoverManaged(writer, true);
  return { ...result, modelCalls: 0 as const };
}
export { buildPublicationChecks as publicationGroups } from "@onevcat/argue/agent-sync/legacy-v1";
import { ManagedLocalAdapter } from "../kernel/local-sync-adapter.js";
export interface LocalBuildSyncAdapterOptions {
  clock?: () => number;
  publisher?: Publisher;
}
export class LocalBuildSyncAdapter {
  readonly ports: BuildSyncPorts;
  constructor(writer: FileBuildWriter, verifier: BuildVerifier, options: LocalBuildSyncAdapterOptions = {}) {
    this.ports = new ManagedLocalAdapter(writer, protocol, verifier, options).ports;
  }
}
