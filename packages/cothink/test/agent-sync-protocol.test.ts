import { expect, it } from "vitest";
import { decodeAction, ACTION_VERSION } from "../src/agent-sync/protocol.js";
const task = {
  taskId: "one",
  workerId: "worker",
  scope: { read: ["types.ts"], write: ["file.ts"] },
  dependsOn: [],
  checkProfileId: "test"
};
it("rejects stale replies, write escalation, fabricated verification and authority injection", () => {
  for (const [requestId, action] of [
    ["old", { kind: "finish" }],
    ["current", { kind: "edit", path: "types.ts", text: "bad", expectedContentHash: null }],
    ["current", { kind: "finish", passed: true }],
    ["current", { kind: "inspect", path: "../escape" }],
    ["current", { kind: "finish", capability: "new" }]
  ])
    expect(() =>
      decodeAction(JSON.stringify({ actionVersion: ACTION_VERSION, requestId, action }), "current", task)
    ).toThrow("SYNC_MODEL_ACTION_INVALID");
  expect(
    decodeAction(
      JSON.stringify({ actionVersion: ACTION_VERSION, requestId: "current", action: { kind: "finish" } }),
      "current",
      task
    )
  ).toEqual({ kind: "finish" });
});
