import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import { freezeAgentSyncProject } from "@onevcat/argue/agent-sync/project";
import { configurationHash, freezeTrustedCheckConfig } from "../../src/agent-sync/project/index.js";
// Explicit business fixtures are allowed in this pure fixture test; no candidate isolation is claimed.
import { cartDefinition } from "../../../../examples/agent-sync/cart/project.mjs";
import oracle, { caseIds } from "../../../../examples/agent-sync/cart/trusted/oracle.mjs";
import { configInput } from "./trusted-checks-fixture.js";
import { encode, decode } from "../../../../tools/agent-sync-validator/protocol.mjs";
import { amount as decodeAmount } from "../../../../examples/agent-sync/cart/trusted/decoder.mjs";
import { summary } from "../../../../examples/agent-sync/cart/trusted/oracle.mjs";
import { todoReferenceText } from "../../../../examples/agent-sync/todo/project.mjs";
const fixtureRoot = resolve("../../examples/agent-sync/cart");
async function fixedFunction(file: string, name: string) {
  const source = await readFile(resolve(fixtureRoot, file), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sandbox = { exports: {} as Record<string, (input: unknown) => unknown> };
  vm.runInNewContext(js, sandbox);
  return sandbox.exports[name]!;
}
async function cases(group: string, amountFile: string, receiptFile: string) {
  const amount = await fixedFunction(amountFile, "calculateCart"),
    receipt = await fixedFunction(receiptFile, "renderReceipt");
  const results: { caseId: string; passed: boolean }[] = [];
  await oracle({
    parameters: { group },
    invoke: (op: string, input: unknown) => {
      // Normalize realms for deepStrictEqual, retaining E_INPUT messages for reject assertions.
      try {
        return JSON.parse(JSON.stringify((op === "amount" ? amount : receipt)(input)));
      } catch (error) {
        throw new Error((error as Error).message);
      }
    },
    case: async (caseId: string, assertion: () => unknown) => {
      try {
        await assertion();
        results.push({ caseId, passed: true });
      } catch {
        results.push({ caseId, passed: false });
      }
    }
  });
  return results;
}
describe("fixed project business fixtures (pure validation, not Docker evidence)", () => {
  test("cart decoder handles real null-prototype data-RPC objects without discarding unexpected fields", () => {
    const limits = configInput().limits;
    const roundtrip = (value: unknown) => decode(encode(value, limits), limits);
    expect(() => assert.deepStrictEqual(decodeAmount(roundtrip(summary)), summary)).not.toThrow();
    expect(() => assert.deepStrictEqual(decodeAmount(roundtrip({ ...summary, unexpected: true })), summary)).toThrow();
  });
  test.each(["three", "one", "negative"])("freezes explicit %s member/project configuration", async (variant) => {
    const input = await cartDefinition({ fixtureRoot, imageMetadata: configInput().image, variant });
    const config = freezeTrustedCheckConfig(input.config);
    const project = freezeAgentSyncProject({ ...input.project, checkConfigurationHash: configurationHash(config) });
    expect(project.memberIds).toHaveLength(variant === "three" ? 3 : variant === "one" ? 1 : 2);
    expect(project.manifest.map((f) => f.path)).toEqual([
      "SPEC.md",
      "lib/domain.ts",
      "lib/amount.ts",
      "lib/receipt.ts"
    ]);
    expect(project.tasks.every((t) => t.dependsOn.length === 0)).toBe(true);
    expect(config.runtime.runtimeModules).toEqual([]);
    expect(project.resources.taskTimeoutMs).toBe(900000);
    expect(project.resources.runTimeoutMs).toBe(2700000);
    expect(() =>
      freezeAgentSyncProject({
        ...input.project,
        tasks: input.project.tasks.map((t: object) => ({ ...t, checkProfileId: "missing" })),
        checkConfigurationHash: configurationHash(config)
      })
    ).toThrow();
    expect(() =>
      freezeTrustedCheckConfig({ ...config, checks: config.checks.map((c) => ({ ...c, oracleId: "missing" })) })
    ).toThrow();
    expect(() =>
      freezeTrustedCheckConfig({ ...config, artifacts: config.artifacts.filter((a) => a.id !== "oracle") })
    ).toThrow();
    expect(
      configurationHash(
        freezeTrustedCheckConfig({
          ...config,
          checks: config.checks.map((c) => ({ ...c, parameters: { group: "changed" } }))
        })
      )
    ).not.toBe(configurationHash(config));
    expect(() =>
      freezeAgentSyncProject({
        ...input.project,
        tasks: input.project.tasks.map((t: object) => ({ ...t, scope: { read: [], write: ["lib/domain.ts"] } })),
        checkConfigurationHash: configurationHash(config)
      })
    ).toThrow();
    expect(() =>
      freezeAgentSyncProject({
        ...input.project,
        manifest: [...input.project.manifest, { path: "LIB/amount.ts", access: "writable", contentHash: null }],
        checkConfigurationHash: configurationHash(config)
      })
    ).toThrow();
  });
  test.each(["money", "lines", "invalid", "joint"])(
    "correct fixed texts satisfy every declared %s case",
    async (group) => {
      const result = await cases(group, "trusted/amount-guards.ts", "trusted/receipt-lines.ts");
      expect(result.map((r) => r.caseId)).toEqual(caseIds[group as keyof typeof caseIds]);
      expect(result.every((r) => r.passed)).toBe(true);
    }
  );
  test("initial amount really misses quantity; basic improvement passes money but rejects no invalid inputs", async () => {
    expect(
      (await cases("money", "source/lib/amount.ts", "trusted/receipt-lines.ts")).find(
        (r) => r.caseId === "quantity-order-total"
      )?.passed
    ).toBe(false);
    expect((await cases("money", "trusted/amount-basic.ts", "trusted/receipt-lines.ts")).every((r) => r.passed)).toBe(
      true
    );
    expect((await cases("invalid", "trusted/amount-basic.ts", "trusted/receipt-lines.ts")).some((r) => !r.passed)).toBe(
      true
    );
  });
  test("weak zero-only formatter passes locally but joint 1250-cent assertion fails", async () => {
    expect((await cases("zero", "trusted/amount-basic.ts", "trusted/receipt-faulty.ts")).every((r) => r.passed)).toBe(
      true
    );
    expect(
      (await cases("joint", "trusted/amount-basic.ts", "trusted/receipt-faulty.ts")).find(
        (r) => r.caseId === "joint-1250-cents"
      )?.passed
    ).toBe(false);
    expect(
      (await cases("lines", "trusted/amount-basic.ts", "trusted/receipt-faulty.ts")).find(
        (r) => r.caseId === "nonzero-lines"
      )?.passed
    ).toBe(false);
  });
});

test.each(["correct-state", "correct-report", "correct-final"])(
  "todo %s reference resolves types from its actual src destination",
  async (name) => {
    const sample = resolve("../../examples/todo-stats");
    const text = await todoReferenceText(sample, name);
    const imports = ts.preProcessFile(text).importedFiles;
    expect(imports).toHaveLength(1);
    const resolved = ts.resolveModuleName(
      imports[0]!.fileName,
      resolve(sample, "src/normalize.ts"),
      { moduleResolution: ts.ModuleResolutionKind.NodeNext },
      ts.sys
    ).resolvedModule;
    expect(resolved?.resolvedFileName).toBe(resolve(sample, "src/types.ts"));
    const original = await readFile(resolve(sample, "test/oracle", name + ".ts"), "utf8");
    expect(text.replaceAll("./types.js", "../../src/types.js")).toBe(original);
  }
);
