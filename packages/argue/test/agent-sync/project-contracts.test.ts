import { describe, expect, test } from "vitest";
import {
  AGENT_SYNC_PROJECT_VERSION,
  AGENT_SYNC_LEASE_VERSION,
  AGENT_SYNC_REQUEST_VERSION,
  AGENT_SYNC_CHECK_VERSION,
  AGENT_SYNC_TOOL_RECEIPT_VERSION,
  AgentSyncLeaseSchema,
  AgentSyncProjectSchema,
  AgentSyncCheckReceiptSchema,
  AgentSyncPublishReceiptSchema,
  AgentSyncWorkspaceRequestSchema,
  AgentSyncToolReceiptSchema,
  FrozenAgentSyncProjectSchema,
  AgentSyncStateSchema,
  createAgentSyncState,
  freezeAgentSyncProject,
  parseAgentSyncState
} from "../../src/agent-sync/project/index.js";
import {
  BuildIdSchema,
  BuildLeaseSchema,
  BuildCheckReceiptSchema,
  FrozenBuildPlanSchema,
  freezeBuildPlan
} from "../../src/build/contracts.js";
import { SyncIdSchema, SyncContentHashesSchema } from "../../src/agent-sync/kernel/primitives.js";
import { hashJson, sha256 } from "../../src/peer/hash.js";
import { planInput } from "../build/fixtures.js";

const h = sha256("content");
const version = "a".repeat(40);
function projectInput(count = 3) {
  return {
    projectVersion: AGENT_SYNC_PROJECT_VERSION,
    projectKey: "project",
    memberIds: Array.from({ length: count }, (_, i) => `worker${i}`),
    manifest: [
      { path: "SPEC.md", access: "read-only", contentHash: h },
      { path: "src/code.ts", access: "writable", contentHash: null }
    ],
    tasks: [
      {
        taskId: "implement",
        workerId: "worker0",
        scope: { read: ["SPEC.md"], write: ["src/code.ts"] },
        dependsOn: [] as string[],
        checkProfileId: "quality"
      }
    ],
    profiles: [{ profileId: "quality", checkIds: ["types", "tests"] }],
    finalProfileId: "quality",
    checkConfigurationHash: h
  };
}
function lease() {
  return {
    leaseVersion: AGENT_SYNC_LEASE_VERSION,
    projectKey: "project",
    runId: "run",
    planHash: freezeAgentSyncProject(projectInput()).planHash,
    attemptId: "attempt",
    taskId: "implement",
    workerId: "worker0",
    ownerEpoch: 1,
    leaseEpoch: 1,
    token: "secret"
  };
}
function check() {
  return {
    checkVersion: AGENT_SYNC_CHECK_VERSION,
    receiptId: "check",
    attemptId: "attempt",
    candidateHash: h,
    checksHash: h,
    groups: ["quality"],
    toolchainHash: h,
    isolationHash: h,
    configurationHash: h,
    programsHash: h,
    argumentsHash: h,
    exitCode: 0,
    passed: true,
    baseVersion: version,
    version,
    planHash: lease().planHash,
    imageDigest: h,
    sourceHashBefore: h,
    sourceHashAfter: h
  };
}

