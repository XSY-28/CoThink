import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { hashJson, freezeSyncValue, AGENT_SYNC_CHECK_VERSION } from "@onevcat/argue/agent-sync/project";
import type { AgentSyncCheckDefinition } from "../project/backend.js";
import { ProjectDockerRuntime } from "../project/runtime.js";
import { configurationHash, selectedChecks, type TrustedCheckConfig } from "./config.js";
import { byteHash, treeHash, measureArtifacts, checkTime } from "./measure.js";
export const runtimeFiles = [
  "cli-shim.mjs",
  "compile.mjs",
  "describe.mjs",
  "invoke.mjs",
  "protocol.mjs",
  "supervisor.mjs",
  "worker.mjs"
] as const;
export const hostFiles = [
  "bridge.mjs",
  "node-oracle.mjs",
  "vitest-oracle.mjs",
  "guard.mjs",
  "output-budget.mjs"
] as const;
export const guardBootstrapTemplate =
  'import {installGuard} from "./guard.mjs"; installGuard(new URL("./policy.json",import.meta.url));\n';
export const bridgeTemplate =
  'import {createBridge} from "./bridge.mjs"; export const invoke=await createBridge(JOB_PATH,JOB_HASH);\n';
export const oracleArguments = ["HOST_RUNNER", "HOST_JOB"];
export const vitestArguments = [
  "--import",
  "GUARD_BOOTSTRAP",
  "VITEST_ENTRY",
  "run",
  "--root",
  "ORACLE_ROOT",
  "--config",
  "FIXED_CONFIG",
  "--configLoader",
  "native",
  "SELECTED_EXACT_FILES",
  "--reporter=json"
];
export const compilerSettings = {
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  strict: true,
  noEmitOnError: true,
  skipLibCheck: true,
  rootDir: "/tmp/project",
  outDir: "/tmp/out",
  types: ["node"],
  typeRoots: ["/opt/toolchain/node_modules/@types"],
  sourceMap: false,
  declaration: false
};
export async function readRuntimeMetadata(
  runtime: ProjectDockerRuntime,
  imageId: string,
  deadline?: number
): Promise<TrustedCheckConfig["image"]> {
  return runtime.withContainer(
    imageId,
    {},
    async (c) => {
      const result = c.runFixed("describe");
      if (result.error || result.status !== 0 || result.signal || result.stderr)
        throw new Error("AGENT_SYNC_TOOLCHAIN_METADATA");
      const metadata = JSON.parse(result.stdout) as TrustedCheckConfig["image"];
      if (
        !metadata ||
        Object.keys(metadata).sort().join() !== "files,node,nodeBinaryHash,profile,toolchainTreeHash" ||
        metadata.profile !== "agent-sync-validator-v1" ||
        Object.keys(metadata.files).sort().join() !==
          runtimeFiles
            .map((n) => "/opt/validator/" + n)
            .sort()
            .join()
      )
        throw new Error("AGENT_SYNC_TOOLCHAIN_METADATA");
      return freezeSyncValue(metadata);
    },
    deadline
  );
}
export class CheckEvidence {
  private capsule: { imageId: string; metadata: TrustedCheckConfig["image"] } | undefined;
  constructor(
    readonly runtime: ProjectDockerRuntime,
    readonly config: TrustedCheckConfig,
    readonly trustedRoot: string,
    readonly programRoot: string,
    readonly image: string,
    readonly timeout: number
  ) {}
  async describe(input: readonly string[], deadline?: number): Promise<AgentSyncCheckDefinition> {
    checkTime(deadline);
    const groups = selectedChecks(this.config, input),
      image = this.runtime.inspectImage(this.image, deadline);
    if (!this.capsule || this.capsule.imageId !== image.Id)
      this.capsule = { imageId: image.Id, metadata: await readRuntimeMetadata(this.runtime, image.Id, deadline) };
    const metadata = this.capsule.metadata;
    if (hashJson(metadata) !== hashJson(this.config.image)) throw new Error("AGENT_SYNC_TOOLCHAIN_CHANGED");
    const trusted = await measureArtifacts(this.config, this.trustedRoot, deadline);
    const scripts: Record<string, string> = {};
    for (const name of runtimeFiles) {
      const h = byteHash(await readFile(join(this.programRoot, "agent-sync-validator", name)));
      if (metadata.files["/opt/validator/" + name] !== h) throw new Error("AGENT_SYNC_RUNTIME_PROGRAM_CHANGED");
      scripts["runtime:" + name] = h;
    }
    for (const name of hostFiles)
      scripts["host:" + name] = byteHash(await readFile(join(this.programRoot, "agent-sync-checks", name)));
    scripts.Dockerfile = byteHash(await readFile(join(this.programRoot, "agent-sync-validator/Dockerfile")));
    const source = import.meta.url.endsWith(".ts");
    const coreRoot = fileURLToPath(new URL("../../../../argue/" + (source ? "src" : "dist") + "/", import.meta.url));
    // Actual executing verifier/runtime/storage helper modules are committed independently of project artifacts.
    scripts.hostModules = await treeHash(fileURLToPath(new URL("../", import.meta.url)), deadline);
    scripts.storageModules = await treeHash(fileURLToPath(new URL("../../storage/", import.meta.url)), deadline);
    scripts.coreModules = await treeHash(join(coreRoot, "agent-sync"), deadline);
    scripts.coreHash = byteHash(await readFile(join(coreRoot, "peer/hash." + (source ? "ts" : "js"))));
    const require = createRequire(import.meta.url),
      zodRoot = dirname(require.resolve("zod/package.json"));
    const dependencies = { ...trusted.dependencies, zod: await treeHash(zodRoot, deadline) };
    const programsHash = hashJson({
      version: "agent-sync-check-programs-v1",
      files: { ...trusted.files, ...scripts },
      runtimeFiles: metadata.files,
      generatedTemplates: { bridgeTemplate, guardBootstrapTemplate, oracleArguments, vitestArguments }
    });
    const configuration = configurationHash(this.config);
    const argumentsHash = hashJson({
      version: "agent-sync-check-arguments-v1",
      selectedIds: groups,
      hostNodeArgv: oracleArguments,
      vitestArguments,
      compilerSettings,
      checks: this.config.checks.filter((c) => groups.includes(c.checkId)),
      oracles: this.config.oracles,
      docker: this.runtime.argumentMetadata(),
      compiler: this.config.runtime,
      environment: { PATH: "TRUSTED_HOST_PATH", HOME: "FRESH_PRIVATE_HOME", LANG: "C.UTF-8" },
      effectiveLimits: { ...this.config.limits, checkTimeoutMs: this.timeout }
    });
    const toolchainHash = hashJson({
      version: "agent-sync-check-toolchain-v1",
      imageDigest: image.Id,
      runtimeProfile: metadata.profile,
      metadata,
      hostNode: process.version,
      hostNodeBinaryHash: byteHash(await readFile(process.execPath)),
      dockerBinaryHash: byteHash(await readFile(this.runtime.connection.executable)),
      hostOracleDependencyTreeHashes: dependencies
    });
    const isolationHash = this.runtime.policyHash(image.Id);
    const basis = {
      configurationHash: configuration,
      programsHash,
      argumentsHash,
      toolchainHash,
      isolationHash,
      imageDigest: image.Id
    };
    const checksHash = hashJson({ checkVersion: AGENT_SYNC_CHECK_VERSION, selectedIds: groups, ...basis });
    checkTime(deadline);
    return freezeSyncValue({ groups, checksHash, ...basis });
  }
}
