import { describe, expect, test } from "vitest";
import * as api from "../../src/agent-sync/project/index.js";
import { hashJson, sha256 } from "../../src/peer/hash.js";
import { projectState, control, allocate } from "./project-fixture.js";
function bound() {
  const grant = api.reserveAgentSyncScope(projectState(), control("reserve", 0), 1000, allocate);
  if (grant.result.kind !== "granted") throw Error("expected grant");
  const lease = grant.result.lease,
    contentHashes = { "shared.ts": null },
    baseVersion = grant.state.acceptedVersion;
  const inputHash = hashJson({
    planHash: grant.state.plan.planHash,
    attemptId: lease.attemptId,
    baseVersion,
    contentHashes
  });
  const state = api.bindAgentSyncInput(
    grant.state,
    {
      requestVersion: api.AGENT_SYNC_REQUEST_VERSION,
      operation: "bind",
      requestId: "bind",
      lease,
      snapshot: { baseVersion, inputHash, contentHashes }
    },
    1000
  ).state;
  return { state, lease, inputHash, baseVersion, contentHashes };
}
function evidence(state: api.AgentSyncState) {
  return {
    planHash: state.plan.planHash,
    configurationHash: state.plan.checkConfigurationHash,
    programsHash: sha256("programs"),
    argumentsHash: sha256("args"),
    toolchainHash: sha256("tools"),
    isolationHash: sha256("isolation"),
    imageDigest: sha256("image")
  };
}
function publication(staged: boolean) {
  const { state: before, lease, inputHash, baseVersion } = bound();
  const files = staged ? [{ path: "shared.ts", blobId: "b".repeat(40), contentHash: sha256("new") }] : [];
  const overlayHash = hashJson({ attemptId: lease.attemptId, baseVersion, files });
  const check: api.AgentSyncCheckReceipt = {
    checkVersion: api.AGENT_SYNC_CHECK_VERSION,
    receiptId: "check",
    attemptId: lease.attemptId,
    candidateHash: sha256("formal"),
    checksHash: sha256("checks"),
    groups: ["types"],
    ...evidence(before),
    exitCode: 0,
    passed: true,
    baseVersion,
    version: "c".repeat(40),
    sourceHashBefore: sha256("tree"),
    sourceHashAfter: sha256("tree")
  };
  const receipt = {
    publishVersion: api.AGENT_SYNC_PUBLISH_VERSION,
    receiptId: "publication",
    attemptId: lease.attemptId,
    requestId: "publish",
    checkReceiptId: "check",
    baseVersion,
    acceptedVersion: check.version,
    candidateHash: check.candidateHash,
    checksHash: check.checksHash,
    requestHash: api.agentSyncPublishRequestHash(before, lease, "publish"),
    ownerEpoch: lease.ownerEpoch,
    leaseEpoch: lease.leaseEpoch,
    inputHash,
    overlayHash,
    ...evidence(before)
  };
  const after = api.parseAgentSyncState({
    ...before,
    acceptedVersion: receipt.acceptedVersion,
    acceptedTasks: [lease.taskId],
    attempts: before.attempts.map((a) => ({ ...a, status: "completed" })),
    coordination: {
      ...before.coordination,
      locks: [],
      taskStates: { ...before.coordination.taskStates, [lease.taskId]: "completed" }
    },
    workspace: {
      workspaceVersion: api.AGENT_SYNC_WORKSPACE_VERSION,
      staging: staged ? [{ attemptId: lease.attemptId, baseVersion, files, overlayHash }] : [],
      candidates: [],
      toolReceipts: []
    },
    checkReceipts: [check],
    publishReceipts: [receipt]
  });
  return { before, after, lease, response: { status: "accepted" as const, receipt } };
}
describe("project port evidence", () => {
  test("exports strict project validators", () => {
    expect(api).toHaveProperty("validateAgentSyncPublisherPortResult", expect.any(Function));
  });
  test.each([false, true])("accepts durable direct finish without private seal (staging=%s)", (staged) => {
    const { before, after, lease, response } = publication(staged);
    expect(api.validateAgentSyncPublisherPortResult(before, lease, "publish", response, after)).toEqual(response);
    expect(api.validateAgentSyncPublisherPortResult(after, lease, "publish", response, after)).toEqual(response);
    expect(() => api.validateAgentSyncPublisherPortResult(before, lease, "publish", response, before)).toThrow();
    for (const receipt of [
      { ...response.receipt, requestHash: sha256("foreign") },
      { ...response.receipt, configurationHash: sha256("foreign") },
      { ...response.receipt, acceptedVersion: "f".repeat(40) }
    ])
      expect(() =>
        api.validateAgentSyncPublisherPortResult(before, lease, "publish", { ...response, receipt }, after)
      ).toThrow();
    expect(Object.isFrozen(after)).toBe(true);
  });
  test("workspace requires exact persisted request and bound frozen result", () => {
    const { state, lease, inputHash, baseVersion, contentHashes } = bound();
    const request: api.AgentSyncWorkspaceRequest = {
      requestVersion: api.AGENT_SYNC_REQUEST_VERSION,
      requestId: "freeze",
      operation: "freeze" as const,
      lease
    };
    const result = { kind: "frozen" as const, baseVersion, inputHash, contentHashes };
    const receipt = {
      receiptVersion: api.AGENT_SYNC_TOOL_RECEIPT_VERSION,
      requestId: "freeze",
      attemptId: lease.attemptId,
      operation: "freeze",
      requestHash: hashJson({
        projectKey: state.projectKey,
        runId: state.runId,
        planHash: state.plan.planHash,
        request
      }),
      request,
      outputHash: hashJson(result),
      result
    };
    const durable = api.parseAgentSyncState({
      ...state,
      workspace: {
        workspaceVersion: api.AGENT_SYNC_WORKSPACE_VERSION,
        staging: [],
        candidates: [],
        toolReceipts: [receipt]
      }
    });
    expect(api.validateAgentSyncWorkspacePortResult(durable, request, result)).toEqual(result);
    expect(() => api.validateAgentSyncWorkspacePortResult(state, request, result)).toThrow();
    expect(() =>
      api.validateAgentSyncWorkspacePortResult(durable, request, { ...result, inputHash: sha256("fake") })
    ).toThrow();
  });
  test.each([false, true])("standalone checks bind the current private candidate (staging=%s)", (staged) => {
    const { state, lease, baseVersion } = bound();
    const files = staged ? [{ path: "shared.ts", blobId: "e".repeat(40), contentHash: sha256("private edit") }] : [];
    const overlayHash = hashJson({ attemptId: lease.attemptId, baseVersion, files });
    const candidate: Extract<api.AgentSyncToolResult, { kind: "sealed" }> = {
      kind: "sealed" as const,
      candidateVersion: api.AGENT_SYNC_CANDIDATE_VERSION,
      baseVersion,
      version: "b".repeat(40),
      overlayHash,
      candidateHash: sha256("private")
    };
    const check: api.AgentSyncCheckReceipt = {
      checkVersion: api.AGENT_SYNC_CHECK_VERSION,
      receiptId: "private-check",
      attemptId: lease.attemptId,
      candidateHash: candidate.candidateHash,
      checksHash: sha256("checks"),
      groups: ["types"],
      ...evidence(state),
      exitCode: 0,
      passed: true,
      baseVersion,
      version: candidate.version,
      sourceHashBefore: sha256("tree"),
      sourceHashAfter: sha256("tree")
    };
    const { kind: _kind, ...sealed } = candidate;
    void _kind;
    const withCandidate = api.parseAgentSyncState({
      ...state,
      workspace: {
        workspaceVersion: api.AGENT_SYNC_WORKSPACE_VERSION,
        staging: staged ? [{ attemptId: lease.attemptId, baseVersion, files, overlayHash }] : [],
        candidates: [{ attemptId: lease.attemptId, ...sealed }],
        toolReceipts: []
      }
    });
    const durable = api.parseAgentSyncState({ ...withCandidate, checkReceipts: [check] });
    const request: api.AgentSyncVerifierRequest = {
        requestVersion: api.AGENT_SYNC_REQUEST_VERSION,
        requestId: "verify",
        lease,
        candidate
      },
      response = { requestId: "verify", receipt: check };
    expect(api.validateAgentSyncVerifierPortResult(durable, request, response)).toEqual(response);
    expect(api.validateAgentSyncVerifierPortResult(withCandidate, request, response)).toEqual(response);
    // The trusted backend may accidentally leave both stored hashes unchanged after an edit.
    const changedFiles = [{ path: "shared.ts", blobId: "f".repeat(40), contentHash: sha256("later edit") }];
    const changedFilesHash = hashJson({ attemptId: lease.attemptId, baseVersion, files: changedFiles });
    expect(changedFilesHash).not.toBe(overlayHash);
    const staleOverlay = api.parseAgentSyncState({
      ...withCandidate,
      workspace: {
        ...withCandidate.workspace!,
        staging: [{ attemptId: lease.attemptId, baseVersion, files: changedFiles, overlayHash }]
      }
    });
    expect(staleOverlay.workspace!.staging[0]!.overlayHash).toBe(candidate.overlayHash);
    expect(() => api.validateAgentSyncVerifierPortResult(staleOverlay, request, response)).toThrow(/overlay|evidence/);
    // Independently reject a stale staging hash even when candidate describes the actual files.
    const badStoredHash = api.parseAgentSyncState({
      ...withCandidate,
      workspace: {
        ...withCandidate.workspace!,
        staging: [{ attemptId: lease.attemptId, baseVersion, files, overlayHash: sha256("stale stored hash") }]
      }
    });
    expect(() => api.validateAgentSyncVerifierPortResult(badStoredHash, request, response)).toThrow(/overlay|evidence/);

    expect(() => api.validateAgentSyncVerifierPortResult(state, request, response)).toThrow();
    expect(() =>
      api.validateAgentSyncVerifierPortResult({ ...durable, acceptedVersion: "d".repeat(40) }, request, response)
    ).toThrow();
    expect(() =>
      api.validateAgentSyncVerifierPortResult(durable, request, {
        ...response,
        receipt: { ...check, configurationHash: sha256("other") }
      })
    ).toThrow();
  });
  test("publisher envelope rejects missing version and extras", () => {
    const { lease } = bound();
    expect(
      api.AgentSyncPublisherRequestSchema.safeParse({ operation: "publish", lease, requestId: "publish" }).success
    ).toBe(false);
  });
});

