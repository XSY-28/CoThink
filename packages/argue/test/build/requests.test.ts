import { describe, expect, test } from "vitest";
import { bindBuildInput, createBuildState } from "../../src/build/state.js";
import { reserveBuildScope } from "../../src/build/scope.js";
import { reserveBuildCall, settleBuildCall } from "../../src/build/budget.js";
import { prepareBuildModelRequest, decodeAuthorizedBuildReply } from "../../src/build/requests.js";
import { sha256 } from "../../src/peer/hash.js";
import type { BuildToolResult } from "../../src/build/contracts.js";
import { runInput } from "./fixtures.js";

function ready() {
  const grant = reserveBuildScope(
    createBuildState(runInput()),
    { ownerEpoch: 1, workerId: "member-b", taskId: "T-B1", requestId: "reserve-b" },
    1000,
    () => ({ attemptId: "attempt-b", token: "host-only-secret" })
  );
  if (grant.result.kind !== "granted") throw new Error("Expected grant");
  const lease = grant.result.lease;
  const bound = bindBuildInput(
    grant.state,
    lease,
    "bind-b",
    {
      baseVersion: "a".repeat(40),
      inputHash: sha256("bound"),
      contentHashes: { "SPEC.md": sha256("spec"), "src/report.ts": sha256("total") }
    },
    1001
  );
  const state = reserveBuildCall(bound.state, lease, "call-b", 1002).state;
  const materials: Extract<BuildToolResult, { kind: "inspected" }>[] = [
    { kind: "inspected", baseVersion: "a".repeat(40), path: "SPEC.md", text: "spec", contentHash: sha256("spec") },
    {
      kind: "inspected",
      baseVersion: "a".repeat(40),
      path: "src/report.ts",
      text: "total",
      contentHash: sha256("total")
    }
  ];
  return { state, lease, materials };
}

