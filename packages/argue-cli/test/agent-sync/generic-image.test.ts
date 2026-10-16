import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { DockerRuntime, validateRuntimeIsolation } from "../../src/agent-sync/kernel/docker-runtime.js";
import { ProjectDockerRuntime } from "../../src/agent-sync/project/runtime.js";
import { encode, readEnvelope } from "../../../../tools/agent-sync-validator/protocol.mjs";
const image = process.env.COTHINK_AGENT_SYNC_VALIDATOR_IMAGE;
const limits = {
  checkTimeoutMs: 120000,
  callTimeoutMs: 1000,
  maxRpcBytes: 1048576,
  maxResultBytes: 1048576,
  maxOracleOutputBytes: 1048576,
  maxCalls: 100,
  maxDepth: 64,
  maxElements: 100000
};
describe.skipIf(!image)("actual generic fixed image", () => {
  it("measures exact fixed programs and executes compile/RPC without host candidate imports", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-image-")));
    const home = join(root, "home"),
      candidateRoot = join(root, "candidate"),
      configRoot = join(root, "config");
    await Promise.all([mkdir(home), mkdir(candidateRoot), mkdir(configRoot)]);
    const runtime = new ProjectDockerRuntime({ home, timeoutMs: 120000 });
    const config = {
      version: "agent-sync-runtime-config-v1",
      files: ["math.ts"],
      compiler: { target: "ES2022", module: "NodeNext", strict: true },
      typeModules: [],
      runtimeModules: [],
      builtins: [],
      operations: [{ id: "math", kind: "function", module: "math.ts", exportName: "evaluate" }],
      limits
    };
    try {
      const actual = runtime.inspectImage(image!);
      const deadline = performance.now() + 120000;
      const metadata = await runtime.withContainer(
        actual.Id,
        {},
        async (c) => JSON.parse(c.runFixed("describe").stdout),
        deadline
      );
      expect(metadata.profile).toBe("agent-sync-validator-v1");
      expect(metadata.node).toBe("22.23.3");
      expect(Object.keys(metadata.files)).toHaveLength(7);
      await writeFile(
        join(candidateRoot, "math.ts"),
        "export function evaluate(x: number) { return {value:x*2,passed:true}; }"
      );
      await writeFile(join(configRoot, "config.json"), JSON.stringify(config));
      await runtime.withContainer(
        actual.Id,
        { candidateRoot, configRoot },
        async (c) => {
          const compile = c.runFixed("compile");
          expect(compile.error).toBeUndefined();
          expect(compile.status, compile.stderr + compile.stdout).toBe(0);
          const request = {
            rpcVersion: "agent-sync-data-rpc-v1",
            requestId: "probe1",
            operationId: "math",
            input: encode(3, limits)
          };
          const result = c.runFixed("worker", JSON.stringify(request));
          expect(result.status, result.stderr).toBe(0);
          expect(readEnvelope(result.stdout, request, limits)).toEqual({ value: 6, passed: true });
          const wrong = c.runFixed("worker", JSON.stringify({ ...request, operationId: "undeclared" }));
          expect(wrong.status).not.toBe(0);
          for (const malformed of [
            JSON.stringify({ ...request, passed: true }),
            JSON.stringify(request).slice(0, -1),
            JSON.stringify(request).replace('"requestId":"probe1"', '"requestId":"other","requestId":"probe1"')
          ])
            expect(c.runFixed("worker", malformed).status).not.toBe(0);
        },
        deadline
      );
      await writeFile(
        join(candidateRoot, "math.ts"),
        "import fs from 'node:fs'; export const evaluate=()=>fs.readFileSync('/etc/passwd','utf8');"
      );
      await runtime.withContainer(
        actual.Id,
        { candidateRoot, configRoot },
        async (c) => expect(c.runFixed("compile").status).not.toBe(0),
        deadline
      );
      if (process.env.COTHINK_TASK5B_IMAGE_METADATA)
        await writeFile(
          process.env.COTHINK_TASK5B_IMAGE_METADATA,
          JSON.stringify({ imageId: actual.Id, metadata }, null, 2)
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
  it("retains readonly, no-secret, no-network policy on the new actual image and rejects daemon mount deviations", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-new-isolation-"))),
      home = join(root, "home"),
      candidateRoot = join(root, "candidate"),
      configRoot = join(root, "config");
    await Promise.all([mkdir(home), mkdir(candidateRoot), mkdir(configRoot)]);
    try {
      await writeFile(join(candidateRoot, "sentinel"), "source");
      await writeFile(join(configRoot, "config.json"), "{}");
      vi.stubEnv("OPENAI_API_KEY", "dummy-private");
      vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
      const runtime = new ProjectDockerRuntime({ home, timeoutMs: 5000 });
      const command = (args: string[]) =>
        spawnSync(runtime.connection.executable, ["--host", runtime.connection.endpoint, ...args], {
          encoding: "utf8",
          timeout: 5000,
          env: { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" }
        });
      await runtime.withContainer(image!, { candidateRoot, configRoot }, async (c) => {
        const probe =
          "const fs=require('node:fs'),net=require('node:net');if(process.getuid()!==65532||Object.keys(process.env).sort().join()!=='HOME,HOSTNAME,LANG,PATH'||fs.existsSync('/var/run/docker.sock'))throw Error('isolation');for(const p of ['/root-probe','/candidate/sentinel','/runtime-config/config.json']){let blocked=false;try{fs.writeFileSync(p,'bad');}catch(e){blocked=['EROFS','EACCES'].includes(e.code);}if(!blocked)throw Error('write');}const s=net.connect({host:'1.1.1.1',port:80});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(2),1000);";
        const result = command(["exec", c.id, "node", "-e", probe]);
        expect(result.status, result.stderr).toBe(0);
      });
      const raw = new DockerRuntime(5000, { connection: runtime.connection, home });
      for (const mode of ["writable", "extra"]) {
        const args = raw.createArgs(image!, { candidateRoot, configRoot });
        if (mode === "writable")
          args[args.findIndex((a) => a.includes("destination=/runtime-config"))] =
            `type=bind,source=${configRoot},destination=/runtime-config`;
        else args.splice(1, 0, "--mount", `type=bind,source=${home},destination=/unknown,readonly`);
        const created = command(args);
        expect(created.status, created.stderr).toBe(0);
        const id = created.stdout.trim();
        try {
          const actual = JSON.parse(command(["inspect", id]).stdout)[0];
          expect(() =>
            validateRuntimeIsolation(actual, image!, "agent-sync-docker-data-oracle-v1", { candidateRoot, configRoot })
          ).toThrow();
        } finally {
          expect(command(["rm", "-f", "-v", id]).status).toBe(0);
        }
      }
      expect(() => runtime.inspectImage("sha256:" + "0".repeat(64))).toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
