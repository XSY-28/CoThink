import { hashJson } from "../../peer/hash.js";
import { resolvePublicationChecks, type CheckSelectionPlan } from "./checks.js";
import type { KernelAttempt, LeaseIdentity, ProjectIdentity } from "./types.js";
interface ToolBase {
  readonly kind: string;
  readonly baseVersion: string;
}
export interface SealedResult extends ToolBase {
  readonly kind: "sealed";
  readonly version: string;
  readonly overlayHash: string;
  readonly candidateHash: string;
}
export type ToolResult =
  | {
      readonly kind: "frozen";
      readonly baseVersion: string;
      readonly inputHash: string;
      readonly contentHashes: Readonly<Record<string, string | null>>;
    }
  | SealedResult
  | {
      readonly kind: "inspected";
      readonly baseVersion: string;
      readonly path: string;
      readonly text: string | null;
      readonly contentHash: string | null;
    }
  | {
      readonly kind: "edited";
      readonly baseVersion: string;
      readonly overlayHash: string;
      readonly files: readonly { readonly path: string; readonly blobId: string; readonly contentHash: string }[];
    };
export interface WorkspaceRequest<L> {
  readonly operation: string;
  readonly requestId: string;
  readonly lease: L;
}
export interface VerifierRequest<L> {
  readonly requestId: string;
  readonly lease: L;
  readonly candidate: SealedResult;
}
interface Evidence {
  readonly toolchainHash?: string;
  readonly isolationHash?: string;
  readonly imageDigest?: string;
  readonly configurationHash?: string;
  readonly programsHash?: string;
  readonly argumentsHash?: string;
  readonly planHash?: string;
}
export interface CheckReceipt extends Evidence {
  readonly receiptId: string;
  readonly attemptId: string;
  readonly baseVersion?: string;
  readonly version?: string;
  readonly candidateHash: string;
  readonly checksHash: string;
  readonly groups: readonly string[];
  readonly passed: boolean;
  readonly sourceHashBefore?: string;
  readonly sourceHashAfter?: string;
}
export interface PublishReceipt extends Evidence {
  readonly receiptId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly checkReceiptId: string;
  readonly requestHash?: string;
  readonly inputHash?: string;
  readonly ownerEpoch?: number;
  readonly leaseEpoch?: number;
  readonly overlayHash?: string;
  readonly baseVersion: string;
  readonly acceptedVersion: string;
  readonly candidateHash: string;
  readonly checksHash: string;
}
export interface PortState<
  M extends string,
  L,
  W extends WorkspaceRequest<L>,
  T extends ToolResult,
  C extends CheckReceipt,
  P extends PublishReceipt
> extends ProjectIdentity {
  readonly acceptedVersion: string;
  readonly acceptedTasks: readonly string[];
  readonly coordination: { readonly lastNow: number };
  readonly attempts: readonly KernelAttempt<M>[];
  readonly workspace?: {
    readonly toolReceipts: readonly { readonly requestId: string; readonly request: W; readonly result: T }[];
    readonly staging: readonly {
      readonly attemptId: string;
      readonly overlayHash: string;
      readonly files: readonly { readonly path: string; readonly blobId: string; readonly contentHash: string }[];
    }[];
    readonly candidates: readonly {
      readonly attemptId: string;
      readonly baseVersion: string;
      readonly version: string;
      readonly overlayHash: string;
      readonly candidateHash: string;
    }[];
  };
  readonly checkReceipts: readonly C[];
  readonly publishReceipts: readonly P[];
}
export interface PortProtocol<S, L, W, T, VQ, VR, PR> {
  readonly label: string;
  parseLease(input: unknown): L;
  parseWorkspaceRequest(input: unknown): W;
  parseToolResult(input: unknown): T;
  parseVerifierRequest(input: unknown): VQ;
  parseVerifierResponse(input: unknown): VR;
  parsePublisherResponse(input: unknown): PR;
  freezeTool(result: T): T;
  freezeVerifier(result: VR): VR;
  freezePublisher(result: PR): PR;
  checkSelection(state: S): CheckSelectionPlan;
  readonly evidenceKeys: readonly (keyof Evidence)[];
  configurationHash(state: S): string | undefined;
  publicationRequestHash(state: S, lease: L, requestId: string): string;
}
/** Validation algorithms operate on structural evidence; protocol parsers retain all format metadata. */
export function createPortResultValidators<
  M extends string,
  L extends LeaseIdentity<M>,
  W extends WorkspaceRequest<L>,
  T extends ToolResult,
  C extends CheckReceipt,
  P extends PublishReceipt,
  S extends PortState<M, L, W, T, C, P>,
  VQ extends VerifierRequest<L>,
  VR extends { readonly requestId: string; readonly receipt: C },
  PR extends { readonly status: "accepted"; readonly receipt: P }