describe("task-scoped model inputs", () => {
  test("compiles full declared scope and fixed task goal without disclosing authority or other tasks", () => {
    const { state, lease, materials } = ready();
    const request = prepareBuildModelRequest(state, lease, "call-b", "reply-b", materials);
    const payload = JSON.parse(request.messages.find((message) => message.role === "user")!.content);
    expect(payload).toMatchObject({
      actionVersion: "build-action-v1",
      requestId: "reply-b",
      task: { taskId: "T-B1", workerId: "member-b", scope: { read: ["SPEC.md"], write: ["src/report.ts"] } },
      input: {
        baseVersion: "a".repeat(40),
        inputHash: sha256("bound"),
        files: [
          { path: "SPEC.md", text: "spec", contentHash: sha256("spec") },
          { path: "src/report.ts", text: "total", contentHash: sha256("total") }
        ]
      }
    });
    expect(payload.task.goal).toContain("report");
    expect(request.context.token).toBe("host-only-secret");
    expect(request.context.requestId).toBe("reply-b");
    for (const forbidden of ["host-only-secret", "ownerEpoch", "leaseEpoch", "src/normalize.ts", "T-A", "T-B2"])
      expect(JSON.stringify(request.messages)).not.toContain(forbidden);
    expect(Object.isFrozen(request.messages)).toBe(true);
    expect(Object.isFrozen(request.messages[0])).toBe(true);
    expect(Object.isFrozen(request.context)).toBe(true);
    Object.assign(materials[0]!, { text: "mutated" });
    expect(request.messages[1]!.content).toContain('"text":"spec"');
  });
  test("rejects missing, extra, duplicate, wrong-version, false-hash and changed-initial materials", () => {
    const { state, lease, materials } = ready();
    const variants = [
      materials.slice(0, 1),
      [...materials, materials[0]!],
      [...materials, { ...materials[1]!, path: "src/normalize.ts" }],
      [{ ...materials[0]!, baseVersion: "b".repeat(40) }, materials[1]!],
      [{ ...materials[0]!, text: "forged" }, materials[1]!],
      [materials[0]!, { ...materials[1]!, text: "changed", contentHash: sha256("changed") }]
    ];
    for (const invalid of variants)
      expect(() => prepareBuildModelRequest(state, lease, "call-b", "reply-b", invalid)).toThrow();
    expect(() =>
      prepareBuildModelRequest(state, lease, "call-b", "reply-b", variants[5]!, {
        kind: "checked",
        passed: true,
        exitCode: 0
      })
    ).toThrow();
  });
  test("requires current reserved call, exact matching lease and fresh model request ID", () => {
    const { state, lease, materials } = ready();
    expect(() => prepareBuildModelRequest(state, lease, "missing", "reply", materials)).toThrow();
    expect(() => prepareBuildModelRequest(state, { ...lease, token: "other" }, "call-b", "reply", materials)).toThrow();
    expect(() => prepareBuildModelRequest(state, lease, "call-b", "bind-b", materials)).toThrow();
    const done = settleBuildCall(state, "call-b", "succeeded", 1003);
    expect(() => prepareBuildModelRequest(done, lease, "call-b", "reply", materials)).toThrow();
  });
  test("later private edits are fresh and previous feedback strips host receipts, raw response and provider fields", () => {
    const { state, lease, materials } = ready();
    const next = reserveBuildCall(settleBuildCall(state, "call-b", "succeeded", 1003), lease, "call-next", 1004).state;
    const fresh = [materials[0]!, { ...materials[1]!, text: "new report", contentHash: sha256("new report") }];
    const previous = {
      kind: "checked",
      passed: false,
      exitCode: 1,
      groups: ["common", "report"],
      receiptId: "host-receipt",
      token: "secret",
      rawContent: "private response",
      apiKeyEnv: "KEY"
    };
    const request = prepareBuildModelRequest(next, lease, "call-next", "reply-next", fresh, previous);
    const payload = JSON.parse(request.messages[1]!.content);
    expect(payload.input.files[1].text).toBe("new report");
    expect(payload.previousToolResult).toEqual({
      kind: "checked",
      passed: false,
      exitCode: 1,
      groups: ["common", "report"]
    });
    previous.groups.push("identity");
    expect(request.messages[1]!.content).not.toContain("identity");
    expect(JSON.stringify(request.messages)).not.toContain("host-receipt");
    expect(() =>
      prepareBuildModelRequest(
        next,
        lease,
        "call-next",
        "reply-next",
        [{ ...fresh[0]!, text: "changed spec", contentHash: sha256("changed spec") }, fresh[1]!],
        previous
      )
    ).toThrow();
  });
  test("public feedback cannot smuggle file content beyond scope or claim inconsistent checks", () => {
    const { state, lease, materials } = ready();
    for (const previous of [
      { kind: "inspected", path: "src/normalize.ts", text: "private", contentHash: sha256("private") },
      { kind: "inspected", path: "SPEC.md", text: "forged", contentHash: sha256("spec") },
      { kind: "edited", files: [{ path: "src/normalize.ts", contentHash: sha256("private") }] },
      { kind: "checked", passed: true, exitCode: 1 },
      { kind: "sealed", receipt: { token: "private" } }
    ])
      expect(() => prepareBuildModelRequest(state, lease, "call-b", "reply-b", materials, previous)).toThrow();
  });
  test("strict decoding rejects wrong IDs, forged check success, duplicate keys and scope escalation", () => {
    const { state, lease, materials } = ready();
    const { context } = prepareBuildModelRequest(state, lease, "call-b", "reply-b", materials);
    const reply = (action: unknown, requestId = "reply-b") =>
      JSON.stringify({ actionVersion: "build-action-v1", requestId, action });
    expect(
      decodeAuthorizedBuildReply(state.plan, context, reply({ kind: "inspect", path: "src/report.ts" })).action.kind
    ).toBe("inspect");
    for (const invalid of [
      reply({ kind: "check", passed: true }),
      reply({ kind: "finish" }, "wrong"),
      reply({ kind: "inspect", path: "src/normalize.ts" }),
      reply({ kind: "edit", path: "SPEC.md", text: "bad", expectedContentHash: sha256("spec") }),
      '{"actionVersion":"build-action-v1","requestId":"reply-b","requestId":"reply-b","action":{"kind":"finish"}}',
      "```json\n{}\n```"
    ])
      expect(() => decodeAuthorizedBuildReply(state.plan, context, invalid)).toThrow();
  });
});