test("latest-head combined publication differs from private base and survives later head replay", () => {
  const { state: boundA, lease: leaseA } = bound();
  const b = api.reserveAgentSyncScope(boundA, control("reserve", 2), 1000, allocate);
  if (b.result.kind !== "granted") throw Error("expected second grant");
  const leaseB = b.result.lease;
  const base = b.state.acceptedVersion,
    contentHashes = { "other.ts": null },
    inputHashB = hashJson({
      planHash: b.state.plan.planHash,
      attemptId: leaseB.attemptId,
      baseVersion: base,
      contentHashes
    });
  const before = api.bindAgentSyncInput(
    b.state,
    {
      requestVersion: api.AGENT_SYNC_REQUEST_VERSION,
      operation: "bind",
      requestId: "bind-b",
      lease: leaseB,
      snapshot: { baseVersion: base, inputHash: inputHashB, contentHashes }
    },
    1000
  ).state;
  function formal(lease: api.AgentSyncLease, publicationBase: string, version: string, id: string) {
    const attempt = before.attempts.find((a) => a.attemptId === lease.attemptId)!;
    const check: api.AgentSyncCheckReceipt = {
      checkVersion: api.AGENT_SYNC_CHECK_VERSION,
      receiptId: `check-${id}`,
      attemptId: lease.attemptId,
      candidateHash: sha256(`combined-${id}`),
      checksHash: sha256("checks"),
      groups: ["types"],
      ...evidence(before),
      exitCode: 0,
      passed: true,
      baseVersion: publicationBase,
      version,
      sourceHashBefore: sha256("tree"),
      sourceHashAfter: sha256("tree")
    };
    const receipt = {
      publishVersion: api.AGENT_SYNC_PUBLISH_VERSION,
      receiptId: `receipt-${id}`,
      attemptId: lease.attemptId,
      requestId: id,
      checkReceiptId: check.receiptId,
      baseVersion: publicationBase,
      acceptedVersion: version,
      candidateHash: check.candidateHash,
      checksHash: check.checksHash,
      requestHash: api.agentSyncPublishRequestHash(before, lease, id),
      ownerEpoch: lease.ownerEpoch,
      leaseEpoch: lease.leaseEpoch,
      inputHash: attempt.inputHash!,
      overlayHash: hashJson({ attemptId: attempt.attemptId, baseVersion: attempt.baseVersion, files: [] }),
      ...evidence(before)
    };
    return { check, receipt };
  }
  const a = formal(leaseA, base, "c".repeat(40), "publish-a"),
    second = formal(leaseB, a.receipt.acceptedVersion, "d".repeat(40), "publish-b");
  const after = api.parseAgentSyncState({
    ...before,
    acceptedVersion: second.receipt.acceptedVersion,
    acceptedTasks: ["task0", "task2"],
    attempts: before.attempts.map((attempt) => ({ ...attempt, status: "completed" })),
    coordination: {
      ...before.coordination,
      locks: [],
      taskStates: { task0: "completed", task1: "pending", task2: "completed" }
    },
    checkReceipts: [a.check, second.check],
    publishReceipts: [a.receipt, second.receipt]
  });
  expect(second.receipt.baseVersion).not.toBe(after.attempts[1]!.baseVersion);
  const responseA = { status: "accepted" as const, receipt: a.receipt },
    responseB = { status: "accepted" as const, receipt: second.receipt };
  expect(api.validateAgentSyncPublisherPortResult(before, leaseB, "publish-b", responseB, after)).toEqual(responseB);
  expect(api.validateAgentSyncPublisherPortResult(after, leaseA, "publish-a", responseA, after)).toEqual(responseA);
  expect(() =>
    api.validateAgentSyncPublisherPortResult(before, leaseB, "publish-b", responseB, {
      ...after,
      checkReceipts: [a.check]
    })
  ).toThrow();
  expect(() =>
    api.validateAgentSyncPublisherPortResult(before, leaseB, "publish-b", responseB, {
      ...after,
      checkReceipts: [a.check, { ...second.check, passed: false, exitCode: 1 }]
    })
  ).toThrow();
  const branched = api.parseAgentSyncState({
    ...after,
    checkReceipts: [a.check, { ...second.check, baseVersion: base }],
    publishReceipts: [a.receipt, { ...second.receipt, baseVersion: base }]
  });
  expect(() =>
    api.validateAgentSyncPublisherPortResult(
      before,
      leaseB,
      "publish-b",
      { ...responseB, receipt: branched.publishReceipts[1]! },
      branched
    )
  ).toThrow(/acceptance|history/);
  expect(() =>
    api.validateAgentSyncPublisherPortResult(
      branched,
      leaseB,
      "publish-b",
      { ...responseB, receipt: branched.publishReceipts[1]! },
      branched
    )
  ).toThrow(/acceptance|history/);
});

