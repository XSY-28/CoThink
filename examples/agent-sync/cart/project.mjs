import { readFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { caseIds } from "./trusted/oracle.mjs";
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export const limits = Object.freeze({
  checkTimeoutMs: 120000,
  callTimeoutMs: 4000,
  maxRpcBytes: 1048576,
  maxResultBytes: 1048576,
  maxOracleOutputBytes: 8388608,
  maxCalls: 2048,
  maxTotalRpcBytes: 67108864,
  maxTotalResultBytes: 67108864,
  maxDepth: 64,
  maxElements: 100000
});
export async function cartDefinition({ fixtureRoot, imageMetadata, variant = "three" }) {
  if (!["three", "one", "negative"].includes(variant)) throw new Error("CART_VARIANT");
  const manifest = await Promise.all(
    ["SPEC.md", "lib/domain.ts", "lib/amount.ts", "lib/receipt.ts"].map(async (path) => ({
      path,
      access: ["lib/amount.ts", "lib/receipt.ts"].includes(path) ? "writable" : "read-only",
      contentHash: sha(await readFile(join(fixtureRoot, "source", path)))
    }))
  );
  const groups = variant === "negative" ? ["money", "zero", "joint"] : ["money", "lines", "invalid", "joint"];
  const profiles = groups.map((group) => ({ profileId: group + "-cases", checkIds: [group] }));
  const config = {
    version: "agent-sync-trusted-checks-v1",
    runtime: {
      version: "agent-sync-runtime-config-v1",
      files: ["lib/domain.ts", "lib/amount.ts", "lib/receipt.ts"],
      compiler: { target: "ES2022", module: "NodeNext", strict: true },
      typeModules: ["amount", "receipt"].map((name) => ({
        from: `lib/${name}.ts`,
        specifier: "./domain.js",
        to: "lib/domain.ts"
      })),
      runtimeModules: [],
      builtins: [],
      operations: [
        { id: "amount", kind: "function", module: "lib/amount.ts", exportName: "calculateCart" },
        { id: "receipt", kind: "function", module: "lib/receipt.ts", exportName: "renderReceipt" }
      ]
    },
    profiles,
    finalProfileId: "joint-cases",
    checks: groups.map((group) => ({
      checkId: group,
      oracleId: "cart",
      parameters: { group },
      expectedCaseIds: caseIds[group]
    })),
    oracles: [{ oracleId: "cart", kind: "node-assert", entry: "oracle.mjs", files: ["oracle.mjs"] }],
    decoders: [
      { operationId: "amount", module: "decoder.mjs", exportName: "amount" },
      { operationId: "receipt", module: "decoder.mjs", exportName: "receipt" }
    ],
    artifacts: await Promise.all(
      ["oracle.mjs", "decoder.mjs"].map(async (name) => ({
        id: name.split(".")[0],
        relativePath: name,
        expectedHash: sha(await readFile(join(fixtureRoot, "trusted", name)))
      }))
    ),
    dependencies: [],
    image: imageMetadata,
    limits
  };
  const task = (taskId, workerId, file, profile) => ({
    taskId,
    workerId,
    scope: { read: ["lib/domain.ts"], write: [file] },
    dependsOn: [],
    checkProfileId: profile
  });
  const tasks =
    variant === "one"
      ? [
          {
            taskId: "complete-cart",
            workerId: "cart-owner",
            scope: { read: ["lib/domain.ts"], write: ["lib/amount.ts", "lib/receipt.ts"] },
            dependsOn: [],
            checkProfileId: "joint-cases"
          }
        ]
      : [
          task("amount-basic", "calc-owner", "lib/amount.ts", "money-cases"),
          task(
            "receipt-lines",
            "receipt-owner",
            "lib/receipt.ts",
            variant === "negative" ? "zero-cases" : "lines-cases"
          ),
          ...(variant === "three" ? [task("amount-guards", "guard-owner", "lib/amount.ts", "invalid-cases")] : [])
        ];
  // The single combined task must check the entire declared contract, including invalid inputs.
  if (variant === "one") config.profiles.find((p) => p.profileId === "joint-cases").checkIds = groups;
  return {
    project: {
      projectVersion: "agent-sync-project-v1",
      projectKey: "cart-" + variant,
      memberIds: [...new Set(tasks.map((t) => t.workerId))],
      manifest,
      tasks,
      profiles,
      finalProfileId: config.finalProfileId
    },
    config
  };
}
export async function prepareCart({ fixtureRoot, sourceRoot, trustedRoot, imageMetadata, variant }) {
  const definition = await cartDefinition({ fixtureRoot, imageMetadata, variant });
  for (const entry of definition.project.manifest) {
    const output = join(sourceRoot, entry.path);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(join(fixtureRoot, "source", entry.path), output);
  }
  await mkdir(trustedRoot, { recursive: true });
  for (const artifact of definition.config.artifacts)
    await copyFile(join(fixtureRoot, "trusted", artifact.relativePath), join(trustedRoot, artifact.relativePath));
  const texts = {};
  for (const name of ["amount-basic", "amount-guards", "receipt-lines", "receipt-faulty"])
    texts[name] = await readFile(join(fixtureRoot, "trusted", name + ".ts"), "utf8");
  return { ...definition, texts };
}
