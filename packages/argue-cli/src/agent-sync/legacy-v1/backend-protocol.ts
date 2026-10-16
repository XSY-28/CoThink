import {
  BuildLeaseSchema,
  BuildWorkspaceRequestSchema,
  BuildToolResultSchema,
  BuildCheckReceiptSchema,
  BuildPublishReceiptSchema,
  BuildVerifierRequestSchema,
  parseBuildState,
  validateBuildLease,
  expireBuildState,
  bindBuildInput,
  BuildIdSchema,
  buildPublishRequestHash,
  buildPublicationChecks,
  validateVerifierPortResult,
  validatePublisherPortResult,
  type BuildPlan,
  type BuildState,
  type BuildLease,
  type BuildToolResult,
  type BuildCheckReceipt,
  type BuildPublishReceipt,
  type BuildCheckGroup
} from "@onevcat/argue/agent-sync/legacy-v1";
import type { BackendProtocol } from "../kernel/backend-types.js";
import { freeze } from "../kernel/backend-types.js";
export const protocol = freeze<
  BackendProtocol<
    BuildPlan,
    BuildLease,
    BuildCheckReceipt,
    BuildPublishReceipt,
    BuildToolResult,
    BuildState,
    BuildCheckGroup
  >
>({
  workspaceVersion: "build-workspace-v1",
  toolMetadata: {},
  candidateMetadata: {},
  publishVersion: "build-publish-v1",
  evidenceKeys: ["toolchainHash", "isolationHash", "imageDigest"] as const,
  allowLegacyChecks: true,
  parseState: parseBuildState,
  parseLease: (raw) => BuildLeaseSchema.parse(raw),
  parseId: (raw) => BuildIdSchema.parse(raw),
  workspace: (raw) => BuildWorkspaceRequestSchema.parse(raw),
  tool: (raw) => BuildToolResultSchema.parse(raw),
  parseCheck: (raw) => BuildCheckReceiptSchema.parse(raw),
  parsePublish: (raw) => BuildPublishReceiptSchema.parse(raw),
  validateLease: validateBuildLease,
  expire: (state, now) => expireBuildState(state, { ownerEpoch: state.ownerEpoch }, now).state,
  bind: bindBuildInput,
  groups: buildPublicationChecks,
  publishHash: buildPublishRequestHash,
  extraRequestIds: (state) => state.actionReceipts.map((r) => r.requestId),
  validateResources: () => {},
  configurationHash: () => undefined,
  verifierRequest: (raw) => BuildVerifierRequestSchema.parse(raw),
  validateVerifier: (state, request, response) =>
    validateVerifierPortResult(state, BuildVerifierRequestSchema.parse(request), response),
  validatePublisher: validatePublisherPortResult
});
