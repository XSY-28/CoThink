import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FrozenBuildPlanSchema, createBuildState, buildResult } from "@onevcat/argue";
import { publicBuildResult, renderBuildResult } from "../../src/build/render.js";

test("public rendering uses an allowlist and actual immutable file hashes", async () => {
  const plan = FrozenBuildPlanSchema.parse(
    JSON.parse(await readFile(resolve("../../examples/todo-stats/build-plan.json"), "utf8"))
  );
  const state = createBuildState({
    buildSchemaVersion: 1,
    planVersion: "build-plan-v1",
    actionVersion: "build-action-v1",
    budgetVersion: "build-budget-v1",
    checkVersion: "build-check-v1",
    publishVersion: "build-publish-v1",
    resultVersion: "build-result-v1",
    projectKey: plan.projectKey,
    runId: "render-run",
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
  });
  const result = buildResult(
    state,
    Object.fromEntries(plan.tasks.map((t) => [t.taskId, "provider secret nonce rawReview"]))
  );
  const file = { text: "official code", contentHash: `sha256:${"b".repeat(64)}`, blobId: "c".repeat(40) };
  const output = publicBuildResult({
    state,
    result,
    requestId: "public-request",
    directory: "/managed/run",
    recoveryRequired: true,
    files: { "src/report.ts": file },
    baseline: { "src/report.ts": { ...file, contentHash: `sha256:${"d".repeat(64)}` } },
    baseVersion: "e".repeat(40)
  });
  expect(output.diff.files).toEqual([
    { path: "src/report.ts", beforeHash: `sha256:${"d".repeat(64)}`, afterHash: file.contentHash }
  ]);
  expect(JSON.stringify(output)).not.toMatch(/provider secret|nonce|rawReview|official code|blobId|lease|apiKey/);
  const text = renderBuildResult(output);
  expect(text).toContain("incomplete");
  expect(text).toContain("Official version:");
  expect(text).toContain("Recover host state without model calls");
  output.cancellation = "requested";
  expect(renderBuildResult(output)).toContain(
    "Cancellation requested; waiting for the active host to confirm revocation."
  );
  output.cancellation = "revoked";
  expect(renderBuildResult(output)).toContain("Cancellation completed; active authority is revoked.");
});
