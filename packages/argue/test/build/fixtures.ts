import { freezeBuildPlan } from "../../src/build/contracts.js";
import { sha256 } from "../../src/peer/hash.js";

export function planInput() {
  return {
    buildSchemaVersion: 1,
    planVersion: "build-plan-v1",
    actionVersion: "build-action-v1",
    checkVersion: "build-check-v1",
    publishVersion: "build-publish-v1",
    resultVersion: "build-result-v1",
    projectKey: "todo-stats",
    memberIds: ["member-a", "member-b"],
    manifest: [
      { path: "SPEC.md", access: "read-only", contentHash: sha256("spec") },
      { path: "src/normalize.ts", access: "writable", contentHash: sha256("v0") },
      { path: "src/report.ts", access: "writable", contentHash: sha256("total") }
    ],
    tasks: [
      {
        taskId: "T-A",
        workerId: "member-a",
        scope: { read: ["SPEC.md"], write: ["src/normalize.ts"] },
        dependsOn: [] as string[],
        checkProfileId: "state-format"
      },
      {
        taskId: "T-B1",
        workerId: "member-b",
        scope: { read: ["SPEC.md"], write: ["src/report.ts"] },
        dependsOn: [] as string[],
        checkProfileId: "report"
      },
      {
        taskId: "T-B2",
        workerId: "member-b",
        scope: { read: ["SPEC.md"], write: ["src/normalize.ts"] },
        dependsOn: [] as string[],
        checkProfileId: "identity"
      }
    ],
    profiles: [
      { profileId: "common", groups: ["common"], checksHash: sha256("common") },
      { profileId: "state-format", groups: ["common", "state-format"], checksHash: sha256("state") },
      { profileId: "report", groups: ["common", "report"], checksHash: sha256("report") },
      { profileId: "identity", groups: ["common", "identity"], checksHash: sha256("identity") },
      {
        profileId: "final",
        groups: ["common", "state-format", "report", "identity", "final"],
        checksHash: sha256("final")
      }
    ],
    budget: {
      budgetVersion: "build-budget-v1",
      maxCallsPerTask: 12,
      maxOutputTokensPerCall: 4096,
      maxAllocatedOutputTokensPerTask: 49152,
      maxCalls: 36,
      maxAllocatedOutputTokens: 147456,
      callTimeoutMs: 120000,
      taskTimeoutMs: 900000,
      runTimeoutMs: 2700000
    }
  };
}
export function runInput() {
  const plan = freezeBuildPlan(planInput());
  return {
    buildSchemaVersion: 1,
    planVersion: "build-plan-v1",
    actionVersion: "build-action-v1",
    budgetVersion: "build-budget-v1",
    checkVersion: "build-check-v1",
    publishVersion: "build-publish-v1",
    resultVersion: "build-result-v1",
    projectKey: "todo-stats",
    runId: "run-1",
    revision: 0,
    ownerEpoch: 1,
    plan,
    acceptedVersion: "a".repeat(40),
    status: "active",
    startedAt: 1000,
    deadlineAt: 2701000,
    acceptedTasks: [],
    waiting: [],
    attempts: [],
    calls: [],
    actionReceipts: [],
    checkReceipts: [],
    publishReceipts: []
  };
}
