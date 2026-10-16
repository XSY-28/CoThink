import { describe, expect, test } from "vitest";
import { freezeBuildPlan } from "../../src/build/contracts.js";
import { authorizeBuildAction, decodeBuildReply } from "../../src/build/protocol.js";
import { sha256 } from "../../src/peer/hash.js";
import { planInput } from "./fixtures.js";

const context = () => ({
  actionVersion: "build-action-v1",
  requestId: "tool-1",
  attemptId: "attempt-1",
  taskId: "T-B1",
  workerId: "member-b",
  inputHash: sha256("input"),
  planHash: freezeBuildPlan(planInput()).planHash,
  ownerEpoch: 1,
  token: "host-token"
});
const envelope = (action: unknown, extra = {}) =>
  JSON.stringify({ actionVersion: "build-action-v1", requestId: "tool-1", action, ...extra });

describe("one strict JSON action with host identity binding", () => {
  test.each([
    { kind: "inspect", path: "src/report.ts" },
    { kind: "edit", path: "src/report.ts", text: "export {}", expectedContentHash: null },
    { kind: "check" },
    { kind: "finish" },
    { kind: "abort", reason: "blocked" }
  ])("decodes and binds %j", (action) => {
    const c = context();
    const reply = decodeBuildReply(envelope(action), c);
    const bound = authorizeBuildAction(freezeBuildPlan(planInput()), c, reply);
    expect(bound).toMatchObject({ ...c, action });
    expect(Object.isFrozen(bound.action)).toBe(true);
  });
  test("W includes inspect; shared R does not grant edit", () => {
    const p = freezeBuildPlan(planInput());
    const c = context();
    expect(
      authorizeBuildAction(p, c, decodeBuildReply(envelope({ kind: "inspect", path: "SPEC.md" }), c)).action
    ).toEqual({ kind: "inspect", path: "SPEC.md" });
    expect(() =>
      authorizeBuildAction(
        p,
        c,
        decodeBuildReply(envelope({ kind: "edit", path: "SPEC.md", text: "x", expectedContentHash: sha256("spec") }), c)
      )
    ).toThrow();
  });
  test("B1 cannot inspect normalizer; unknown and case-alias paths cannot be authorized", () => {
    for (const path of ["src/normalize.ts", "src/Report.ts", "secret.env"]) {
      const c = context();
      expect(() =>
        authorizeBuildAction(freezeBuildPlan(planInput()), c, decodeBuildReply(envelope({ kind: "inspect", path }), c))
      ).toThrow();
    }
  });
  test.each([
    { kind: "check", passed: true },
    { kind: "check", receipt: { exitCode: 0 } },
    { kind: "check", groups: ["common"] },
    { kind: "finish", acceptedVersion: "f".repeat(40) },
    { kind: "shell", command: "echo passed" },
    { kind: "inspect", path: "/tmp/a" },
    { kind: "inspect", path: "../a" },
    { kind: "edit", path: "src/report.ts", text: "x" },
    { kind: "edit", path: "src/report.ts", text: "x", expectedContentHash: "old" },
    { kind: "edit", path: "src/report.ts", patch: "sed -i x", expectedContentHash: null },
    { kind: "abort" },
    [{ kind: "check" }, { kind: "finish" }]
  ])("rejects illegal action %j", (action) => expect(() => decodeBuildReply(envelope(action), context())).toThrow());
  test.each([
    "memberId",
    "workerId",
    "attemptId",
    "token",
    "ownerEpoch",
    "inputHash",
    "shell",
    "passed",
    "explanation"
  ])("rejects model envelope authority field %s", (key) =>
    expect(() => decodeBuildReply(envelope({ kind: "check" }, { [key]: "forged" }), context())).toThrow()
  );
  test.each([
    "not json",
    '```json\n{"action":{"kind":"check"}}\n```',
    "{} trailing",
    '{"actionVersion":"build-action-v1","requestId":"tool-1","action":{"kind":"check"},"requestId":"tool-1"}'
  ])("rejects noncanonical/ambiguous JSON %s", (text) => expect(() => decodeBuildReply(text, context())).toThrow());
  test("rejects wrong request or mixed action version", () => {
    for (const extra of [{ requestId: "tool-2" }, { actionVersion: "action-v0" }])
      expect(() => decodeBuildReply(envelope({ kind: "check" }, extra), context())).toThrow();
  });
  test("reauthorizes an already decoded object and rejects forged host context", () => {
    const c = context();
    const p = freezeBuildPlan(planInput());
    const decoded = decodeBuildReply(envelope({ kind: "check" }), c);
    for (const changed of [
      { ...c, workerId: "member-a" },
      { ...c, taskId: "unknown" },
      { ...c, planHash: sha256("another plan") },
      { ...c, actionVersion: "action-v0" }
    ])
      expect(() => authorizeBuildAction(p, changed, decoded)).toThrow();
    expect(() => authorizeBuildAction(p, c, { ...decoded, passed: true })).toThrow();
  });
  test("text is literal UTF-8 file content, never a shell or patch", () => {
    const c = context();
    const action = {
      kind: "edit",
      path: "src/report.ts",
      text: "$(touch /tmp/forged)\n",
      expectedContentHash: sha256("old")
    };
    expect(authorizeBuildAction(freezeBuildPlan(planInput()), c, decodeBuildReply(envelope(action), c)).action).toEqual(
      action
    );
  });
});