describe("independent project protocol", () => {
  test.each([1, 2, 3])("accepts %i arbitrary workers and host-defined checks", (count) => {
    const raw = projectInput(count);
    raw.profiles.push({ profileId: "acceptance", checkIds: ["types"] });
    raw.finalProfileId = "acceptance";
    const frozen = freezeAgentSyncProject(raw);
    expect(frozen.memberIds).toHaveLength(count);
    expect(frozen.resources.maxSessionRequests).toBe(4096);
    expect(FrozenAgentSyncProjectSchema.safeParse(frozen).success).toBe(true);
    expect("budget" in frozen).toBe(false);
  });
  test("copies caller data, normalizes scopes and binds every definition field in hash", () => {
    const raw = projectInput();
    raw.tasks[0]!.scope.read.push("src/code.ts", "SPEC.md");
    const before = structuredClone(raw);
    const frozen = freezeAgentSyncProject(raw);
    expect(raw).toEqual(before);
    expect(frozen.tasks[0]!.scope.read).toEqual(["SPEC.md"]);
    expect(Object.isFrozen(frozen.tasks[0]!.scope.read)).toBe(true);
    raw.tasks[0]!.scope.read.length = 0;
    expect(frozen.tasks[0]!.scope.read).toEqual(["SPEC.md"]);
    expect(
      FrozenAgentSyncProjectSchema.safeParse({ ...frozen, checkConfigurationHash: sha256("changed") }).success
    ).toBe(false);
    expect(
      FrozenAgentSyncProjectSchema.safeParse({ ...frozen, resources: { ...frozen.resources, maxSessionRequests: 1 } })
        .success
    ).toBe(false);
  });
  test.each([
    [
      "unknown worker",
      (p: ReturnType<typeof projectInput>) => {
        p.tasks[0]!.workerId = "absent";
      }
    ],
    [
      "unknown profile",
      (p: ReturnType<typeof projectInput>) => {
        p.tasks[0]!.checkProfileId = "absent";
      }
    ],
    [
      "unknown final profile",
      (p: ReturnType<typeof projectInput>) => {
        p.finalProfileId = "absent";
      }
    ],
    [
      "unknown dependency",
      (p: ReturnType<typeof projectInput>) => {
        p.tasks[0]!.dependsOn = ["absent"];
      }
    ],
    [
      "self dependency",
      (p: ReturnType<typeof projectInput>) => {
        p.tasks[0]!.dependsOn = ["implement"];
      }
    ],
    [
      "missing checks",
      (p: ReturnType<typeof projectInput>) => {
        p.profiles[0]!.checkIds = [];
      }
    ],
    [
      "duplicate check",
      (p: ReturnType<typeof projectInput>) => {
        p.profiles[0]!.checkIds.push("types");
      }
    ],
    [
      "case alias",
      (p: ReturnType<typeof projectInput>) => {
        p.manifest.push({ path: "spec.md", access: "writable", contentHash: null });
      }
    ],
    [
      "file directory alias",
      (p: ReturnType<typeof projectInput>) => {
        p.manifest.push({ path: "SRC", access: "writable", contentHash: null });
      }
    ],
    [
      "directory case alias",
      (p: ReturnType<typeof projectInput>) => {
        p.manifest.push({ path: "Src/other.ts", access: "writable", contentHash: null });
      }
    ],
    [
      "path alias",
      (p: ReturnType<typeof projectInput>) => {
        p.manifest[0]!.path = "src/../SPEC.md";
      }
    ],
    [
      "missing readonly",
      (p: ReturnType<typeof projectInput>) => {
        p.manifest[0]!.contentHash = null;
      }
    ]
  ] as const)("rejects %s", (_name, mutate) => {
    const p = projectInput();
    mutate(p);
    expect(AgentSyncProjectSchema.safeParse(p).success).toBe(false);
  });
  test("rejects cycles, nonwritable scope, undeclared scope, model fields and oversized resources", () => {
    const p = projectInput();
    p.tasks.push({ ...p.tasks[0]!, taskId: "second", dependsOn: ["implement"] });
    p.tasks[0]!.dependsOn.push("second");
    expect(AgentSyncProjectSchema.safeParse(p).success).toBe(false);
    for (const write of [["SPEC.md"], ["absent.ts"]])
      expect(
        AgentSyncProjectSchema.safeParse({
          ...projectInput(),
          tasks: [{ ...projectInput().tasks[0], scope: { read: [], write } }]
        }).success
      ).toBe(false);
    for (const extra of [
      { budget: {} },
      { resources: { maxCalls: 1 } },
      { resources: { taskTimeoutMs: 900001 } },
      { resources: { checkTimeoutMs: 2, taskTimeoutMs: 1 } },
      { resources: { maxSessionRequests: 10001 } }
    ])
      expect(AgentSyncProjectSchema.safeParse({ ...projectInput(), ...extra }).success).toBe(false);
  });
  test("shares primitive identity and preserves own __proto__ paths", () => {
    expect(BuildIdSchema).toBe(SyncIdSchema);
    const hashes = SyncContentHashesSchema.parse(JSON.parse('{"__proto__":null}'));
    expect(Object.hasOwn(hashes, "__proto__")).toBe(true);
  });
  test("legacy fixed plan, budget and cross-format boundaries remain closed", () => {
    const legacy = freezeBuildPlan(planInput());
    expect(FrozenBuildPlanSchema.safeParse(legacy).success).toBe(true);
    expect(FrozenAgentSyncProjectSchema.safeParse(legacy).success).toBe(false);
    expect(FrozenBuildPlanSchema.safeParse(freezeAgentSyncProject(projectInput())).success).toBe(false);
    expect(() => freezeBuildPlan({ ...planInput(), memberIds: ["worker0", "worker1"] })).toThrow();
    expect(() =>
      freezeBuildPlan({ ...planInput(), profiles: [{ profileId: "quality", checkIds: ["types"] }] })
    ).toThrow();
    expect(() => freezeBuildPlan({ ...planInput(), budget: { ...planInput().budget, maxCalls: 37 } })).toThrow();
    const l = lease();
    expect(AgentSyncLeaseSchema.safeParse(l).success).toBe(true);
    expect(BuildLeaseSchema.safeParse(l).success).toBe(false);
    expect(
      AgentSyncLeaseSchema.safeParse({
        attemptId: "attempt",
        taskId: "implement",
        workerId: "member-a",
        ownerEpoch: 1,
        leaseEpoch: 1,
        token: "x"
      }).success
    ).toBe(false);
    expect(BuildCheckReceiptSchema.safeParse(check()).success).toBe(false);
    expect(AgentSyncCheckReceiptSchema.safeParse({ ...check(), checkVersion: "build-check-v1" }).success).toBe(false);
  });
  test("requires complete isolated receipt evidence and coherent success", () => {
    expect(AgentSyncCheckReceiptSchema.safeParse(check()).success).toBe(true);
    for (const field of ["configurationHash", "programsHash", "argumentsHash", "version", "planHash", "imageDigest"]) {
      const raw: Record<string, unknown> = { ...check() };
      delete raw[field];
      expect(AgentSyncCheckReceiptSchema.safeParse(raw).success).toBe(false);
    }
    expect(AgentSyncCheckReceiptSchema.safeParse({ ...check(), exitCode: 1 }).success).toBe(false);
    expect(AgentSyncCheckReceiptSchema.safeParse({ ...check(), sourceHashAfter: sha256("mutation") }).success).toBe(
      false
    );
    expect(AgentSyncPublishReceiptSchema.safeParse({ publishVersion: "agent-sync-publish-v1" }).success).toBe(false);
  });
  test("workspace envelopes reject ambiguous text and mismatched tool operation identity", () => {
    const request = {
      requestVersion: AGENT_SYNC_REQUEST_VERSION,
      operation: "edit",
      requestId: "edit",
      lease: lease(),
      edits: [{ path: "src/code.ts", text: "ok", expectedContentHash: null }]
    };
    expect(AgentSyncWorkspaceRequestSchema.safeParse(request).success).toBe(true);
    for (const text of ["\0", "\ud800", "x".repeat(1048577)])
      expect(
        AgentSyncWorkspaceRequestSchema.safeParse({ ...request, edits: [{ ...request.edits[0], text }] }).success
      ).toBe(false);
    expect(
      AgentSyncWorkspaceRequestSchema.safeParse({ ...request, edits: [...request.edits, ...request.edits] }).success
    ).toBe(false);
    const result = { kind: "frozen", baseVersion: version, inputHash: h, contentHashes: {} };
    const receipt = {
      operation: "freeze",
      outputHash: hashJson(result),
      receiptVersion: AGENT_SYNC_TOOL_RECEIPT_VERSION,
      requestId: "edit",
      attemptId: "attempt",
      requestHash: h,
      request,
      result
    };
    expect(AgentSyncToolReceiptSchema.safeParse(receipt).success).toBe(false);
    const freeze = { ...request, operation: "freeze", edits: undefined };
    delete freeze.edits;
    expect(AgentSyncToolReceiptSchema.safeParse({ ...receipt, request: freeze }).success).toBe(true);
    expect(AgentSyncToolReceiptSchema.safeParse({ ...receipt, request: freeze, attemptId: "different" }).success).toBe(
      false
    );
  });
  test("initializes exact generic task state and rejects identity/map/unknown field corruption", () => {
    const project = freezeAgentSyncProject(projectInput());
    const state = createAgentSyncState({ project, runId: "run", acceptedVersion: version, now: 100 });
    expect(state.coordination.taskStates).toEqual({ implement: "pending" });
    expect(state.coordination.taskEpochs).toEqual({ implement: 0 });
    expect(state.deadlineAt).toBe(100 + project.resources.runTimeoutMs);
    expect(Object.isFrozen(state.coordination)).toBe(true);
    expect(parseAgentSyncState(state)).toEqual(state);
    for (const mutation of [
      { projectKey: "other" },
      { calls: [] },
      { coordination: { ...state.coordination, taskStates: {} } },
      { acceptedTasks: ["absent"] }
    ])
      expect(AgentSyncStateSchema.safeParse({ ...state, ...mutation }).success).toBe(false);
    expect(() =>
      createAgentSyncState({ project, runId: "run", acceptedVersion: version, now: Number.MAX_SAFE_INTEGER })
    ).toThrow();
    const attempt = {
      attemptId: "attempt",
      taskId: "implement",
      workerId: "absent",
      token: "x",
      ownerEpoch: 1,
      leaseEpoch: 1,
      baseVersion: version,
      inputHash: null,
      contentHashes: {},
      startedAt: 100,
      deadlineAt: 200,
      status: "running"
    };
    expect(AgentSyncStateSchema.safeParse({ ...state, attempts: [attempt] }).success).toBe(false);
    expect(AgentSyncStateSchema.safeParse({ ...state, checkReceipts: [check()] }).success).toBe(false);
  });
});

