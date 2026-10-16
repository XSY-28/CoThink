import { expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { ProjectDockerRuntime } from "../../src/agent-sync/project/runtime.js";
import { DockerRuntime, validateRuntimeIsolation, run } from "../../src/agent-sync/kernel/docker-runtime.js";
vi.mock("node:child_process", { spy: true });
const suppliedImage = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
async function writeRuntimeEvidence(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
test("runtime evidence export creates an initially absent nested destination", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-evidence-export-")));
  const destination = join(root, "absent", "nested", "evidence.json");
  try {
    await expect(readFile(destination, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeRuntimeEvidence(destination, { status: "VERIFIED", probe: "export-only" });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ status: "VERIFIED", probe: "export-only" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!suppliedImage)(
  "actual legacy image exercises new local endpoint and two readonly mount lifecycle only",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-stage7-runtime-")));
    const home = join(root, "home"),
      candidateRoot = join(root, "candidate"),
      configRoot = join(root, "config");
    const records: {
      command: string;
      args: string[];
      environmentKeys: string[];
      status: number | null;
      error?: string;
    }[] = [];
    const observations: Record<string, unknown> = {};
    const original = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const result = original(command, args as string[], options);
      records.push({
        command,
        args: args as string[],
        environmentKeys: Object.keys(options?.env ?? {}).sort(),
        status: result.status,
        ...(result.error ? { error: result.error.name } : {})
      });
      return result;
    });
    try {
      await chmod(root, 0o755);
      for (const path of [home, candidateRoot, configRoot]) await mkdir(path, { mode: 0o755 });
      await writeFile(join(candidateRoot, "sentinel"), "candidate-data", { mode: 0o444 });
      await writeFile(join(configRoot, "runtime.json"), "{}", { mode: 0o444 });
      vi.stubEnv("DOCKER_HOST", "tcp://127.0.0.1:1");
      vi.stubEnv("DOCKER_CONTEXT", "unknown-ambient-context");
      vi.stubEnv("OPENAI_API_KEY", "stage7-dummy-never-a-secret");
      const runtime = new ProjectDockerRuntime({ home, timeoutMs: 10000 });
      const image = runtime.inspectImage(suppliedImage!);
      observations.connection = runtime.connection;
      observations.image = image;
      expect(image.Id).toBe(suppliedImage);
      await expect(runtime.withContainer(`sha256:${"0".repeat(64)}`, {}, async () => true)).rejects.toThrow();
      expect(() => runtime.inspectImage(`sha256:${"0".repeat(64)}`)).toThrow();
      let describeId = "";
      await runtime.withContainer(image.Id, {}, async (c) => {
        describeId = c.id;
        observations.describeDescriptor = c.actual;
        const result = c.runFixed("describe");
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).profile).toBe("cothink-build-validator-v1");
        observations.describeProfile = JSON.parse(result.stdout).profile;
      });
      let escaped: (() => unknown) | undefined;
      let candidateId = "";
      await runtime.withContainer(image.Id, { candidateRoot, configRoot }, async (c) => {
        candidateId = c.id;
        observations.executionDescriptor = c.actual;
        escaped = () => c.runFixed("describe");
        const invocation = c.invocation("worker");
        expect(invocation.args.slice(0, 2)).toEqual(["--host", runtime.connection.endpoint]);
        expect(Object.keys(invocation.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
        // Test-only fixed probe. Production runtime exposes only describe/compile/worker scripts.
        const probe = `const fs=require('node:fs'),net=require('node:net');
if(process.getuid()!==65532||process.getgid()!==65532)throw Error('uid');
if(Object.keys(process.env).sort().join()!=='HOME,HOSTNAME,LANG,PATH')throw Error('env keys: '+Object.keys(process.env).sort().join());
if(fs.existsSync('/var/run/docker.sock'))throw Error('socket');
for(const p of ['/readonly-root-probe','/candidate/sentinel','/runtime-config/runtime.json']){
let blocked=false;try{fs.writeFileSync(p,'forbidden');}catch(e){blocked=['EROFS','EACCES'].includes(e.code);}if(!blocked)throw Error('write allowed');}
const s=net.connect({host:'1.1.1.1',port:80});s.on('connect',()=>process.exit(1));s.on('error',()=>{console.log(JSON.stringify({uid:process.getuid(),readonly:true,networkBlocked:true,environmentKeys:Object.keys(process.env).sort()}));process.exit(0)});setTimeout(()=>process.exit(2),1000);`;
        const result = spawnSync(
          invocation.command,
          ["--host", runtime.connection.endpoint, "exec", c.id, "node", "-e", probe],
          { encoding: "utf8", timeout: 2000, env: invocation.env }
        );
        expect(result.status, result.stderr).toBe(0);
        observations.probe = JSON.parse(result.stdout);
        const privateBridge = join(home, "captured-bridge.mjs");
        // Mirrors the PATH-only frozen CLI harness: connection/env are captured literals, not ambient DOCKER_HOST/HOME.
        const describe = c.invocation("describe");
        await writeFile(
          privateBridge,
          `import {spawnSync} from 'node:child_process';const spec=${JSON.stringify(describe)};const r=spawnSync(spec.command,spec.args,{encoding:'utf8',env:spec.env,timeout:spec.timeout});if(r.error||r.status!==0)process.exit(1);process.stdout.write(r.stdout);`
        );
        const bridge = spawnSync(process.execPath, [privateBridge], {
          encoding: "utf8",
          timeout: 5000,
          env: { PATH: process.env.PATH }
        });
        expect(bridge.status, bridge.stderr).toBe(0);
        observations.pathOnlyBridgeProfile = JSON.parse(bridge.stdout).profile;
      });
      expect(escaped).toThrow("BUILD_DOCKER_CONTAINER_CLOSED");
      expect(await readFile(join(candidateRoot, "sentinel"), "utf8")).toBe("candidate-data");
      expect(await readFile(join(configRoot, "runtime.json"), "utf8")).toBe("{}");
      const inspectRemoved = (id: string) =>
        original(runtime.connection.executable, ["--host", runtime.connection.endpoint, "inspect", id], {
          encoding: "utf8",
          timeout: 3000,
          env: { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" }
        }).status;
      expect(inspectRemoved(describeId)).not.toBe(0);
      expect(inspectRemoved(candidateId)).not.toBe(0);
      let timedId = "";
      const deadline = performance.now() + 1800;
      const began = performance.now();
      await expect(
        runtime.withContainer(
          image.Id,
          {},
          async (c) => {
            timedId = c.id;
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - performance.now() + 30)));
            c.runFixed("describe");
            return true;
          },
          deadline
        )
      ).rejects.toThrow("BUILD_DOCKER_DEADLINE");
      expect(inspectRemoved(timedId)).not.toBe(0);
      expect(performance.now() - began).toBeLessThan(7000);
      observations.deadline = { elapsedMs: performance.now() - began, removed: true };
      const command = (args: string[]) => {
        const r = spawnSync(runtime.connection.executable, ["--host", runtime.connection.endpoint, ...args], {
          encoding: "utf8",
          timeout: 5000,
          env: { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" }
        });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout;
      };
      const raw = new DockerRuntime(5000, { connection: runtime.connection, home });
      const deviations: unknown[] = [];
      for (const deviation of [
        "writable-config",
        "extra-mount",
        "extra-env",
        "entrypoint",
        "devices",
        "volume"
      ] as const) {
        const args = raw.createArgs(image.Id, { candidateRoot, configRoot });
        if (deviation === "writable-config")
          args[args.findIndex((a) => a.includes("destination=/runtime-config"))] =
            `type=bind,source=${configRoot},destination=/runtime-config`;
        if (deviation === "extra-mount")
          args.splice(1, 0, "--mount", `type=bind,source=${home},destination=/unknown,readonly`);
        if (deviation === "extra-env") args.splice(1, 0, "--env", "UNEXPECTED=probe");
        if (deviation === "entrypoint") args[args.indexOf("--entrypoint=node")] = "--entrypoint=sh";
        if (deviation === "devices") args.splice(1, 0, "--device", "/dev/null:/dev/probe");
        if (deviation === "volume") args.splice(1, 0, "--volume", "/extra-volume");
        const id = command(args).trim();
        try {
          const actual = JSON.parse(command(["inspect", id]))[0];
          expect(actual.State.Running).toBe(false);
          expect(() =>
            validateRuntimeIsolation(actual, image.Id, "agent-sync-docker-data-oracle-v1", {
              candidateRoot,
              configRoot
            })
          ).toThrow();
          deviations.push({ deviation, rejectedBeforeStart: true });
        } finally {
          command(["rm", "-f", "-v", id]);
        }
      }
      observations.deviations = deviations;
      observations.cleanup = { describe: true, twoMount: true, deadline: true, deviations: true };
      observations.scope =
        "Existing legacy image; new connection/mount/lifecycle only. No new compiler/image or verifier acceptance claim.";
      observations.arguments = runtime.argumentMetadata();
      observations.policyHash = runtime.policyHash(image.Id);
      const evidence = resolve(
        process.env.COTHINK_RUNTIME_EVIDENCE_FILE ?? "../../../work/agent-sync-stage7/task-5a-real-runtime.json"
      );
      await writeRuntimeEvidence(evidence, {
        status: "VERIFIED",
        executedAt: new Date().toISOString(),
        observations,
        records
      });
    } finally {
      vi.mocked(spawnSync).mockRestore();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000
);

import { DockerVerifier } from "../../src/build/validator.js";
vi.mock("node:fs/promises", { spy: true });
test.skipIf(!suppliedImage)(
  "legacy describe commits extracted runtime and source-hash helper bytes without state IO",
  async () => {
    const read = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile;
    const verifier = new DockerVerifier({} as never, { image: suppliedImage!, repoRoot: resolve("../..") });
    const before = await verifier.describe(["common"]);
    try {
      for (const suffix of [
        "/agent-sync/kernel/docker-runtime.ts",
        "/agent-sync/legacy-v1/runtime.ts",
        "/agent-sync/kernel/verification-types.ts",
        "/peer/hash.ts"
      ]) {
        vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
          const value = await read(...args);
          const path = args[0] instanceof URL ? args[0].pathname : String(args[0]);
          return path.endsWith(suffix)
            ? Buffer.concat([Buffer.from(value), Buffer.from("\n// helper drift probe\n")])
            : value;
        });
        const after = await verifier.describe(["common"]);
        expect(after.checksHash).not.toBe(before.checksHash);
        expect(after.toolchainHash).not.toBe(before.toolchainHash);
        expect(after.isolationHash).toBe(before.isolationHash);
      }
    } finally {
      vi.mocked(readFile).mockRestore();
    }
  },
  30000
);

test("actual subprocess timeout kills a child that ignores SIGTERM", async () => {
  const home = await realpath(tmpdir());
  const invocation = new DockerRuntime(100, {
    connection: { mode: "local-unix-v1", endpoint: "unix:///private/tmp/docker.sock", executable: process.execPath },
    home
  }).invocation("b".repeat(64), "worker");
  const began = performance.now();
  const result = run(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    invocation.timeout,
    undefined,
    invocation.env,
    invocation.killSignal
  );
  expect(result.error?.message).toMatch(/ETIMEDOUT/);
  expect(result.signal).toBe("SIGKILL");
  expect(performance.now() - began).toBeLessThan(1500);
});
