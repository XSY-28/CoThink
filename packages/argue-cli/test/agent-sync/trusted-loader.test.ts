import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { byteHash, treeManifest } from "../../src/agent-sync/checks/measure.js";
let root: string;
let dependencies: Record<string, string>;
const programs = resolve("../../tools/agent-sync-checks"),
  deps = resolve("../../node_modules");
beforeAll(async () => {
  root = await realpath(await mkdtemp(join((await import("node:os")).tmpdir(), "agent-sync-closure-")));
  dependencies = {};
  for (const [p, h] of Object.entries(await treeManifest(deps))) dependencies[await realpath(join(deps, p))] = h;
}, 60000);
afterAll(async () => rm(root, { recursive: true, force: true }));
async function fixture(
  kind: "node" | "decoder" | "vite" | "reporter",
  source: string,
  limit = 8388608,
  warning = false
) {
  const base = await mkdtemp(join(root, "case-")),
    support = join(base, "host"),
    oracle = join(base, "oracle");
  await mkdir(support);
  await mkdir(oracle);
  for (const name of ["bridge.mjs", "node-oracle.mjs", "vitest-oracle.mjs", "guard.mjs", "output-budget.mjs"])
    try {
      await cp(join(programs, name), join(support, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  await cp(resolve("../../tools/agent-sync-validator/protocol.mjs"), join(support, "protocol.mjs"));
  const policyPath = join(support, "policy.json"),
    bootstrap = join(support, "bootstrap.mjs"),
    failure = join(support, "failure"),
    outputBudgetPath = join(support, "output.json"),
    marker = join(support, "vite-active");
  await writeFile(bootstrap, `import {installGuard} from './guard.mjs';installGuard(${JSON.stringify(policyPath)});`);
  await writeFile(join(oracle, "helper.mjs"), "export const value=3;");
  await writeFile(join(oracle, "check.test.ts"), source);
  await writeFile(join(oracle, "checker.mjs"), source);
  const bridgePath = join(support, "invoke.mjs");
  await writeFile(bridgePath, "export const invoke=()=>3;");
  await writeFile(
    outputBudgetPath,
    JSON.stringify({ version: "agent-sync-oracle-output-v1", limit, rawBytes: 0, wrapperBytes: 0 })
  );
  const configPath = join(support, "vitest.config.mjs");
  const config = {
    test: {
      include: ["check.test.ts"],
      pool: "forks",
      maxWorkers: 1,
      minWorkers: 1,
      testTimeout: 10000,
      cache: false,
      poolOptions: { forks: { execArgv: ["--import", bootstrap] } }
    },
    resolve: { alias: [{ find: "vitest", replacement: join(deps, "vitest/dist/index.js") }] }
  };
  await writeFile(
    configPath,
    `import {viteGuard} from ${JSON.stringify(pathToFileURL(join(support, "guard.mjs")).href)};const c=${JSON.stringify(config)};c.plugins=[viteGuard(${JSON.stringify(policyPath)},${JSON.stringify(marker)})];export default c;`
  );
  const job = {
    bridgePath,
    guardPolicyPath: policyPath,
    guardBootstrap: bootstrap,
    configPath,
    guardMarkerPath: marker,
    outputBudgetPath,
    deadlineNs: String(process.hrtime.bigint() + 60000000000n),
    home: base,
    proxyRoot: oracle,
    limits: { maxOracleOutputBytes: limit, checkTimeoutMs: 10000 },
    root: oracle,
    dependencyRoot: deps,
    checks: [
      {
        checkId: "one",
        entry: join(oracle, kind === "node" ? "checker.mjs" : "check.test.ts"),
        parameters: null,
        expectedCaseIds: ["one"]
      }
    ]
  };
  if (kind === "reporter") {
    const fakeDeps = join(base, "dependencies");
    await mkdir(join(fakeDeps, "vitest"), { recursive: true });
    job.dependencyRoot = fakeDeps;
    const reporter = {
      testResults: [
        {
          name: join(oracle, "check.test.ts"),
          assertionResults: [{ ancestorTitles: ["suite"], title: "one", status: "passed" }]
        }
      ],
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      padding: "x".repeat(500)
    };
    await writeFile(
      join(fakeDeps, "vitest/vitest.mjs"),
      `import {writeFileSync,readFileSync} from 'node:fs';import {createHash}from'node:crypto';writeFileSync(${JSON.stringify(marker)},'sha256:'+createHash('sha256').update(readFileSync(${JSON.stringify(policyPath)})).digest('hex'));process.stdout.write(${JSON.stringify(JSON.stringify(reporter))});${warning ? "process.stderr.write('warning');" : ""}`
    );
  }
  if (kind === "decoder") {
    await writeFile(join(oracle, "decoder.mjs"), source);
    const bridgeJob = {
      guardPolicyPath: policyPath,
      deadlineNs: job.deadlineNs,
      limits: {
        maxDepth: 32,
        maxElements: 10000,
        maxRpcBytes: 1024,
        maxResultBytes: 1024,
        maxTotalRpcBytes: 4096,
        maxTotalResultBytes: 4096,
        maxCalls: 5,
        callTimeoutMs: 2000
      },
      budgetPath: join(support, "rpc.json"),
      decoders: [{ operationId: "evaluate", path: join(oracle, "decoder.mjs"), exportName: "decode" }],
      invocation: {
        command: process.execPath,
        args: [
          "-e",
          "let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);delete r.input;process.stdout.write(JSON.stringify({...r,ok:true,value:['number','3']}))"
        ],
        env: { PATH: process.env.PATH }
      }
    };
    const bytes = JSON.stringify(bridgeJob),
      h = byteHash(bytes);
    await writeFile(join(support, "bridge-job.json"), bytes);
    await writeFile(bridgeJob.budgetPath, JSON.stringify({ jobHash: h, calls: 0, inputBytes: 0, outputBytes: 0 }));
    await writeFile(
      join(support, "decoder-probe.mjs"),
      `import{createBridge}from'./bridge.mjs';const f=await createBridge(${JSON.stringify(join(support, "bridge-job.json"))},${JSON.stringify(h)});process.stdout.write(String(f('evaluate',2)));`
    );
  }
  await writeFile(join(support, "job.json"), JSON.stringify(job));
  const files: Record<string, string> = { ...(kind === "vite" ? dependencies : {}) };
  for (const [p, h] of Object.entries(await treeManifest(base))) files[join(base, p)] = h;
  await writeFile(policyPath, JSON.stringify({ version: "agent-sync-host-closure-v1", files, failurePath: failure }));
  const entry =
    kind === "decoder"
      ? join(support, "decoder-probe.mjs")
      : join(support, kind === "node" ? "node-oracle.mjs" : "vitest-oracle.mjs");
  const run = () =>
    spawnSync(process.execPath, [entry, join(support, "job.json")], {
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH, HOME: base, LANG: "C.UTF-8" }
    });
  return { base, oracle, support, run, outputBudgetPath, policyPath, failure };
}
describe("actual trusted module closure", () => {
  for (const kind of ["node", "decoder", "vite"] as const) {
    it.each(["absolute", "file-url", "relative"])(
      `${kind}: rejects an external %s helper`,
      async (form) => {
        const helper = join(root, `external-${kind}.mjs`);
        await writeFile(helper, "export const value=3;");
        const source =
          `import {value} from ${JSON.stringify(form === "absolute" ? helper : form === "file-url" ? pathToFileURL(helper).href : `../../external-${kind}.mjs`)};` +
          (kind === "node"
            ? "export default async ctx=>{await ctx.case('one',()=>{if(value!==3)throw Error('value');});};"
            : kind === "decoder"
              ? "export const decode=()=>value;"
              : "import {describe,it,expect} from 'vitest';describe('suite',()=>it('one',()=>expect(value).toBe(3)));");
        const f = await fixture(kind, source);
        expect(f.run().status).not.toBe(0);
      },
      60000
    );
    it(`${kind}: allows declared relative helper and refuses changed copied helper`, async () => {
      const source =
        "import {value} from './helper.mjs';" +
        (kind === "node"
          ? "export default async ctx=>{await ctx.case('one',()=>{if(value!==3)throw Error('value');});};"
          : kind === "decoder"
            ? "export const decode=()=>value;"
            : "import {describe,it,expect} from 'vitest';describe('suite',()=>it('one',()=>expect(value).toBe(3)));");
      const f = await fixture(kind, source),
        first = f.run();
      expect(first.status, first.stderr + (await readFile(f.failure, "utf8").catch(() => ""))).toBe(0);
      await writeFile(join(f.oracle, "helper.mjs"), "export const value=3; // changed bytes, same behavior");
      expect(f.run().status).not.toBe(0);
    }, 60000);
  }
  it("counts two raw nested reports against one cap rather than normalized summaries", async () => {
    const f = await fixture("reporter", "", 1400);
    expect(f.run().status).toBe(0);
    expect(f.run().status).not.toBe(0);
    const used = JSON.parse(await readFile(f.outputBudgetPath, "utf8"));
    expect(used.rawBytes).toBeGreaterThan(1400);
    expect(await readFile(f.failure, "utf8")).toContain("failure");
  });
  it("rejects unexpected nested framework stderr even with a passed JSON report", async () => {
    const f = await fixture("reporter", "", 4096, true);
    expect(f.run().status).not.toBe(0);
    expect(JSON.parse(await readFile(f.outputBudgetPath, "utf8")).rawBytes).toBeGreaterThan(0);
    expect(await readFile(f.failure, "utf8")).toContain("failure");
  });
  it("native CommonJS resolution rejects an escaped required file", async () => {
    const helper = join(root, "external.cjs");
    await writeFile(helper, "module.exports={value:3};");
    const f = await fixture(
      "node",
      `import{createRequire}from'node:module';const r=createRequire(import.meta.url);const {value}=r(${JSON.stringify(helper)});export default async c=>{await c.case('one',()=>{if(value!==3)throw Error('x');});};`
    );
    expect(f.run().status).not.toBe(0);
    expect(JSON.parse(await readFile(f.failure, "utf8")).boundary).toBe("native");
  });
  it("Vite transformed absolute TypeScript imports are refused by the Vite guard itself", async () => {
    const helper = join(root, "external.ts");
    await writeFile(helper, "export const value: number=3;");
    const f = await fixture(
      "vite",
      `import{value}from ${JSON.stringify(helper)};import{describe,it,expect}from'vitest';describe('suite',()=>it('one',()=>expect(value).toBe(3)));`
    );
    expect(f.run().status).not.toBe(0);
    expect(JSON.parse(await readFile(f.failure, "utf8")).boundary).toBe("vite");
  }, 60000);
  it("missing native hook capability refuses the oracle rather than running unguarded", async () => {
    const f = await fixture("node", "export default async c=>{await c.case('one',()=>{});};"),
      disable = join(f.support, "disable.mjs");
    await writeFile(
      disable,
      "import{createRequire,syncBuiltinESMExports}from'node:module';createRequire(import.meta.url)('node:module').registerHooks=undefined;syncBuiltinESMExports();"
    );
    const result = spawnSync(
      process.execPath,
      ["--import", disable, join(f.support, "node-oracle.mjs"), join(f.support, "job.json")],
      { encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AGENT_SYNC_GUARD_UNAVAILABLE");
  });

  it("rejects package resolution to an undeclared external dependency", async () => {
    const packageRoot = join(root, "node_modules/escape-helper");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), '{"type":"module","exports":"./index.mjs"}');
    await writeFile(join(packageRoot, "index.mjs"), "export const value=3;");
    const f = await fixture(
      "node",
      "import{value}from'escape-helper';export default async c=>{await c.case('one',()=>{if(value!==3)throw Error('x');});};"
    );
    expect(f.run().status).not.toBe(0);
  });
});
