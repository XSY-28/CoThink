import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { configInput } from "./trusted-checks-fixture.js";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const projectCore = resolve(repo, "packages/argue/src/agent-sync/project/index.ts");
const projectHost = resolve(repo, "packages/argue-cli/src/agent-sync/project/index.ts");
const forbidden =
  /(?:packages\/(?:argue|argue-cli)\/src\/(?:index\.ts$|cli\.ts$|build\/|core\/|discussion\/|transport\/|runtime\/|model-api\/|peer\/(?!hash\.ts$)|config\.ts$|env[^/]*\.ts$)|\/agent-sync\/(?:legacy-v1\/|adapters\/|(?:index|service|local|initialize)\.ts$)|node_modules\/(?:@ai-sdk\/|ai\/))/;
async function bundle(entry: string) {
  return build({
    absWorkingDir: repo,
    entryPoints: [entry],
    bundle: true,
    treeShaking: false,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    metafile: true,
    logLevel: "silent",
    alias: {
      "@onevcat/argue/agent-sync/project": projectCore,
      "@onevcat/argue/agent-sync/legacy-v1": resolve(repo, "packages/argue/src/agent-sync/legacy-v1/index.ts"),
      "@onevcat/argue/agent-sync": resolve(repo, "packages/argue/src/agent-sync/index.ts"),
      "@onevcat/argue": resolve(repo, "packages/argue/src/index.ts")
    }
  });
}

describe("strict independent project public entry", () => {
  test.each([projectCore, projectHost])(
    "static full closure excludes legacy, business and models: %s",
    async (entry) => {
      const result = await bundle(entry);
      expect(Object.keys(result.metafile.inputs).filter((path) => forbidden.test(path))).toEqual([]);
      const external = Object.values(result.metafile.outputs).flatMap((o) =>
        o.imports.filter((i) => i.external).map((i) => i.path)
      );
      expect(external.filter((path) => /^(?:@onevcat\/argue(?:\/|$)|@ai-sdk\/|ai$|dotenv(?:\/|$))/.test(path))).toEqual(
        []
      );
      if (entry === projectHost) {
        for (const path of [
          "project/local",
          "project/initialize",
          "project/verifier",
          "kernel/local-session",
          "kernel/initialize"
        ])
          expect(Object.keys(result.metafile.inputs)).toContain(`packages/argue-cli/src/agent-sync/${path}.ts`);
      }
    }
  );
  test("legacy root remains a positive static rejection control", async () => {
    const result = await bundle(resolve(repo, "packages/argue/src/index.ts"));
    expect(Object.keys(result.metafile.inputs).filter((path) => forbidden.test(path))).toContain(
      "packages/argue/src/build/driver.ts"
    );
  });
  test("package exports retain real semver and all strict format entries", async () => {
    for (const pkg of ["argue", "argue-cli"]) {
      const meta = JSON.parse(await readFile(resolve(repo, `packages/${pkg}/package.json`), "utf8"));
      expect(meta.version).toBe("0.6.1");
      for (const entry of ["agent-sync", "agent-sync/project", "agent-sync/legacy-v1"])
        expect(meta.exports[`./${entry}`]).toEqual({
          types: `./dist/${entry}/index.d.ts`,
          import: `./dist/${entry}/index.js`
        });
      if (pkg === "argue-cli") expect(meta.dependencies["@onevcat/argue"]).toBe("^0.6.1");
    }
  });
  test("compiled modules initialize/recover from arbitrary cwd with explicit assets under runtime import guard", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-project-entry-")));
    try {
      const trace = join(root, "trace.jsonl"),
        registration = join(root, "register.mjs"),
        script = join(root, "probe.mjs");
      const guard = pathToFileURL(resolve(repo, "scripts/agent-sync-project-import-guard.mjs")).href;
      await writeFile(
        registration,
        `import { register } from 'node:module'; register(${JSON.stringify(guard)}, { data: { trace: ${JSON.stringify(trace)} } });`
      );
      const entry = (path: string) => JSON.stringify(pathToFileURL(resolve(repo, path)).href);
      await writeFile(
        script,
        `
        import assert from 'node:assert/strict';
        import { mkdir, writeFile, readFile } from 'node:fs/promises';
        import { createHash } from 'node:crypto';
        const core = await import(${entry("packages/argue/dist/agent-sync/project/index.js")});
        const host = await import(${entry("packages/argue-cli/dist/agent-sync/project/index.js")});
        assert.equal(typeof host.LocalAgentSync, 'function');
        assert.equal(typeof host.initializeAgentSyncProject, 'function');
        assert.equal(host.FileBuildStore, undefined);
        assert.equal(core.BuildDriver, undefined);
        for (const path of ['managed', 'source/lib', 'trusted', 'home', 'bin']) await mkdir(path, { recursive: true });
        await writeFile('bin/docker', '#!/bin/sh\\nexit 97\\n', {mode: 0o755});
        process.env.PATH = process.cwd() + '/bin:' + process.env.PATH;
        const bytes = 'export const evaluate = () => 3;\\n';
        await writeFile('source/lib/value.ts', bytes);
        await writeFile('trusted/oracle.mjs', 'export {};');
        await writeFile('trusted/decoder.mjs', 'export const decode = x => x;');
        const config = await host.measureTrustedConfiguration(${JSON.stringify(configInput())}, process.cwd()+'/trusted');
        const project = core.freezeAgentSyncProject({
          projectVersion: core.AGENT_SYNC_PROJECT_VERSION, projectKey: 'portable', memberIds: ['person'],
          manifest: [{path:'lib/value.ts', access:'writable', contentHash:'sha256:'+createHash('sha256').update(bytes).digest('hex')}],
          tasks:[{taskId:'change',workerId:'person',scope:{read:[],write:['lib/value.ts']},dependsOn:[],checkProfileId:'full'}],
          profiles:config.profiles,finalProfileId:config.finalProfileId,checkConfigurationHash:host.configurationHash(config)
        });
        const local = new host.LocalAgentSync({ workspaceRoot:process.cwd()+'/managed', sourceRoot:process.cwd()+'/source',
          project, config, runId:'run', image:'sha256:'+'a'.repeat(64), trustedRoot:process.cwd()+'/trusted',
          programRoot:${JSON.stringify(resolve(repo, "tools"))}, home:process.cwd()+'/home', clock:()=>1000 });
        await local.withSession(async s => {
          assert.equal((await s.status()).serviceVersion, 'agent-sync-project-service-v1');
          assert.equal((await s.recover('recover')).replayedActions,0);
          assert.deepEqual((await s.diff()).files,[]);
          await s.exportVersion({target:process.cwd()+'/export'});
        });
        assert.equal(await readFile('export/lib/value.ts','utf8'),bytes);
      `
      );
      const run = (args: string[]) =>
        spawnSync(process.execPath, ["--import", registration, ...args], {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root },
          encoding: "utf8",
          timeout: 120000
        });
      const result = run([script]);
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const loaded = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(loaded.every((line) => line.decision === "allowed")).toBe(true);
      expect(loaded.some((line) => line.url.endsWith("/agent-sync/project/local.js"))).toBe(true);
      const denied = run(["--input-type=module", "-e", `await import(${entry("packages/argue/dist/index.js")});`]);
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toContain("AGENT_SYNC_PROJECT_IMPORT_DENIED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