test("raw state rejects conflicting receipt IDs across check and publication evidence", () => {
  const project = freezeAgentSyncProject(projectInput());
  const initial = createAgentSyncState({ project, runId: "run", acceptedVersion: version, now: 100 });
  const inputHash = sha256("input");
  const overlayHash = hashJson({ attemptId: "attempt", baseVersion: version, files: [] });
  const candidateHash = sha256("candidate");
  const attempt = {
    attemptId: "attempt",
    taskId: "implement",
    workerId: "worker0",
    token: "secret",
    ownerEpoch: 1,
    leaseEpoch: 1,
    baseVersion: version,
    inputHash,
    contentHashes: { "SPEC.md": h, "src/code.ts": null },
    startedAt: 100,
    deadlineAt: 200,
    status: "completed"
  };
  const candidate = {
    candidateVersion: "agent-sync-candidate-v1",
    attemptId: "attempt",
    baseVersion: version,
    version,
    overlayHash,
    candidateHash
  };
  const checkReceipt = { ...check(), groups: ["types", "tests"], candidateHash };
  const publish = {
    publishVersion: "agent-sync-publish-v1",
    receiptId: "publish",
    attemptId: "attempt",
    requestId: "publish-request",
    checkReceiptId: "check",
    baseVersion: version,
    acceptedVersion: version,
    candidateHash,
    checksHash: h,
    requestHash: h,
    planHash: project.planHash,
    ownerEpoch: 1,
    leaseEpoch: 1,
    inputHash,
    overlayHash,
    toolchainHash: h,
    isolationHash: h,
    imageDigest: h,
    configurationHash: h,
    programsHash: h,
    argumentsHash: h
  };
  const state = {
    ...initial,
    acceptedTasks: ["implement"],
    attempts: [attempt],
    workspace: { workspaceVersion: "agent-sync-workspace-v1", staging: [], candidates: [candidate], toolReceipts: [] },
    checkReceipts: [checkReceipt],
    publishReceipts: [publish]
  };
  expect(AgentSyncStateSchema.safeParse(state).success).toBe(true);
  expect(
    AgentSyncStateSchema.safeParse({ ...state, publishReceipts: [{ ...publish, receiptId: "check" }] }).success
  ).toBe(false);
  expect(
    AgentSyncStateSchema.safeParse({
      ...state,
      checkReceipts: [{ ...checkReceipt, configurationHash: sha256("changed host config") }]
    }).success
  ).toBe(false);
  expect(
    AgentSyncStateSchema.safeParse({
      ...state,
      publishReceipts: [{ ...publish, argumentsHash: sha256("changed args") }]
    }).success
  ).toBe(false);
  expect(
    AgentSyncStateSchema.safeParse({ ...state, checkReceipts: [{ ...checkReceipt, version: "b".repeat(40) }] }).success
  ).toBe(false);
  expect(
    AgentSyncStateSchema.safeParse({ ...state, checkReceipts: [{ ...checkReceipt, groups: ["quality"] }] }).success
  ).toBe(false);
});

