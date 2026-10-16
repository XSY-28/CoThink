import { describe, expect, test } from "vitest";
import { BuildPlanSchema, BuildRunSchema, freezeBuildPlan, parseBuildRun } from "../../src/build/contracts.js";
import { hashJson, sha256 } from "../../src/peer/hash.js";

import { planInput, runInput } from "./fixtures.js";

describe("build plan rejection before any model or file action", () => {
  test("freezes normalized scopes and profiles without mutating caller data", () => {
    const raw = planInput();
    raw.tasks[0]!.scope.read.push("SPEC.md", "src/normalize.ts");
    raw.tasks[0]!.scope.write.push("src/normalize.ts");
    const before = structuredClone(raw);
    const plan = freezeBuildPlan(raw);
    expect(plan.tasks[0]!.scope).toEqual({ read: ["SPEC.md"], write: ["src/normalize.ts"] });
    expect(raw).toEqual(before);
    expect(Object.isFrozen(plan.tasks[0]!.scope.write)).toBe(true);
    expect(Object.isFrozen(plan.profiles[0])).toBe(true);
    const { planHash, ...definition } = plan;
    expect(planHash).toBe(hashJson(definition));
    raw.profiles[0]!.groups.push("report");
    expect(plan.profiles[0]!.groups).toEqual(["common"]);
    expect(() => Object.defineProperty(plan.tasks[0]!.scope.write, "0", { value: "SPEC.md" })).toThrow();
  });
  test("scope duplicates do not change normalized plan hash; material changes do", () => {
    const raw = planInput();
    const original = freezeBuildPlan(raw);
    raw.tasks[0]!.scope.read.push("SPEC.md", "src/normalize.ts");
    expect(freezeBuildPlan(raw).planHash).toBe(original.planHash);
    raw.profiles[0]!.checksHash = sha256("changed host oracle");
    expect(freezeBuildPlan(raw).planHash).not.toBe(original.planHash);
  });
  test.each(["buildSchemaVersion", "planVersion", "actionVersion", "checkVersion", "publishVersion", "resultVersion"])(
    "rejects mixed %s",
    (field) => {
      expect(() => freezeBuildPlan({ ...planInput(), [field]: "discussion-v1" })).toThrow();
    }
  );
  test.each([
    ["duplicate tasks", (p: ReturnType<typeof planInput>) => p.tasks.push(p.tasks[0]!)],
    [
      "duplicate members",
      (p: ReturnType<typeof planInput>) => {
        p.memberIds[1] = "member-a";
      }
    ],
    [
      "unknown member",
      (p: ReturnType<typeof planInput>) => {
        p.tasks[0]!.workerId = "member-c";
      }
    ],
    ["third member", (p: ReturnType<typeof planInput>) => p.memberIds.push("member-c")],
    ["unknown read", (p: ReturnType<typeof planInput>) => p.tasks[0]!.scope.read.push("secret.env")],
    ["case alias scope", (p: ReturnType<typeof planInput>) => p.tasks[0]!.scope.read.push("spec.md")],
    ["unknown write", (p: ReturnType<typeof planInput>) => p.tasks[0]!.scope.write.push("src/new.ts")],
    ["write read-only", (p: ReturnType<typeof planInput>) => p.tasks[0]!.scope.write.push("SPEC.md")],
    ["duplicate manifest", (p: ReturnType<typeof planInput>) => p.manifest.push(p.manifest[0]!)],
    [
      "case alias manifest",
      (p: ReturnType<typeof planInput>) => p.manifest.push({ ...p.manifest[0]!, path: "spec.md" })
    ],
    ["self dependency", (p: ReturnType<typeof planInput>) => p.tasks[0]!.dependsOn.push("T-A")],
    ["unknown dependency", (p: ReturnType<typeof planInput>) => p.tasks[0]!.dependsOn.push("missing")],
    ["duplicate dependency", (p: ReturnType<typeof planInput>) => p.tasks[2]!.dependsOn.push("T-A", "T-A")],
    [
      "dependency cycle",
      (p: ReturnType<typeof planInput>) => {
        p.tasks[0]!.dependsOn.push("T-B2");
        p.tasks[2]!.dependsOn.push("T-A");
      }
    ],
    [
      "unknown profile",
      (p: ReturnType<typeof planInput>) => {
        p.tasks[0]!.checkProfileId = "shell";
      }
    ],
    ["duplicate profile", (p: ReturnType<typeof planInput>) => p.profiles.push(p.profiles[0]!)],
    [
      "missing common",
      (p: ReturnType<typeof planInput>) => {
        p.profiles[1]!.groups = ["state-format"];
      }
    ],
    [
      "missing final regressions",
      (p: ReturnType<typeof planInput>) => {
        p.profiles[4]!.groups = ["common", "final"];
      }
    ],
    ["unknown group", (p: ReturnType<typeof planInput>) => p.profiles[0]!.groups.push("shell")],
    ["duplicate group", (p: ReturnType<typeof planInput>) => p.profiles[0]!.groups.push("common")],
    [
      "missing profile hash",
      (p: ReturnType<typeof planInput>) => {
        p.profiles[0]!.checksHash = "";
      }
    ]
  ] as const)("rejects %s", (_label, mutate) => {
    const p = planInput();
    mutate(p);
    expect(() => freezeBuildPlan(p)).toThrow();
  });
  test.each([
    "/tmp/a",
    "../a",
    "src/../a",
    "src//a",
    "./src/a",
    "src\\a",
    "src/a/",
    ".git/config",
    "src/.env",
    "src/Ａ.ts",
    "src/a."
  ])("rejects noncanonical path %s", (path) => {
    const p = planInput();
    p.manifest[1]!.path = path;
    expect(() => freezeBuildPlan(p)).toThrow();
  });
  test("permits declared new text files and real acyclic prerequisites", () => {
    const p = planInput();
    const raw = { ...p, manifest: [...p.manifest, { path: "src/new.ts", access: "writable", contentHash: null }] };
    raw.tasks[0]!.scope.write.push("src/new.ts");
    raw.tasks[2]!.dependsOn.push("T-A");
    expect(freezeBuildPlan(raw).tasks[2]!.dependsOn).toEqual(["T-A"]);
  });
  test.each([null, [], "plan", { ...planInput(), shell: "rm -rf /" }])("rejects malformed plan %#", (raw) =>
    expect(() => BuildPlanSchema.parse(raw)).toThrow()
  );
  test.each([
    "maxCallsPerTask",
    "maxOutputTokensPerCall",
    "maxAllocatedOutputTokensPerTask",
    "maxCalls",
    "maxAllocatedOutputTokens",
    "callTimeoutMs",
    "taskTimeoutMs",
    "runTimeoutMs"
  ])("enforces finite positive safe-integer bounded %s", (field) => {
    for (const value of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "12", null]) {
      const raw = planInput();
      expect(() => freezeBuildPlan({ ...raw, budget: { ...raw.budget, [field]: value } })).toThrow();
    }
    const raw = planInput();
    const cap = raw.budget[field as keyof typeof raw.budget] as number;
    expect(() => freezeBuildPlan({ ...raw, budget: { ...raw.budget, [field]: cap + 1 } })).toThrow();
  });
  test("allows tightening; rejects mixed budget, incoherent deadline or per-task/run bounds", () => {
    const raw = planInput();
    raw.budget.maxCalls = 30;
    expect(freezeBuildPlan(raw).budget.maxCalls).toBe(30);
    for (const budget of [
      { ...raw.budget, budgetVersion: "discussion-budget-v1" },
      { ...raw.budget, runTimeoutMs: 10 },
      { ...raw.budget, maxCalls: 1 },
      { ...raw.budget, maxAllocatedOutputTokens: 100 }
    ])
      expect(() => freezeBuildPlan({ ...raw, budget })).toThrow();
  });
});

