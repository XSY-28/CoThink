import { LegacyDockerRuntime, DockerUnavailable, digest, imageReference, isolation, run, docker } from "./runtime.js";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashBuildValue, type BuildCheckGroup, type BuildCheckReceipt } from "@onevcat/argue/agent-sync";

import type { BuildCheckDefinition } from "./backend.js";
export type { BuildVerificationCandidate, BuildCheckDefinition, BuildVerifier } from "./backend.js";
export { hashVerificationSource } from "../kernel/verification-types.js";
export { DockerUnavailable, validateDockerIsolation } from "./runtime.js";
const groupFiles = {
  common: "baseline",
  "state-format": "state-format",
  report: "report",
  identity: "identity",
  final: "final"
};
const sha = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const limit = 8 * 1024 * 1024;
function groupsOf(groups: readonly BuildCheckGroup[]): BuildCheckGroup[] {
  if (!groups.length || groups.some((g) => !Object.hasOwn(groupFiles, g)) || new Set(groups).size !== groups.length)
    throw new Error("BUILD_CHECK_GROUPS");
  return (Object.keys(groupFiles) as BuildCheckGroup[]).filter((g) => groups.includes(g));
}
/** Strict data only; this function is also embedded into trusted generated proxies. */
export function decodeDockerData(operation: string, text: string): unknown {
  const bad = () => {
    throw new Error("BUILD_DOCKER_DATA");
  };
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return bad();
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return bad();
  const obj = envelope as Record<string, unknown>;
  if (obj.ok === false && Object.keys(obj).sort().join() === "error,ok" && obj.error === "E_INPUT")
    throw new Error("E_INPUT");
  if (obj.ok !== true || Object.keys(obj).sort().join() !== "ok,value") return bad();
  const value = obj.value;
  if (operation === "normalize") {
    if (
      !Array.isArray(value) ||
      value.some((v: unknown) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return true;
        const item = v as Record<string, unknown>;
        return (
          Object.keys(item).sort().join() !== "id,state,title" ||
          typeof item.id !== "number" ||
          !Number.isFinite(item.id) ||
          typeof item.title !== "string" ||
          !["pending", "done", "cancelled"].includes(String(item.state))
        );
      })
    )
      return bad();
  } else if (operation === "report") {
    if (typeof value !== "string") return bad();
  } else if (operation === "cli") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).sort().join() !== "status,stderr,stdout" ||
      !Number.isSafeInteger(item.status) ||
      typeof item.stdout !== "string" ||
      typeof item.stderr !== "string"
    )
      return bad();
  } else return bad();
  return value;
}
export class LegacyTodoOracleAdapter {
  readonly checkVersion = "build-check-v1";
  readonly errorPrefix = "BUILD_";
  readonly allowMissing = false;
  private readonly repo: string;
  private readonly timeout: number;
  constructor(private readonly options: { image: string; repoRoot: string; timeoutMs?: number }) {
    if (!imageReference.test(options.image)) throw new Error("BUILD_IMAGE_DIGEST");
    this.repo = options.repoRoot;
    this.timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 120000)
      throw new Error("BUILD_CHECK_TIMEOUT");
  }
  private container<T>(
    image: string,
    source: string | undefined,
    fn: (id: string, actual: unknown) => Promise<T>
  ): Promise<T> {
    return new LegacyDockerRuntime(this.timeout).withContainer(image, source, fn);
  }
  async describe(input: readonly BuildCheckGroup[]): Promise<BuildCheckDefinition> {
    const groups = groupsOf(input);
    const image = new LegacyDockerRuntime(this.timeout).inspectImage(this.options.image);
    const toolchain = await this.container(image.Id, undefined, async (id) => {
      const metadata = JSON.parse(docker(["exec", id, "node", "/opt/validator/describe.mjs"], this.timeout));
      if (
        metadata.profile !== "cothink-build-validator-v1" ||
        typeof metadata.node !== "string" ||
        metadata.node !== metadata.expectedNode ||
        Number(metadata.node.split(".")[0]) < 22 ||
        !metadata.files ||
        Object.values(metadata.files).some((h) => typeof h !== "string" || !digest.test(h))
      )
        throw new Error("BUILD_TOOLCHAIN_METADATA");
      return metadata;
    });
    const host = join(this.repo, "examples/todo-stats");
    const manifest = JSON.parse(await readFile(join(host, "manifest.json"), "utf8")) as {
      files: { path: string; access: string; contentHash: string }[];
      hostOnly: { path: string; contentHash: string }[];
    };
    const trusted: Record<string, string> = {};
    for (const file of [...manifest.files.filter((f) => f.access === "read-only"), ...manifest.hostOnly]) {
      trusted[file.path] = sha(await readFile(join(host, file.path)));
      if (trusted[file.path] !== file.contentHash) throw new Error("BUILD_HOST_FROZEN");
    }
    for (const file of [
      "package-lock.json",
      "tools/build-validator/Dockerfile",
      "node_modules/vitest/vitest.mjs",
      "node_modules/typescript/lib/typescript.js",
      "node_modules/typescript/lib/_tsc.js"
    ])
      trusted[`host:${file}`] = sha(await readFile(join(this.repo, file)));
    trusted["host:node"] = sha(await readFile(process.execPath));
    trusted["host:validator"] = sha(await readFile(fileURLToPath(import.meta.url)));
    for (const file of [
      "./runtime.js",
      "../kernel/docker-runtime.js",
      "../kernel/verification-types.js",
      "../kernel/data-oracle-verifier.js",
      "../../build/validator.js"
    ]) {
      const modulePath = new URL(file, import.meta.url);
      // Source execution (Vitest) and compiled distribution use the same module closure.
      if (import.meta.url.endsWith(".ts")) modulePath.pathname = modulePath.pathname.replace(/\.js$/, ".ts");
      trusted[`host:${file}`] = sha(await readFile(modulePath));
    }

    // hashVerificationSource and the runtime policy use the same neutral canonical hash helper.
    const coreTree = import.meta.url.endsWith(".ts") ? "src" : "dist";
    trusted["host:core-hash"] = sha(
      await readFile(join(this.repo, "packages/argue", coreTree, "peer/hash." + (coreTree === "src" ? "ts" : "js")))
    );
    const expectedInternal: Record<string, string> = {
      "/opt/toolchain/package-lock.json": trusted["host:package-lock.json"]!,
      "/opt/validator/tsconfig.json": trusted["tsconfig.json"]!,
      "/opt/validator/package.json": trusted["package.json"]!,
      "/opt/validator/types.ts": trusted["src/types.ts"]!,
      "/opt/validator/cli.ts": trusted["src/cli.ts"]!,
      "/opt/toolchain/node_modules/typescript/lib/typescript.js":
        trusted["host:node_modules/typescript/lib/typescript.js"]!,
      "/opt/toolchain/node_modules/typescript/lib/_tsc.js": trusted["host:node_modules/typescript/lib/_tsc.js"]!
    };
    const dockerfile = await readFile(join(this.repo, "tools/build-validator/Dockerfile"), "utf8");
    for (const match of dockerfile.matchAll(/cat > (\/opt\/validator\/[a-z]+\.mjs) <<'JS'\n([\s\S]*?)\nJS/g))
      expectedInternal[match[1]!] = sha(match[2]! + "\n");
    if (
      Object.entries(expectedInternal).some(([path, h]) => toolchain.files[path] !== h) ||
      !digest.test(toolchain.files["/opt/validator/node-version"])
    )
      throw new Error("BUILD_TOOLCHAIN_FROZEN");
    const toolchainHash = hashBuildValue({ imageDigest: image.Id, toolchain, hostNode: process.version, trusted });
    const isolationHash = hashBuildValue({ ...isolation, imageDigest: image.Id });
    const checksHash = hashBuildValue({
      checkVersion: "build-check-v1",
      groups,
      trusted,
      toolchainHash,
      isolationHash,
      imageDigest: image.Id,
      bridge: this.bridgeSource("CONTAINER_ID"),
      oracleArguments: this.oracleArguments("HOST_ROOT", groups),
      oracleConfig: this.oracleConfig(),
      timeoutMs: this.timeout
    });
    return { groups, checksHash, toolchainHash, isolationHash, imageDigest: image.Id };
  }
  private oracleConfig(): string {
    return `export default ${JSON.stringify({ test: { include: ["test/*.test.ts"], pool: "forks", maxWorkers: 1, minWorkers: 1, testTimeout: this.timeout }, resolve: { alias: [{ find: "vitest", replacement: join(this.repo, "node_modules/vitest/dist/index.js") }] } })};\n`;
  }
  private oracleArguments(host: string, groups: readonly BuildCheckGroup[]): string[] {
    return [
      join(this.repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "--root",
      host,
      "--config",
      join(host, "vitest.config.mjs"),
      ...groups.map((g) => `test/${groupFiles[g]}.test.ts`),
      "--reporter=json"
    ];
  }
  private bridgeSource(id: string): string {
    return `import {spawnSync} from 'node:child_process';
const decodeDockerData = ${decodeDockerData.toString()};
function encode(v) { if (v === undefined) return ['undefined']; if (typeof v === 'number') return ['number',String(v)]; if (v === null || typeof v !== 'object') return ['scalar',v]; if (Array.isArray(v)) return ['array',v.map(encode)]; return ['object',Object.entries(v).map(([k,x])=>[k,encode(x)])]; }
export function bridge(operation,input) {
 const r=spawnSync('docker',['exec','-i',${JSON.stringify(id)},'node','/opt/validator/worker.mjs'],{input:JSON.stringify({operation,input:encode(input)}),encoding:'utf8',timeout:5000,maxBuffer:${limit},env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 if(r.error || r.status !== 0 || r.stderr) throw new Error('BUILD_DOCKER_BRIDGE');
 return decodeDockerData(operation,r.stdout);
}`;
  }
  async manifest() {
    return (
      JSON.parse(await readFile(join(this.repo, "examples/todo-stats/manifest.json"), "utf8")) as {
        files: { path: string; access: string; contentHash: string }[];
      }
    ).files;
  }
  receipt(raw: unknown): BuildCheckReceipt {
    return raw as unknown as BuildCheckReceipt;
  }
  async execute(source: string, directory: string, definition: BuildCheckDefinition): Promise<number> {
    const oracle = join(directory, "oracle");
    await cp(join(this.repo, "examples/todo-stats"), oracle, {
      recursive: true,
      filter: (path) => !path.includes("node_modules")
    });
    await writeFile(join(oracle, "vitest.config.mjs"), this.oracleConfig());
    await mkdir(join(oracle, "proxy/src"), { recursive: true });
    await writeFile(join(oracle, "proxy/package.json"), '{"type":"module"}\n');
    return this.container(definition.imageDigest, source, async (id) => {
      const compile = run("docker", ["exec", id, "node", "/opt/validator/compile.mjs"], this.timeout);
      if (compile.error) throw new DockerUnavailable(compile.error.message);
      if (compile.status !== 0) return compile.status ?? 2;
      await writeFile(join(oracle, "proxy/bridge.mjs"), this.bridgeSource(id));
      for (const [name, fn, operation] of [
        ["normalize", "normalizeTasks", "normalize"],
        ["report", "renderReport", "report"]
      ])
        await writeFile(
          join(oracle, `proxy/src/${name}.js`),
          `import {bridge} from '../bridge.mjs'; export const ${fn}=(input)=>bridge('${operation}',input);`
        );
      await writeFile(
        join(oracle, "proxy/src/cli.js"),
        `import {bridge} from '../bridge.mjs'; const chunks=[]; for await (const chunk of process.stdin) chunks.push([...Buffer.from(chunk)]); const result=bridge('cli',chunks); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode=result.status;`
      );
      const tests = run(process.execPath, this.oracleArguments(oracle, definition.groups), this.timeout, undefined, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        BUILD_SAMPLE_COMPILED_ROOT: join(oracle, "proxy")
      });
      if (tests.error) throw new Error("BUILD_ORACLE_EXECUTION");
      let summary: {
        numTotalTests: number;
        numPassedTests: number;
        numFailedTests: number;
        numPendingTests: number;
        testResults: { assertionResults: { status: string }[] }[];
      };
      try {
        summary = JSON.parse(tests.stdout);
      } catch {
        throw new Error("BUILD_ORACLE_DATA");
      }
      const statuses = summary.testResults?.flatMap((suite) => suite.assertionResults.map((result) => result.status));
      if (
        !statuses?.length ||
        summary.numTotalTests !== statuses.length ||
        summary.numPendingTests !== 0 ||
        statuses.some((s) => !["passed", "failed"].includes(s))
      )
        throw new Error("BUILD_ORACLE_INCOMPLETE");
      if (
        tests.status === 0 &&
        (summary.numFailedTests !== 0 ||
          summary.numPassedTests !== summary.numTotalTests ||
          statuses.some((s) => s !== "passed"))
      )
        throw new Error("BUILD_ORACLE_INCONSISTENT");
      return tests.status ?? 2;
    });
  }
}
