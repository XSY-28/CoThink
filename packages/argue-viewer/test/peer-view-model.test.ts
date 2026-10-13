import { buildPeerReport } from "../../argue/src/peer/report.js";
import { createPeerSession } from "../../argue/src/peer/protocol.js";
import { makeSession } from "../../argue/test/peer/fixtures.js";
import { expect, it } from "vitest";
import { buildPeerViewModel } from "../src/lib/peer-view-model.js";

it("keeps both member slots and incomplete review visible in a paused report", () => {
  const state = createPeerSession({
    sessionId: "viewer-test",
    schemaVersion: 1,
    question: "Question",
    sourceCommit: "local",
    createdAt: "2026-10-13T00:00:00.000Z",
    members: [
      {
        id: "member-a",
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "a",
        apiKeyEnv: "A",
        outputMode: "json_object",
        generationOptions: {}
      },
      {
        id: "member-b",
        protocol: "openai-compatible",
        baseUrl: "https://example.test",
        modelId: "b",
        apiKeyEnv: "B",
        outputMode: "json_object",
        generationOptions: {}
      }
    ]
  });
  state.status = "paused";
  const view = buildPeerViewModel(buildPeerReport(state));
  expect(view.members).toHaveLength(2);
  expect(view.members.map((x) => x.conclusion)).toEqual([null, null]);
  expect(view.reviewStatus).toBe("incomplete_review");
  expect(view.usageCoverage).toBe("0/0");
});

it("keeps a failed attempt visible after a later attempt commits the same job", () => {
  const report = buildPeerReport(makeSession({ phase: "discussion" }));
  const committed = report.rounds[0]!.replies[0]!;
  const base = {
    jobId: committed.jobId,
    inputHash: committed.inputHash,
    memberId: committed.memberId,
    startedAt: "2026-10-13T00:00:00.000Z",
    deadline: "2026-10-13T00:10:00.000Z",
    cancellation: "none" as const
  };
  report.attempts = [
    {
      ...base,
      attemptId: "failed-first",
      status: "invalid",
      acceptance: "invalidated",
      rawContent: "invalid-first-marker",
      error: { code: "invalid_output", message: "Invalid", retryable: true }
    },
    { ...base, attemptId: "valid-second", status: "valid", acceptance: "accepted" }
  ];
  expect(buildPeerViewModel(report).uncommittedAttempts.map((attempt) => attempt.attemptId)).toEqual(["failed-first"]);
});
