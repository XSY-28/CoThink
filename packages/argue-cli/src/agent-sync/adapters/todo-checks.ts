import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { decodeDockerData } from "../legacy-v1/todo-oracle.js";
import { freezeTrustedCheckConfig, type TrustedCheckConfig } from "../checks/config.js";
import { byteHash, treeHash } from "../checks/measure.js";
const titles = {
  common: [
    "legacy states, ids, titles and input order are preserved",
    "total includes every task and CLI wires normalizer to report",
    "invalid JSON and invalid old input fail atomically with fixed codes"
  ],
  "state-format": [
    "status is accepted and takes priority over done",
    "invalid status cannot fall back to a valid done",
    "old done remains strict when status is absent"
  ],
  report: [
    "counts frozen normalized fixture in fixed order including cancelled",
    "counts empty and other distributions without normalizer"
  ],
  identity: [
    "trims only outer title whitespace and preserves order and ids",
    "rejects blank titles one condition at a time",
    "requires positive integer ids and batch uniqueness"
  ],
  final: [
    "joint CLI produces 4/1/2/1 with trimmed normalized titles",
    "handles empty, alternative distribution and reversed order",
    "CLI honors every status even with conflicting or nonboolean done",
    "decodes UTF-8 across chunks before title validation",
    "fails entire batch on every single invalid condition"
  ]
};
/** Explicit trusted sample adapter. Call before freezing the project/configuration hash. */
export async function createTodoTrustedChecks(options: {
  repositoryRoot: string;
  trustedRoot: string;
  imageMetadata: TrustedCheckConfig["image"];
  profiles?: TrustedCheckConfig["profiles"];
  finalProfileId?: string;
}): Promise<TrustedCheckConfig> {
  const { repositoryRoot, trustedRoot } = options;
  const sample = join(repositoryRoot, "examples/todo-stats");
  const manifest = JSON.parse(await readFile(join(sample, "manifest.json"), "utf8")) as {
    files: { path: string; access: string; contentHash: string }[];
    hostOnly: { path: string; contentHash: string }[];
  };
  const artifacts: TrustedCheckConfig["artifacts"] = [];
  for (const file of [...manifest.files.filter((f) => f.access === "read-only"), ...manifest.hostOnly]) {
    const bytes = await readFile(join(sample, file.path));
    if (byteHash(bytes) !== file.contentHash) throw new Error("BUILD_HOST_FROZEN");
    const out = join(trustedRoot, "sample", file.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes, { mode: 0o444 });
    artifacts.push({
      id: "sample-" + artifacts.length,
      relativePath: "sample/" + file.path,
      expectedHash: file.contentHash
    });
  }
  const decoder =
    `const decodeDockerData=${decodeDockerData.toString()};\n` +
    ["normalize", "report", "cli"]
      .map((op) => `export const ${op}=(value)=>decodeDockerData('${op}',JSON.stringify({ok:true,value}));`)
      .join("\n");
  await writeFile(join(trustedRoot, "decoder.mjs"), decoder, { mode: 0o444 });
  artifacts.push({ id: "decoder", relativePath: "decoder.mjs", expectedHash: byteHash(decoder) });
  // Include the complete installed dependency bytes, resolving workspace/bin links into regular copies.
  await cp(join(repositoryRoot, "node_modules"), join(trustedRoot, "node_modules"), {
    recursive: true,
    dereference: true,
    filter: (path) => !path.split(sep).some((p) => [".cache", ".vite", ".vite-temp"].includes(p))
  });
  const lock = await readFile(join(repositoryRoot, "package-lock.json"));
  await writeFile(join(trustedRoot, "package-lock.json"), lock, { mode: 0o444 });
  artifacts.push({ id: "lockfile", relativePath: "package-lock.json", expectedHash: byteHash(lock) });
  const groups = Object.keys(titles) as (keyof typeof titles)[];
  const files = artifacts.filter((a) => a.relativePath.startsWith("sample/")).map((a) => a.relativePath);
  return freezeTrustedCheckConfig({
    version: "agent-sync-trusted-checks-v1",
    runtime: {
      version: "agent-sync-runtime-config-v1",
      files: ["src/types.ts", "src/normalize.ts", "src/report.ts", "src/cli.ts"],
      compiler: { target: "ES2022", module: "NodeNext", strict: true },
      typeModules: [
        { from: "src/normalize.ts", specifier: "./types.js", to: "src/types.ts" },
        { from: "src/report.ts", specifier: "./types.js", to: "src/types.ts" }
      ],
      runtimeModules: [
        { from: "src/cli.ts", specifier: "./normalize.js", to: "src/normalize.ts" },
        { from: "src/cli.ts", specifier: "./report.js", to: "src/report.ts" }
      ],
      builtins: [],
      operations: [
        { id: "normalize", kind: "function", module: "src/normalize.ts", exportName: "normalizeTasks" },
        { id: "report", kind: "function", module: "src/report.ts", exportName: "renderReport" },
        { id: "cli", kind: "cli", module: "src/cli.ts" }
      ]
    },
    profiles: options.profiles ?? [{ profileId: "complete", checkIds: groups }],
    finalProfileId: options.finalProfileId ?? "complete",
    checks: groups.map((checkId) => ({
      checkId,
      oracleId: checkId,
      parameters: null,
      expectedCaseIds: titles[checkId].map(
        (title) =>
          `test/${checkId === "common" ? "baseline" : checkId}.test.ts::${checkId === "common" ? "baseline/common" : checkId}::${title}`
      )
    })),
    oracles: groups.map((oracleId) => ({
      oracleId,
      kind: "vitest-proxy",
      entry: `sample/test/${oracleId === "common" ? "baseline" : oracleId}.test.ts`,
      root: "sample",
      dependencyId: "host-packages",
      files
    })),
    decoders: ["normalize", "report", "cli"].map((operationId) => ({
      operationId,
      module: "decoder.mjs",
      exportName: operationId
    })),
    proxies: [
      { path: "src/normalize.js", kind: "function", operationId: "normalize", exportName: "normalizeTasks" },
      { path: "src/report.js", kind: "function", operationId: "report", exportName: "renderReport" },
      { path: "src/cli.js", kind: "cli", operationId: "cli" }
    ],
    artifacts,
    dependencies: [
      {
        id: "host-packages",
        relativePath: "node_modules",
        expectedHash: await treeHash(join(trustedRoot, "node_modules"))
      }
    ],
    image: options.imageMetadata,
    limits: {
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
    }
  });
}