test.each(["running", "completed-but-unaccepted", "accepted-but-paused"] as const)(
  "publisher rejects durable receipts without completed accepted state (%s)",
  (mode) => {
    const { before, after, lease, response } = publication(false);
    const invalid = api.parseAgentSyncState({
      ...after,
      acceptedTasks: mode === "accepted-but-paused" ? after.acceptedTasks : [],
      attempts:
        mode === "running"
          ? before.attempts
          : after.attempts.map((attempt) => ({
              ...attempt,
              status: mode === "accepted-but-paused" ? "paused" : "completed"
            })),
      coordination:
        mode === "running"
          ? before.coordination
          : {
              ...after.coordination,
              taskStates: {
                ...after.coordination.taskStates,
                [lease.taskId]: mode === "accepted-but-paused" ? "completed" : "paused"
              }
            }
    });
    if (mode === "running") {
      expect(invalid.attempts[0]!.status).toBe("running");
      expect(invalid.coordination.taskStates[lease.taskId]).toBe("running");
      expect(invalid.coordination.locks).toHaveLength(1);
      expect(api.validateAgentSyncLease(invalid, lease, invalid.coordination.lastNow)).toEqual({ valid: true });
    }
    expect(() => api.validateAgentSyncPublisherPortResult(before, lease, "publish", response, invalid)).toThrow(
      /acceptance/
    );
    // Completed historical publication remains valid even though the old lease has no current authority.
    expect(api.validateAgentSyncLease(after, lease, after.coordination.lastNow).valid).toBe(false);
    expect(api.validateAgentSyncPublisherPortResult(after, lease, "publish", response, after)).toEqual(response);
  }
);
