// Lifecycle fixture only; real transaction semantics are tested by the separate Docker smoke.
import process from "node:process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
const job = JSON.parse(readFileSync(process.argv[3], "utf8"));
const { project, runId, workspaceRoot } = job.options;
const path = join(workspaceRoot, "fixture-state.json");
const state = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : {
      serviceVersion: "agent-sync-project-service-v1",
      projectKey: project.projectKey,
      planHash: project.planHash,
      runId,
      acceptedVersion: "base",
      status: "active",
      tasks: project.tasks.map((t) => ({ taskId: t.taskId, workerId: t.workerId, status: "running" })),
      waiting: []
    };
const emit = (value) =>
  process.stdout.write(JSON.stringify({ protocolVersion: "agent-sync-stdio-v1", ...value }) + "\n");
emit({ event: "ready", status: state });
const lines = createInterface({ input: process.stdin });
lines.on("line", (text) => {
  const { routeId, request } = JSON.parse(text),
    { method, params } = request;
  appendFileSync(join(workspaceRoot, "fixture-operations.jsonl"), JSON.stringify({ method, params }) + "\n");
  let result = {},
    extra = {};
  if (method === "status") result = state;
  if (method === "currentLease") result = { current: false };
  if (method === "requestScope") {
    result = { kind: "granted" };
    extra = { capability: "fixed-cap", leaseContext: { attemptId: "attempt", ownerEpoch: 1, leaseEpoch: 1 } };
  }
  if (method === "freezeInput") result = { baseVersion: "base", inputHash: "hash", contentHashes: { "x.ts": null } };
  if (method === "read")
    result = { kind: "inspected", baseVersion: "base", path: "x.ts", text: null, contentHash: null };
  if (method === "finish") {
    state.status = "completed";
    state.tasks.forEach((t) => (t.status = "completed"));
    result = { status: "accepted", receipt: { acceptedVersion: "new", checkReceiptId: "check" } };
  }
  if (method === "recover") result = { ...state, replayedActions: 0, ownerEpoch: 2 };
  if (method === "cancel") {
    state.tasks.find((t) => t.taskId === params.taskId).status = "cancelled";
    state.status = "cancelled";
    result = { kind: "cancelled" };
  }
  if (method === "close") result = { writerReleased: true };
  writeFileSync(path, JSON.stringify(state));
  emit({ routeId, requestId: request.requestId, ok: true, result, ...extra });
  if (method === "close") {
    lines.close();
    process.stdin.destroy();
  }
});
