import { mkdtemp, writeFile, readFile, cp, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { treeManifest } from "../../src/agent-sync/checks/measure.js";
import { oracleExit } from "../../src/agent-sync/checks/oracle-result.js";
import { freezeTrustedCheckConfig } from "../../src/agent-sync/checks/config.js";
import { configInput } from "./trusted-checks-fixture.js";
const sha = (x: string) => "sha256:" + createHash("sha256").update(x).digest("hex");
describe("trusted oracle authority", () => {
  it("rejects incomplete, duplicate, skipped, extra and inconsistent summaries", () => {
    const config = freezeTrustedCheckConfig(configInput());
    const summary = {
      oracleVersion: "agent-sync-oracle-result-v1",
      checks: [{ checkId: "value", cases: [{ caseId: "result", status: "passed" }] }]
    };
    expect(oracleExit(JSON.stringify(summary), 0, config, ["value"])).toBe(0);
    for (const altered of [
      { ...summary, checks: [] },
      { ...summary, checks: [...summary.checks, ...summary.checks] },
      { ...summary, checks: [{ checkId: "value", cases: [] }] },
      { ...summary, checks: [{ checkId: "value", cases: [{ caseId: "result", status: "skipped" }] }] },
      { ...summary, passed: true }
    ])
      expect(() => oracleExit(JSON.stringify(altered), 0, config, ["value"])).toThrow();
    expect(() => oracleExit(JSON.stringify(summary), 1, config, ["value"])).toThrow();
  });
  it("counts PATH-only CLI children in one private job and rejects actual elapsed deadline", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-bridge-")));
    try {
      await cp(resolve("../../tools/agent-sync-checks/bridge.mjs"), join(root, "bridge.mjs"));
      await cp(resolve("../../tools/agent-sync-checks/guard.mjs"), join(root, "guard.mjs"));
      await cp(resolve("../../tools/agent-sync-validator/protocol.mjs"), join(root, "protocol.mjs"));
      await writeFile(join(root, "decoder.mjs"), "export const decode=value=>value;");
      await writeFile(
        join(root, "worker.mjs"),
        `let text='';for await(const c of process.stdin)text+=c;const r=JSON.parse(text);delete r.input;r.ok=true;r.value=['number','3'];process.stdout.write(JSON.stringify(r));`
      );
      const job = {
        guardPolicyPath: join(root, "policy.json"),
        deadlineNs: String(process.hrtime.bigint() + 10000000000n),
        limits: { ...configInput().limits, maxCalls: 2 },
        budgetPath: join(root, "budget.json"),
        decoders: [{ operationId: "evaluate", path: join(root, "decoder.mjs"), exportName: "decode" }],
        invocation: {
          command: process.execPath,
          args: [join(root, "worker.mjs")],
          env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" }
        }
      };
      const text = JSON.stringify(job),
        hash = sha(text);
      await writeFile(join(root, "job.json"), text);
      await writeFile(job.budgetPath, JSON.stringify({ jobHash: hash, calls: 0, inputBytes: 0, outputBytes: 0 }));
      await writeFile(
        join(root, "child.mjs"),
        `import {createBridge} from './bridge.mjs';const invoke=await createBridge(${JSON.stringify(join(root, "job.json"))},${JSON.stringify(hash)});process.stdout.write(String(invoke('evaluate',2)));`
      );
      const files = Object.fromEntries(Object.entries(await treeManifest(root)).map(([p, h]) => [join(root, p), h]));
      await writeFile(
        job.guardPolicyPath,
        JSON.stringify({ version: "agent-sync-host-closure-v1", files, failurePath: job.budgetPath + ".failed" })
      );
      const call = () =>
        spawnSync(process.execPath, [join(root, "child.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH } });
      expect(call().stdout).toBe("3");
      expect(call().stdout).toBe("3");
      expect(call().status).not.toBe(0);
      expect(JSON.parse(await readFile(job.budgetPath, "utf8")).calls).toBe(2);
      const expired = JSON.stringify({ ...job, deadlineNs: String(process.hrtime.bigint() - 1n) }),
        expiredHash = sha(expired);
      await writeFile(join(root, "job.json"), expired);
      await writeFile(
        job.budgetPath,
        JSON.stringify({ jobHash: expiredHash, calls: 0, inputBytes: 0, outputBytes: 0 })
      );
      await writeFile(
        join(root, "child.mjs"),
        `import {createBridge} from './bridge.mjs';const invoke=await createBridge(${JSON.stringify(join(root, "job.json"))},${JSON.stringify(expiredHash)});invoke('evaluate',2);`
      );
      expect(call().stderr).toContain("AGENT_SYNC_CHECK_TIMEOUT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
