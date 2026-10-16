import { z } from "zod";
import { hashJson } from "../../peer/hash.js";
import {
  BUILD_CHECK_GROUPS,
  BuildCheckReceiptSchema,
  BuildCheckGroupSchema,
  type BuildCheckGroup,
  BuildIdSchema,
  BuildLeaseSchema,
  BuildPublishReceiptSchema,
  BuildToolResultSchema,
  BuildWorkspaceRequestSchema,
  freezeBuildValue,
  type BuildCheckReceipt,
  type BuildLease,
  type BuildPublishReceipt,
  type BuildToolResult,
  type BuildWorkspaceRequest
} from "../../build/contracts.js";
import { legacyKernel, type BuildState } from "./coordination.js";
import { resolvePublicationChecks, type CheckSelectionPlan } from "../kernel/checks.js";
import { createPortResultValidators } from "../kernel/ports.js";
type Result<K extends BuildToolResult["kind"]> = Extract<BuildToolResult, { kind: K }>;
/** Backends are trusted program components. These checks catch stale or malformed
 * replies; a backend with arbitrary write access to authoritative storage remains trusted. */
export interface WorkspacePort {
  freezeInput(lease: BuildLease, requestId: string): Promise<Result<"frozen">>;
  inspect(lease: BuildLease, requestId: string, path: string): Promise<Result<"inspected">>;
  edit(
    lease: BuildLease,
    requestId: string,
    edits: readonly { path: string; text: string; expectedContentHash: string | null }[]
  ): Promise<Result<"edited">>;
  seal(lease: BuildLease, requestId: string): Promise<Result<"sealed">>;
}
export interface BuildVerifierRequest {
  readonly requestId: string;
  readonly lease: BuildLease;
  readonly candidate: Result<"sealed">;
}
export interface BuildVerifierResponse {
  readonly requestId: string;
  readonly receipt: BuildCheckReceipt;
}
export interface VerifierPort {
  check(request: BuildVerifierRequest): Promise<BuildVerifierResponse>;
}
export interface BuildPublisherResponse {
  readonly status: "accepted";
  readonly receipt: BuildPublishReceipt;
  readonly export?: unknown;
}
export interface PublisherPort {
  finish(lease: BuildLease, requestId: string): Promise<BuildPublisherResponse>;
}
export interface BuildSyncPorts {
  readonly workspace: WorkspacePort;
  readonly verifier: VerifierPort;
  readonly publisher: PublisherPort;
}

export const BuildVerifierRequestSchema = z
  .object({
    requestId: BuildIdSchema,
    lease: BuildLeaseSchema,
    candidate: BuildToolResultSchema.options[3]
  })
  .strict();
const verifierResponse = z.object({ requestId: BuildIdSchema, receipt: BuildCheckReceiptSchema }).strict();
const publisherResponse = z
  .object({ status: z.literal("accepted"), receipt: BuildPublishReceiptSchema, export: z.unknown().optional() })
  .strict();

export function buildCheckSelection(state: BuildState): CheckSelectionPlan {
  return {
    tasks: state.plan.tasks,
    profiles: state.plan.profiles.map((profile) => ({ profileId: profile.profileId, checks: profile.groups })),
    finalProfileId: "final",
    alwaysChecks: ["common"],
    order: BUILD_CHECK_GROUPS
  };
}
export function buildPublicationChecks(state: BuildState, taskId: string): BuildCheckGroup[] {
  return z
    .array(BuildCheckGroupSchema)
    .parse(resolvePublicationChecks(buildCheckSelection(state), state.acceptedTasks, taskId));
}
export function buildPublishRequestHash(
  state: BuildState,
  lease: BuildLease,
  requestId: string,
  trustedExportTarget?: string
): string {
  BuildIdSchema.parse(requestId);
  return hashJson({
    projectKey: state.projectKey,
    runId: state.runId,
    planHash: state.plan.planHash,
    operation: "publish",
    lease,
    requestId,
    exportTarget: trustedExportTarget ?? null
  });
}
export const legacyPortValidators = createPortResultValidators<
  BuildLease["workerId"],
  BuildLease,
  BuildWorkspaceRequest,
  BuildToolResult,
  BuildCheckReceipt,
  BuildPublishReceipt,
  BuildState,
  BuildVerifierRequest,
  BuildVerifierResponse,
  BuildPublisherResponse
>(
  {
    label: "Build",
    parseLease: (input) => BuildLeaseSchema.parse(input),
    parseWorkspaceRequest: (input) => BuildWorkspaceRequestSchema.parse(input),
    parseToolResult: (input) => BuildToolResultSchema.parse(input),
    parseVerifierRequest: (input) => BuildVerifierRequestSchema.parse(input),
    parseVerifierResponse: (input) => verifierResponse.parse(input),
    parsePublisherResponse: (input) => publisherResponse.parse(input),
    freezeTool: freezeBuildValue,
    freezeVerifier: freezeBuildValue,
    freezePublisher: freezeBuildValue,
    checkSelection: buildCheckSelection,
    evidenceKeys: ["toolchainHash", "isolationHash", "imageDigest"],
    configurationHash: () => undefined,
    publicationRequestHash: buildPublishRequestHash
  },
  legacyKernel
);