function rebasedPublicationState() {
  const raw = projectInput(2);
  raw.manifest.push({ path: "src/other.ts", access: "writable", contentHash: null });
  raw.tasks.push({
    ...raw.tasks[0]!,
    taskId: "other",
    workerId: "worker1",
    scope: { read: ["SPEC.md"], write: ["src/other.ts"] }
  });
  const project = freezeAgentSyncProject(raw);
  const originalBase = "a".repeat(40);
  const previousAccepted = "b".repeat(40);
  const privateVersion = "c".repeat(40);
  const publishedVersion = "d".repeat(40);
  const otherPrivateVersion = "e".repeat(40);
  const initial = createAgentSyncState({ project, runId: "run", acceptedVersion: originalBase, now: 100 });
  const attempt = {
    attemptId: "attempt",
    taskId: "implement",
    workerId: "worker0",
    token: "secret",
    ownerEpoch: 1,
    leaseEpoch: 1,
    baseVersion: originalBase,
    inputHash: sha256("input"),
    contentHashes: { "SPEC.md": h, "src/code.ts": null },
    startedAt: 100,
    deadlineAt: 300,
    status: "completed"
  };
  const otherAttempt = {
    ...attempt,
    attemptId: "other-attempt",
    taskId: "other",
    workerId: "worker1",
    contentHashes: { "SPEC.md": h, "src/other.ts": null }
  };
  const originalStaging = {
    attemptId: "attempt",
    baseVersion: originalBase,
    files: [{ path: "src/code.ts", blobId: "f".repeat(40), contentHash: h }]
  };
  const otherStaging = {
    attemptId: "other-attempt",
    baseVersion: originalBase,
    files: [{ path: "src/other.ts", blobId: "f".repeat(40), contentHash: h }]
  };
  const privateCandidate = {
    candidateVersion: "agent-sync-candidate-v1",
    attemptId: "attempt",
    baseVersion: originalBase,
    version: privateVersion,
    overlayHash: hashJson(originalStaging),
    candidateHash: sha256("private candidate")
  };
  const otherPrivate = {
    ...privateCandidate,
    attemptId: "other-attempt",
    version: otherPrivateVersion,
    overlayHash: hashJson(otherStaging),
    candidateHash: sha256("other private candidate")
  };
  const privateCheck = {
    ...check(),
    receiptId: "private-check",
    groups: ["types", "tests"],
    planHash: project.planHash,
    version: privateVersion,
    candidateHash: privateCandidate.candidateHash
  };
  const formalCheck = {
    ...privateCheck,
    receiptId: "formal-check",
    baseVersion: previousAccepted,
    version: publishedVersion,
    candidateHash: sha256("combined candidate on latest head")
  };
  const otherCheck = {
    ...privateCheck,
    receiptId: "other-check",
    attemptId: "other-attempt",
    version: previousAccepted,
    candidateHash: sha256("other formal candidate")
  };
  const publish = {
    publishVersion: "agent-sync-publish-v1",
    receiptId: "publish",
    attemptId: "attempt",
    requestId: "publish-request",
    checkReceiptId: "formal-check",
    baseVersion: previousAccepted,
    acceptedVersion: publishedVersion,
    candidateHash: formalCheck.candidateHash,
    checksHash: formalCheck.checksHash,
    requestHash: h,
    planHash: project.planHash,
    ownerEpoch: 1,
    leaseEpoch: 1,
    inputHash: attempt.inputHash,
    overlayHash: privateCandidate.overlayHash,
    toolchainHash: h,
    isolationHash: h,
    imageDigest: h,
    configurationHash: h,
    programsHash: h,
    argumentsHash: h
  };
  const otherPublish = {
    ...publish,
    receiptId: "other-publish",
    attemptId: "other-attempt",
    requestId: "other-publish-request",
    checkReceiptId: "other-check",
    baseVersion: originalBase,
    acceptedVersion: previousAccepted,
    candidateHash: otherCheck.candidateHash,
    overlayHash: otherPrivate.overlayHash
  };
  return {
    ...initial,
    status: "completed",
    acceptedVersion: publishedVersion,
    acceptedTasks: ["other", "implement"],
    attempts: [attempt, otherAttempt],
    coordination: {
      ...initial.coordination,
      taskEpochs: { implement: 1, other: 1 },
      taskStates: { implement: "completed", other: "completed" }
    },
    workspace: {
      workspaceVersion: "agent-sync-workspace-v1",
      staging: [
        { ...originalStaging, overlayHash: privateCandidate.overlayHash },
        { ...otherStaging, overlayHash: otherPrivate.overlayHash }
      ],
      candidates: [privateCandidate, otherPrivate],
      toolReceipts: []
    },
    checkReceipts: [privateCheck, otherCheck, formalCheck],
    publishReceipts: [otherPublish, publish]
  };
}