>(
  protocol: PortProtocol<S, L, W, T, VQ, VR, PR>,
  kernel: {
    parse(input: unknown): S;
    internals: {
      validateParsedLease(state: S, lease: unknown, now: number): { valid: true } | { valid: false; code: string };
    };
    leaseFor(state: ProjectIdentity, attempt: KernelAttempt<M>): L;
  }
) {
  const reject = (message: string): never => {
    throw new Error(`${protocol.label} sync port rejected: ${message}`);
  };
  function attemptFor(state: S, lease: L) {
    const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId);
    if (!attempt || hashJson(kernel.leaseFor(state, attempt)) !== hashJson(lease))
      return reject("lease binding mismatch");
    return attempt;
  }
  const groupsFor = (state: S, taskId: string, accepted = state.acceptedTasks) =>
    resolvePublicationChecks(protocol.checkSelection(state), accepted, taskId);
  function completeEvidence(state: S, evidence: C | P): boolean {
    return (
      protocol.evidenceKeys.every((key) => !!evidence[key]) &&
      (protocol.configurationHash(state) === undefined ||
        evidence.configurationHash === protocol.configurationHash(state))
    );
  }
  function workspace(rawState: S, rawRequest: W, rawResult: unknown): T {
    const state = kernel.parse(rawState),
      request = protocol.parseWorkspaceRequest(rawRequest),
      result = protocol.parseToolResult(rawResult);
    const attempt = attemptFor(state, request.lease),
      receipt = state.workspace?.toolReceipts.find((r) => r.requestId === request.requestId);
    if (
      !receipt ||
      hashJson(receipt.request) !== hashJson(request) ||
      hashJson(receipt.result) !== hashJson(result) ||
      result.baseVersion !== attempt.baseVersion
    )
      return reject("workspace result has no matching durable request");
    if (
      result.kind === "frozen" &&
      (result.inputHash !==
        hashJson({
          planHash: state.plan.planHash,
          attemptId: attempt.attemptId,
          baseVersion: attempt.baseVersion,
          contentHashes: result.contentHashes
        }) ||
        attempt.inputHash !== result.inputHash ||
        hashJson(attempt.contentHashes) !== hashJson(result.contentHashes))
    )
      return reject("frozen input hash mismatch");
    return protocol.freezeTool(result);
  }
  function verifier(rawState: S, rawRequest: VQ, rawResponse: unknown): VR {
    const state = kernel.parse(rawState),
      request = protocol.parseVerifierRequest(rawRequest),
      response = protocol.parseVerifierResponse(rawResponse);
    const attempt = attemptFor(state, request.lease),
      candidate = request.candidate,
      check = response.receipt;
    if (!kernel.internals.validateParsedLease(state, request.lease, state.coordination.lastNow).valid)
      return reject("verifier lease is no longer current");
    const overlay = state.workspace?.staging.find((s) => s.attemptId === attempt.attemptId);
    const overlayHash = hashJson({
      attemptId: attempt.attemptId,
      baseVersion: attempt.baseVersion,
      files: overlay?.files ?? []
    });
    if (
      (overlay !== undefined && overlay.overlayHash !== overlayHash) ||
      attempt.inputHash === null ||
      candidate.baseVersion !== attempt.baseVersion ||
      candidate.baseVersion !== state.acceptedVersion ||
      candidate.overlayHash !== overlayHash ||
      !state.workspace?.candidates.some(
        (c) => hashJson(c) === hashJson({ attemptId: attempt.attemptId, ...candidate, kind: undefined })
      ) ||
      response.requestId !== request.requestId ||
      check.attemptId !== attempt.attemptId ||
      check.baseVersion !== candidate.baseVersion ||
      check.version !== candidate.version ||
      check.candidateHash !== candidate.candidateHash ||
      check.planHash !== state.plan.planHash ||
      !completeEvidence(state, check) ||
      !check.sourceHashBefore ||
      !check.sourceHashAfter ||
      hashJson(check.groups) !== hashJson(groupsFor(state, attempt.taskId))
    )
      return reject("verifier request/candidate/evidence mismatch");
    return protocol.freezeVerifier(response);
  }
  function publisher(rawBefore: S, rawLease: L, requestId: string, rawResponse: unknown, rawAfter: S): PR {
    const before = kernel.parse(rawBefore),
      after = kernel.parse(rawAfter),
      lease = protocol.parseLease(rawLease),
      response = protocol.parsePublisherResponse(rawResponse),
      receipt = response.receipt;
    const attempt = attemptFor(after, lease),
      durable = after.publishReceipts.find((r) => r.requestId === requestId),
      check = after.checkReceipts.find((r) => r.receiptId === receipt.checkReceiptId),
      old = before.publishReceipts.find((r) => r.requestId === requestId);
    const receiptIndex = after.publishReceipts.findIndex((r) => r.requestId === requestId);
    const taskFor = (attemptId: string) => {
      const found = after.attempts.find((a) => a.attemptId === attemptId);
      if (!found) return reject("unknown publication attempt");
      return found.taskId;
    };
    const priorTasks = [
      ...before.acceptedTasks.filter((taskId) => !after.publishReceipts.some((r) => taskFor(r.attemptId) === taskId)),
      ...after.publishReceipts.slice(0, receiptIndex).map((r) => taskFor(r.attemptId))
    ];
    if (!before.publishReceipts.every((r, i) => hashJson(r) === hashJson(after.publishReceipts[i])))
      return reject("publication history changed");
    // Validate the complete ordered durable chain even for a read-only historical replay.
    // Starting at the returned receipt alone could hide an earlier fork in that history.
    for (let index = 1; index < after.publishReceipts.length; index++) {
      if (after.publishReceipts[index]!.baseVersion !== after.publishReceipts[index - 1]!.acceptedVersion)
        return reject("publication history is not contiguous");
    }
    if (after.publishReceipts.length && after.publishReceipts.at(-1)!.acceptedVersion !== after.acceptedVersion)
      return reject("publication history does not reach accepted head");
    let publicationBase = before.acceptedVersion;
    if (!old) {
      if (receiptIndex < before.publishReceipts.length) return reject("publication predates request");
      for (const concurrent of after.publishReceipts.slice(before.publishReceipts.length, receiptIndex)) {
        if (concurrent.baseVersion !== publicationBase)
          return reject("concurrent acceptance history is not contiguous");
        publicationBase = concurrent.acceptedVersion;
      }
    }
    const expectedGroups = groupsFor(before, lease.taskId, priorTasks);
    const requestHash = protocol.publicationRequestHash(after, lease, requestId);
    const overlay = after.workspace?.staging.find((s) => s.attemptId === attempt.attemptId);
    const overlayHash = hashJson({
      attemptId: attempt.attemptId,
      baseVersion: attempt.baseVersion,
      files: overlay?.files ?? []
    });
    if (
      before.projectKey !== after.projectKey ||
      before.runId !== after.runId ||
      before.plan.planHash !== after.plan.planHash ||
      !durable ||
      hashJson(durable) !== hashJson(receipt) ||
      receipt.requestId !== requestId ||
      receipt.requestHash !== requestHash ||
      receipt.attemptId !== attempt.attemptId ||
      attempt.status !== "completed" ||
      !after.acceptedTasks.includes(attempt.taskId) ||
      receipt.planHash !== after.plan.planHash ||
      receipt.inputHash !== attempt.inputHash ||
      receipt.ownerEpoch !== lease.ownerEpoch ||
      receipt.leaseEpoch !== lease.leaseEpoch ||
      receipt.overlayHash !== overlayHash ||
      !check?.passed ||
      check.attemptId !== attempt.attemptId ||
      check.version !== receipt.acceptedVersion ||
      check.baseVersion !== receipt.baseVersion ||
      check.candidateHash !== receipt.candidateHash ||
      check.checksHash !== receipt.checksHash ||
      check.planHash !== after.plan.planHash ||
      !completeEvidence(after, check) ||
      !completeEvidence(after, receipt) ||
      !check.sourceHashBefore ||
      !check.sourceHashAfter ||
      check.sourceHashBefore !== check.sourceHashAfter ||
      hashJson(check.groups) !== hashJson(expectedGroups) ||
      protocol.evidenceKeys.some((key) => receipt[key] !== check[key]) ||
      (!old && receipt.baseVersion !== publicationBase) ||
      (old && hashJson(old) !== hashJson(receipt))
    )
      return reject("publication has no matching durable acceptance");
    let version = receipt.acceptedVersion;
    const seen = new Set<string>();
    while (version !== after.acceptedVersion && !seen.has(version)) {
      seen.add(version);
      const next = after.publishReceipts.find((r) => r.baseVersion === version && r.acceptedVersion !== version);
      if (!next) return reject("publication is not in accepted history");
      version = next.acceptedVersion;
    }
    if (version !== after.acceptedVersion) return reject("publication history cycle");
    return protocol.freezePublisher(response);
  }
  return { workspace, verifier, publisher };
}
