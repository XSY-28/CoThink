import {
  AGENT_SYNC_WORKSPACE_VERSION,
  AGENT_SYNC_REQUEST_VERSION,
  AGENT_SYNC_TOOL_RECEIPT_VERSION,
  AGENT_SYNC_CANDIDATE_VERSION,
  AGENT_SYNC_CHECK_VERSION,
  AGENT_SYNC_PUBLISH_VERSION,
  reserveAgentSyncScope,
  bindAgentSyncInput,
  parseAgentSyncState,
  hashJson,
  agentSyncPublishRequestHash,
  type AgentSyncState,
  type AgentSyncToolResult,
  type AgentSyncWorkspaceRequest,
  type AgentSyncLease
} from "../../../argue/src/agent-sync/project/index.js";
import { allocate, control } from "../../../argue/test/agent-sync/project-fixture.js";
import type { FileAgentSyncWriter } from "../../src/agent-sync/project/storage.js";

/** Trusted fixture prepares real immutable Git assets and historical metadata.
 * Check fields are fixture evidence, never a claim that an isolated checker ran. */
export async function assetFixture(writer: FileAgentSyncWriter) {
  const current = await writer.load();
  const grant = reserveAgentSyncScope(
    current,
    { ...control("reserve", 0), ownerEpoch: current.ownerEpoch },
    1001,
    allocate
  );
  if (grant.result.kind !== "granted") throw new Error("fixture grant");
  const lease = grant.result.lease;
  const baseVersion = current.acceptedVersion;
  const contentHashes = { "shared.ts": null };
  const inputHash = hashJson({
    planHash: current.plan.planHash,
    attemptId: lease.attemptId,
    baseVersion,
    contentHashes
  });
  const bound = bindAgentSyncInput(
    grant.state,
    {
      requestVersion: AGENT_SYNC_REQUEST_VERSION,
      operation: "bind",
      requestId: "bound",
      lease,
      snapshot: { baseVersion, inputHash, contentHashes }
    },
    1001
  );
  if (bound.result.kind !== "bound") throw new Error("fixture bind");
  const blob = await writer.git.writeBlob("first\n");
  const files = [{ path: "shared.ts", ...blob }];
  const overlayHash = hashJson({ attemptId: lease.attemptId, baseVersion, files });
  const snapshot = await writer.git.createSnapshot(baseVersion, files);
  const candidate = {
    candidateVersion: AGENT_SYNC_CANDIDATE_VERSION,
    attemptId: lease.attemptId,
    baseVersion,
    overlayHash,
    ...snapshot
  };
  const receipt = (request: AgentSyncWorkspaceRequest, result: AgentSyncToolResult) => ({
    receiptVersion: AGENT_SYNC_TOOL_RECEIPT_VERSION,
    requestId: request.requestId,
    attemptId: lease.attemptId,
    operation: request.operation,
    requestHash: hashJson({
      projectKey: current.projectKey,
      runId: current.runId,
      planHash: current.plan.planHash,
      request
    }),
    request,
    outputHash: hashJson(result),
    result
  });
  const requests = {
    edit: {
      requestVersion: AGENT_SYNC_REQUEST_VERSION,
      requestId: "edit",
      operation: "edit" as const,
      lease,
      edits: [{ path: "shared.ts", expectedContentHash: null, text: "first\n" }]
    },
    inspect: {
      requestVersion: AGENT_SYNC_REQUEST_VERSION,
      requestId: "inspect",
      operation: "inspect" as const,
      lease,
      path: "shared.ts"
    }
  };
  const edit = receipt(requests.edit, { kind: "edited", baseVersion, files, overlayHash });
  const inspect = receipt(requests.inspect, {
    kind: "inspected",
    baseVersion,
    path: "shared.ts",
    text: "first\n",
    contentHash: blob.contentHash
  });
  const sourceHash = hashJson(
    Object.entries(await writer.git.readFiles(candidate.version))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, file]) => ({ path, contentHash: file.contentHash }))
  );
  const H = hashJson("trusted-test-check-fixture");
  const check = {
    checkVersion: AGENT_SYNC_CHECK_VERSION,
    receiptId: "check",
    attemptId: lease.attemptId,
    baseVersion,
    version: candidate.version,
    candidateHash: candidate.candidateHash,
    checksHash: H,
    groups: ["types"],
    planHash: current.plan.planHash,
    configurationHash: current.plan.checkConfigurationHash,
    programsHash: H,
    argumentsHash: H,
    toolchainHash: H,
    isolationHash: H,
    imageDigest: `sha256:${"a".repeat(64)}`,
    sourceHashBefore: sourceHash,
    sourceHashAfter: sourceHash,
    exitCode: 0,
    passed: true
  };
  const state = parseAgentSyncState({
    ...bound.state,
    revision: current.revision + 1,
    workspace: {
      workspaceVersion: AGENT_SYNC_WORKSPACE_VERSION,
      staging: [{ attemptId: lease.attemptId, baseVersion, files, overlayHash }],
      candidates: [candidate],
      toolReceipts: [edit, inspect]
    },
    checkReceipts: [check]
  });
  return { current, state, lease, blob, candidate, check, receipt, requests };
}
/** Deliberately invalid publication on a still-running, unaccepted attempt. */
export function malformedPublication(state: AgentSyncState, lease: AgentSyncLease) {
  const check = state.checkReceipts[0]!;
  const attempt = state.attempts[0]!;
  const receipt = {
    publishVersion: AGENT_SYNC_PUBLISH_VERSION,
    receiptId: "publication",
    requestId: "publish",
    attemptId: lease.attemptId,
    checkReceiptId: check.receiptId,
    baseVersion: check.baseVersion,
    acceptedVersion: check.version,
    candidateHash: check.candidateHash,
    checksHash: check.checksHash,
    requestHash: agentSyncPublishRequestHash(state, lease, "publish"),
    ownerEpoch: lease.ownerEpoch,
    leaseEpoch: lease.leaseEpoch,
    inputHash: attempt.inputHash,
    overlayHash: state.workspace!.staging[0]!.overlayHash,
    toolchainHash: check.toolchainHash,
    isolationHash: check.isolationHash,
    configurationHash: check.configurationHash,
    programsHash: check.programsHash,
    argumentsHash: check.argumentsHash,
    planHash: check.planHash,
    imageDigest: check.imageDigest
  };
  return parseAgentSyncState({ ...state, publishReceipts: [receipt] });
}