test("formal publication can rebuild the original private overlay on a newer accepted head", () => {
  const state = rebasedPublicationState();
  expect(
    new Set([
      state.attempts[0]!.baseVersion,
      state.publishReceipts[1]!.baseVersion,
      state.workspace.candidates[0]!.version,
      state.publishReceipts[1]!.acceptedVersion
    ]).size
  ).toBe(4);
  expect(AgentSyncStateSchema.safeParse(state).success).toBe(true);
});

test("formal publication still binds its own successful check and original overlay evidence", () => {
  const state = rebasedPublicationState();
  const formal = state.checkReceipts[2]!;
  const published = state.publishReceipts[1]!;
  const corruptCheck = (change: Record<string, unknown>) => ({
    ...state,
    checkReceipts: [state.checkReceipts[0], state.checkReceipts[1], { ...formal, ...change }]
  });
  const corruptPublish = (change: Record<string, unknown>) => ({
    ...state,
    publishReceipts: [state.publishReceipts[0], { ...published, ...change }]
  });
  for (const change of [
    { attemptId: "other-attempt" },
    { baseVersion: "f".repeat(40) },
    { version: "f".repeat(40) },
    { candidateHash: sha256("forged candidate") },
    { checksHash: sha256("different checks") },
    { passed: false, exitCode: 1 },
    { planHash: sha256("different project") },
    { configurationHash: sha256("different configuration") },
    { programsHash: sha256("different programs") },
    { argumentsHash: sha256("different arguments") }
  ])
    expect(AgentSyncStateSchema.safeParse(corruptCheck(change)).success).toBe(false);
  for (const change of [
    { attemptId: "other-attempt" },
    { checkReceiptId: "private-check" },
    { baseVersion: "f".repeat(40) },
    { acceptedVersion: "f".repeat(40) },
    { candidateHash: sha256("different candidate") },
    { checksHash: sha256("different checks") },
    { overlayHash: sha256("different overlay") },
    { planHash: sha256("different project") },
    { inputHash: sha256("different input") },
    { ownerEpoch: 2 },
    { leaseEpoch: 2 },
    { toolchainHash: sha256("different toolchain") },
    { isolationHash: sha256("different isolation") },
    { imageDigest: sha256("different image") },
    { configurationHash: sha256("different configuration") },
    { programsHash: sha256("different programs") },
    { argumentsHash: sha256("different arguments") }
  ])
    expect(AgentSyncStateSchema.safeParse(corruptPublish(change)).success).toBe(false);
  const privateCheck = state.checkReceipts[0]!;
  for (const change of [
    { baseVersion: "b".repeat(40) },
    { version: "d".repeat(40) },
    { candidateHash: formal.candidateHash }
  ])
    expect(
      AgentSyncStateSchema.safeParse({
        ...state,
        checkReceipts: [{ ...privateCheck, ...change }, ...state.checkReceipts.slice(1)]
      }).success
    ).toBe(false);
});

