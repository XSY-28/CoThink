import { cleanup, render, screen } from "@testing-library/preact";
import { buildPeerReport } from "../../argue/src/peer/report.js";
import { createPeerSession } from "../../argue/src/peer/protocol.js";
import { afterEach, expect, it } from "vitest";
import { PeerReportView } from "../src/components/PeerReportView.js";

afterEach(cleanup);

it("renders a paused peer report without a representative and escapes supplied script text", () => {
  const state = createPeerSession({
    sessionId: "viewer-test",
    schemaVersion: 1,
    question: "<script>alert('x')</script>",
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
  render(<PeerReportView result={buildPeerReport(state)} onReset={() => {}} />);
  expect(screen.getByText("<script>alert('x')</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText(/Incomplete review/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("representative");
});
