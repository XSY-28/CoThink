import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { runHostOracle } from "./host-process.js";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectDockerRuntime } from "../project/runtime.js";
import { type TrustedCheckConfig } from "./config.js";
import { byteHash, copyTrusted, measureArtifacts, checkTime, treeManifest } from "./measure.js";
import { hostFiles, bridgeTemplate, guardBootstrapTemplate } from "./evidence.js";
import { oracleExit } from "./oracle-result.js";
type Container = Parameters<Parameters<ProjectDockerRuntime["withContainer"]>[2]>[0];
export async function executeOracle(
  config: TrustedCheckConfig,
  trustedRoot: string,
  programRoot: string,
  directory: string,
  groups: readonly string[],
  container: Container,
  deadline: number,
  deadlineNs: string
): Promise<number> {
  const oracle = join(directory, "oracle"),
    support = join(directory, "host"),
    home = join(directory, "home"),
    proxy = join(oracle, "proxy");
  await mkdir(support, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(oracle, { mode: 0o700 });
  await mkdir(proxy, { recursive: true });
  await copyTrusted(config, trustedRoot, oracle, deadline);
  const immutable: Record<string, string> = {};
  const save = async (path: string, bytes: string | Buffer) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o444 });
    immutable[path] = byteHash(bytes);
  };
  for (const name of hostFiles)
    await save(join(support, name), await readFile(join(programRoot, "agent-sync-checks", name)));
  await save(join(support, "protocol.mjs"), await readFile(join(programRoot, "agent-sync-validator/protocol.mjs")));
  const guardPolicyPath = join(support, "policy.json"),
    guardBootstrap = join(support, "bootstrap.mjs"),
    outputBudgetPath = join(support, "oracle-output.json");
  await save(guardBootstrap, guardBootstrapTemplate);
  await writeFile(
    outputBudgetPath,
    JSON.stringify({
      version: "agent-sync-oracle-output-v1",
      limit: config.limits.maxOracleOutputBytes,
      rawBytes: 0,
      wrapperBytes: 0
    }),
    { mode: 0o600 }
  );
  const budgetPath = join(support, "budget.json"),
    jobPath = join(support, "bridge-job.json");
  const job = {
    guardPolicyPath,
    deadlineNs,
    limits: config.limits,
    budgetPath,
    decoders: config.decoders.map((d) => ({ ...d, path: join(oracle, d.module) })),
    invocation: container.invocation("worker")
  };
  const jobBytes = JSON.stringify(job),
    jobHash = byteHash(jobBytes);
  await save(jobPath, jobBytes);
  await writeFile(budgetPath, JSON.stringify({ jobHash, calls: 0, inputBytes: 0, outputBytes: 0 }), { mode: 0o600 });
  const bridgePath = join(support, "invoke.mjs");
  await save(
    bridgePath,
    bridgeTemplate.replace("JOB_PATH", JSON.stringify(jobPath)).replace("JOB_HASH", JSON.stringify(jobHash))
  );
  await save(join(proxy, "package.json"), '{"type":"module"}\n');
  for (const p of config.proxies) {
    const prefix = `import {invoke} from ${JSON.stringify("file://" + bridgePath)};\n`;
    const body =
      p.kind === "function"
        ? `export const ${p.exportName}=(input)=>invoke(${JSON.stringify(p.operationId)},input);`
        : `const chunks=[]; for await(const c of process.stdin)chunks.push([...Buffer.from(c)]);const result=invoke(${JSON.stringify(p.operationId)},chunks);process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;`;
    await save(join(proxy, p.path), prefix + body);
  }
  const jobs: { path: string; kind: string; checkId: string }[] = [];
  for (const checkId of groups) {
    const check = config.checks.find((c) => c.checkId === checkId)!;
    const oracleConfig = config.oracles.find((o) => o.oracleId === check.oracleId)!;
    const dependency = config.dependencies.find((d) => d.id === oracleConfig.dependencyId);
    const path = join(support, "oracle-" + checkId + ".json"),
      configPath = join(support, "vitest-" + checkId + ".config.mjs"),
      guardMarkerPath = join(support, "vite-" + checkId + ".active");
    const runnerJob = {
      bridgePath,
      guardPolicyPath,
      guardBootstrap,
      configPath,
      guardMarkerPath,
      outputBudgetPath,
      deadlineNs,
      home,
      proxyRoot: proxy,
      limits: config.limits,
      root: join(oracle, oracleConfig.root ?? ""),
      dependencyRoot: dependency ? join(oracle, dependency.relativePath) : null,
      checks: [{ ...check, entry: join(oracle, oracleConfig.entry) }]
    };
    if (oracleConfig.kind === "vitest-proxy") {
      const viteConfig = {
        test: {
          include: runnerJob.checks.map((c) => relative(runnerJob.root, c.entry)),
          pool: "forks",
          maxWorkers: 1,
          minWorkers: 1,
          testTimeout: config.limits.checkTimeoutMs,
          cache: false,
          poolOptions: { forks: { execArgv: ["--import", guardBootstrap] } }
        },
        resolve: { alias: [{ find: "vitest", replacement: join(runnerJob.dependencyRoot!, "vitest/dist/index.js") }] }
      };
      await save(
        configPath,
        `import {viteGuard} from ${JSON.stringify(pathToFileURL(join(support, "guard.mjs")).href)}; const config=${JSON.stringify(viteConfig)}; config.plugins=[viteGuard(${JSON.stringify(guardPolicyPath)},${JSON.stringify(guardMarkerPath)})]; export default config;\n`
      );
    }
    await save(path, JSON.stringify(runnerJob));
    jobs.push({ path, kind: oracleConfig.kind, checkId });
  }
  const allowedFiles: Record<string, string> = { ...immutable };
  for (const artifact of config.artifacts) allowedFiles[join(oracle, artifact.relativePath)] = artifact.expectedHash;
  for (const dependency of config.dependencies)
    for (const [path, hash] of Object.entries(await treeManifest(join(oracle, dependency.relativePath), deadline)))
      allowedFiles[join(oracle, dependency.relativePath, path)] = hash;
  await save(
    guardPolicyPath,
    JSON.stringify({ version: "agent-sync-host-closure-v1", files: allowedFiles, failurePath: budgetPath + ".failed" })
  );
  const outputBudget = async () => {
    const b = JSON.parse(await readFile(outputBudgetPath, "utf8")) as {
      version: string;
      limit: number;
      rawBytes: number;
      wrapperBytes: number;
    };
    if (
      Object.keys(b).sort().join() !== "limit,rawBytes,version,wrapperBytes" ||
      b.version !== "agent-sync-oracle-output-v1" ||
      b.limit !== config.limits.maxOracleOutputBytes ||
      ![b.rawBytes, b.wrapperBytes].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw new Error("AGENT_SYNC_ORACLE_BUDGET");
    return b;
  };
  let exitCode = 0;
  for (const job of jobs) {
    const before = await outputBudget();
    const args = [join(support, job.kind === "node-assert" ? "node-oracle.mjs" : "vitest-oracle.mjs"), job.path];
    const result = await runHostOracle(args, home, deadline, before.limit - before.rawBytes - before.wrapperBytes);
    checkTime(deadline);
    const after = await outputBudget();
    after.wrapperBytes += Buffer.byteLength(result.stdout || "") + Buffer.byteLength(result.stderr || "");
    await writeFile(outputBudgetPath, JSON.stringify(after));
    if (result.failed || result.stderr || after.rawBytes + after.wrapperBytes > after.limit) {
      await writeFile(budgetPath + ".failed", "oracle-output-failure");
      throw new Error("AGENT_SYNC_ORACLE_EXECUTION");
    }
    exitCode = Math.max(exitCode, oracleExit(result.stdout, result.status, config, [job.checkId]));
  }
  for (const [path, expected] of Object.entries(immutable))
    if (byteHash(await readFile(path)) !== expected) throw new Error("AGENT_SYNC_EXECUTED_PROGRAM_CHANGED");
  await measureArtifacts(config, oracle, deadline);
  try {
    await lstat(budgetPath + ".failed");
    throw new Error("AGENT_SYNC_RPC_INFRASTRUCTURE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const budget = JSON.parse(await readFile(budgetPath, "utf8")) as {
    jobHash: string;
    calls: number;
    inputBytes: number;
    outputBytes: number;
  };
  if (
    budget.jobHash !== jobHash ||
    budget.calls > config.limits.maxCalls ||
    budget.inputBytes > config.limits.maxTotalRpcBytes ||
    budget.outputBytes > config.limits.maxTotalResultBytes
  )
    throw new Error("AGENT_SYNC_BUDGET");
  // Persist private usage evidence for the caller's optional audit sink, never worker runtime config.
  const finalOutput = await outputBudget();
  await writeFile(
    join(directory, "usage.json"),
    JSON.stringify({
      ...budget,
      oracleRawChildOutputBytes: finalOutput.rawBytes,
      oracleWrapperOutputBytes: finalOutput.wrapperBytes,
      oracleOutputBytes: finalOutput.rawBytes + finalOutput.wrapperBytes
    })
  );
  return exitCode;
}