describe("build run format stays separate from discussion and future lifecycle", () => {
  test("parses, copies and recursively freezes an empty run", () => {
    const raw = runInput();
    const run = parseBuildRun(raw);
    expect(run).toEqual(raw);
    expect(Object.isFrozen(run.attempts)).toBe(true);
  });
  test.each([
    { schemaVersion: 2, promptVersion: "peer-v6" },
    { ...runInput(), revision: -1 },
    { ...runInput(), ownerEpoch: 0 },
    { ...runInput(), projectKey: "another-project" },
    { ...runInput(), budgetVersion: "build-budget-v2" },
    { ...runInput(), acceptedVersion: "HEAD" },
    { ...runInput(), acceptedTasks: ["unknown"] },
    { ...runInput(), acceptedTasks: ["T-A", "T-A"] },
    { ...runInput(), deadlineAt: 2701001 },
    { ...runInput(), calls: [{ callId: "call-1", taskId: "T-A", allocatedOutputTokens: 5000 }] },
    { ...runInput(), waiting: [{ taskId: "unknown", sequence: 1 }] }
  ])("rejects invalid run %#", (raw) => expect(() => BuildRunSchema.parse(raw)).toThrow());
  test("rejects modified frozen plan and nested protocol version", () => {
    const raw = runInput();
    const altered = {
      ...raw,
      plan: {
        ...raw.plan,
        tasks: [
          { ...raw.plan.tasks[0]!, scope: { read: ["SPEC.md"], write: ["src/normalize.ts", "src/report.ts"] } },
          ...raw.plan.tasks.slice(1)
        ]
      }
    };
    expect(() => parseBuildRun(altered)).toThrow();
    const next = runInput();
    expect(() => parseBuildRun({ ...next, checkReceipts: [{ checkVersion: "build-check-v2" }] })).toThrow();
  });
});

