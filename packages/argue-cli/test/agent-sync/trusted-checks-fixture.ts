const hash = `sha256:${"a".repeat(64)}`;
export function configInput() {
  return {
    version: "agent-sync-trusted-checks-v1",
    runtime: {
      version: "agent-sync-runtime-config-v1",
      files: ["lib/value.ts"],
      compiler: { target: "ES2022", module: "NodeNext", strict: true },
      typeModules: [],
      runtimeModules: [],
      builtins: [],
      operations: [{ id: "evaluate", kind: "function", module: "lib/value.ts", exportName: "evaluate" }]
    },
    profiles: [{ profileId: "full", checkIds: ["value"] }],
    finalProfileId: "full",
    checks: [{ checkId: "value", oracleId: "value-oracle", parameters: { expected: 3 }, expectedCaseIds: ["result"] }],
    oracles: [{ oracleId: "value-oracle", kind: "node-assert", entry: "oracle.mjs", files: ["oracle.mjs"] }],
    decoders: [{ operationId: "evaluate", module: "decoder.mjs", exportName: "decode" }],
    artifacts: [
      { id: "oracle", relativePath: "oracle.mjs", expectedHash: hash },
      { id: "decoder", relativePath: "decoder.mjs", expectedHash: hash }
    ],
    dependencies: [],
    image: {
      profile: "agent-sync-validator-v1",
      node: "22.22.0",
      files: { "/opt/validator/worker.mjs": hash },
      toolchainTreeHash: hash,
      nodeBinaryHash: hash
    },
    limits: {
      checkTimeoutMs: 120000,
      callTimeoutMs: 4000,
      maxRpcBytes: 1048576,
      maxResultBytes: 1048576,
      maxOracleOutputBytes: 8388608,
      maxCalls: 1024,
      maxTotalRpcBytes: 67108864,
      maxTotalResultBytes: 67108864,
      maxDepth: 64,
      maxElements: 100000
    }
  };
}