test("formal publication accepts direct frozen staging without any private seal", () => {
  const original = rebasedPublicationState();
  const state = {
    ...original,
    checkReceipts: original.checkReceipts.slice(1),
    workspace: { ...original.workspace, candidates: [] }
  };
  expect(AgentSyncStateSchema.safeParse(state).success).toBe(true);
  const published = state.publishReceipts[1]!;
  expect(
    AgentSyncStateSchema.safeParse({
      ...state,
      publishReceipts: [state.publishReceipts[0], { ...published, overlayHash: sha256("unrelated overlay") }]
    }).success
  ).toBe(false);
  for (const change of [{ baseVersion: "b".repeat(40) }, { overlayHash: sha256("forged staged overlay") }])
    expect(
      AgentSyncStateSchema.safeParse({
        ...state,
        workspace: {
          ...state.workspace,
          staging: [{ ...state.workspace.staging[0], ...change }, state.workspace.staging[1]]
        }
      }).success
    ).toBe(false);
  const forged = sha256("forged in both receipt and staging");
  expect(
    AgentSyncStateSchema.safeParse({
      ...state,
      workspace: {
        ...state.workspace,
        staging: [{ ...state.workspace.staging[0], overlayHash: forged }, state.workspace.staging[1]]
      },
      publishReceipts: [state.publishReceipts[0], { ...published, overlayHash: forged }]
    }).success
  ).toBe(false);
  expect(AgentSyncStateSchema.safeParse({ ...state, checkReceipts: original.checkReceipts }).success).toBe(false);
});

test("formal publication accepts the canonical empty overlay when staging and seal are absent", () => {
  const original = rebasedPublicationState();
  const state = {
    ...original,
    checkReceipts: original.checkReceipts.slice(1),
    workspace: { ...original.workspace, staging: [], candidates: [] },
    publishReceipts: original.publishReceipts.map((receipt) => ({
      ...receipt,
      overlayHash: hashJson({
        attemptId: receipt.attemptId,
        baseVersion: original.attempts.find((attempt) => attempt.attemptId === receipt.attemptId)!.baseVersion,
        files: []
      })
    }))
  };
  expect(AgentSyncStateSchema.safeParse(state).success).toBe(true);
  const published = state.publishReceipts[1]!;
  for (const overlayHash of [
    sha256("arbitrary empty overlay"),
    hashJson({ attemptId: published.attemptId, baseVersion: published.baseVersion, files: [] }),
    hashJson({ attemptId: "other-attempt", baseVersion: original.attempts[0]!.baseVersion, files: [] })
  ])
    expect(
      AgentSyncStateSchema.safeParse({
        ...state,
        publishReceipts: [state.publishReceipts[0], { ...published, overlayHash }]
      }).success
    ).toBe(false);
});