describe("persisted allocation and attempt contract boundaries", () => {
  const populated = () => {
    const raw = runInput();
    const attempt = {
      attemptId: "attempt-1",
      taskId: "T-A",
      workerId: "member-a",
      ownerEpoch: 1,
      token: "host-token",
      baseVersion: "a".repeat(40),
      inputHash: sha256("input"),
      contentHashes: { "SPEC.md": sha256("spec"), "src/normalize.ts": sha256("v0") },
      startedAt: 1000,
      deadlineAt: 901000,
      status: "running"
    };
    const call = {
      callId: "call-1",
      taskId: "T-A",
      attemptId: "attempt-1",
      inputHash: sha256("input"),
      allocatedOutputTokens: 4096,
      reservedAt: 1000,
      deadlineAt: 121000,
      status: "unknown"
    };
    return { ...raw, attempts: [attempt], calls: [call] };
  };
  test("valid attempt and failed/unknown reservations retain their entire allocation", () => {
    const raw = populated();
    raw.calls = Array.from({ length: 12 }, (_, i) => ({
      ...raw.calls[0]!,
      callId: `call-${i}`,
      status: i % 2 ? "failed" : "unknown"
    }));
    expect(parseBuildRun(raw).calls).toHaveLength(12);
    expect(() =>
      parseBuildRun({ ...raw, calls: [...raw.calls, { ...raw.calls[0]!, callId: "call-extra" }] })
    ).toThrow();
    const tightened = planInput();
    tightened.budget.maxAllocatedOutputTokensPerTask = 4096;
    expect(() => parseBuildRun({ ...raw, plan: freezeBuildPlan(tightened) })).toThrow();
  });
  test.each(["workerId", "taskId", "ownerEpoch", "contentHashes", "deadlineAt"])(
    "rejects malformed attempt %s",
    (field) => {
      const raw = populated();
      const values: Record<string, unknown> = {
        workerId: "member-b",
        taskId: "missing",
        ownerEpoch: 2,
        contentHashes: { "SPEC.md": sha256("spec") },
        deadlineAt: 901001
      };
      expect(() => parseBuildRun({ ...raw, attempts: [{ ...raw.attempts[0], [field]: values[field] }] })).toThrow();
    }
  );
  test.each(["callId", "inputHash", "attemptId", "deadlineAt", "allocatedOutputTokens"])(
    "rejects bad model allocation %s",
    (field) => {
      const raw = populated();
      const values: Record<string, unknown> = {
        callId: "",
        inputHash: sha256("wrong input"),
        attemptId: "missing",
        deadlineAt: 121001,
        allocatedOutputTokens: 4097
      };
      expect(() => parseBuildRun({ ...raw, calls: [{ ...raw.calls[0], [field]: values[field] }] })).toThrow();
    }
  );
  test("rejects duplicate call IDs, unknown receipt attempts and duplicate waiting sequence", () => {
    const raw = populated();
    expect(() => parseBuildRun({ ...raw, calls: [...raw.calls, raw.calls[0]] })).toThrow();
    expect(() =>
      parseBuildRun({
        ...raw,
        waiting: [
          { taskId: "T-A", sequence: 0 },
          { taskId: "T-B2", sequence: 0 }
        ]
      })
    ).toThrow();
    const receipt = {
      requestId: "tool-1",
      attemptId: "missing",
      inputHash: sha256("input"),
      payloadHash: sha256("action"),
      kind: "inspect",
      status: "succeeded",
      outputHash: sha256("file")
    };
    expect(() => parseBuildRun({ ...raw, actionReceipts: [receipt] })).toThrow();
  });
  test("all run versions are strict and unknown authority fields are rejected", () => {
    const raw = populated();
    for (const field of [
      "buildSchemaVersion",
      "planVersion",
      "actionVersion",
      "budgetVersion",
      "checkVersion",
      "publishVersion",
      "resultVersion"
    ])
      expect(() => parseBuildRun({ ...raw, [field]: "peer-v5" })).toThrow();
    expect(() => parseBuildRun({ ...raw, shell: "echo passed" })).toThrow();
  });
});
