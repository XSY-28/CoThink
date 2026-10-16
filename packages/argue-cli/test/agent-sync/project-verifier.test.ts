import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import * as core from "../../../argue/src/agent-sync/project/index.js";
import { FileAgentSyncStore } from "../../src/agent-sync/project/storage.js";
import { ProjectDockerVerifier } from "../../src/agent-sync/project/verifier.js";
import { ProjectDockerRuntime } from "../../src/agent-sync/project/runtime.js";
import { configurationHash } from "../../src/agent-sync/checks/config.js";
import { byteHash, measureTrustedConfiguration } from "../../src/agent-sync/checks/measure.js";
import { readRuntimeMetadata } from "../../src/agent-sync/checks/evidence.js";
import { createTodoTrustedChecks } from "../../src/agent-sync/adapters/todo-checks.js";
import { configInput } from "./trusted-checks-fixture.js";
const image = process.env.COTHINK_AGENT_SYNC_VALIDATOR_IMAGE;
const programRoot = resolve("../../tools");
const repo = resolve("../..");
async function fixture(
  body: (ctx: {
    root: string;
    source: string;
    trusted: string;
    home: string;
    metadata: Awaited<ReturnType<typeof readRuntimeMetadata>>;
  }) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-verifier-"))),
    source = join(root, "input"),
    trusted = join(root, "trusted"),
    home = join(root, "home");
  await Promise.all([mkdir(source), mkdir(trusted), mkdir(home)]);
  try {
    const runtime = new ProjectDockerRuntime({ home });
    const metadata = await readRuntimeMetadata(runtime, runtime.inspectImage(image!).Id);
    await body({ root, source, trusted, home, metadata });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function projectRun(
  ctx: { root: string; source: string },
  config: Awaited<ReturnType<typeof measureTrustedConfiguration>>,
  manifest: core.AgentSyncProject["manifest"],
  body: (args: {
    writer: Parameters<Parameters<FileAgentSyncStore["withWriter"]>[0]>[0];
    project: core.AgentSyncProject;
    candidate: { attemptId: string; baseVersion: string; version: string; candidateHash: string; planHash: string };
  }) => Promise<void>
) {
  manifest = await Promise.all(
    manifest.map(async (e) =>
      e.access === "writable" ? { ...e, contentHash: byteHash(await readFile(join(ctx.source, e.path), "utf8")) } : e
    )
  );
  const project = core.freezeAgentSyncProject({
    projectVersion: core.AGENT_SYNC_PROJECT_VERSION,
    projectKey: "probe",
    memberIds: ["operator"],
    manifest,
    tasks: [
      {
        taskId: "change",
        workerId: "operator",
        scope: {
          read: manifest.filter((e) => e.access === "read-only").map((e) => e.path),
          write: manifest.filter((e) => e.access === "writable").map((e) => e.path)
        },
        dependsOn: [],
        checkProfileId: config.finalProfileId
      }
    ],
    profiles: config.profiles,
    finalProfileId: config.finalProfileId,
    checkConfigurationHash: configurationHash(config)
  });
  const store = new FileAgentSyncStore({ workspaceRoot: ctx.root, projectKey: "probe" });
  await store.withWriter(async (writer) => {
    await writer.gitFor(project).initialize();
    const version = await writer.git.importSource(ctx.source),
      now = Date.now();
    await writer.commit(-1, core.createAgentSyncState({ project, runId: "run", acceptedVersion: version, now }));
    const lease = await writer.transaction(async (state) => {
      const t = core.reserveAgentSyncScope(
        state,
        {
          requestVersion: core.AGENT_SYNC_REQUEST_VERSION,
          operation: "reserve",
          requestId: "reserve",
          taskId: "change",
          workerId: "operator",
          ownerEpoch: state.ownerEpoch
        },
        now,
        () => ({ attemptId: "attempt", token: "private-token" })
      );
      if (t.result.kind !== "granted") throw new Error("grant");
      return { state: t.state, value: t.result.lease };
    });
    const files = Object.entries(await writer.git.readFiles(version))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, f]) => ({ path, contentHash: f.contentHash }));
    await body({
      writer,
      project,
      candidate: {
        attemptId: lease.attemptId,
        baseVersion: version,
        version,
        candidateHash: core.hashJson({ baseVersion: version, files }),
        planHash: project.planHash
      }
    });
  });
}
describe.skipIf(!image)("actual project verifier through shared lifecycle", () => {
  it(
    "runs trusted assertions, owns receipts, describes inside serialization, rejects data fake-passed and fresh helper drift",
    async () =>
      fixture(async (ctx) => {
        await mkdir(join(ctx.source, "lib"));
        await writeFile(join(ctx.source, "lib/value.ts"), "export function evaluate(x: number) { return x+1; }");
        await writeFile(
          join(ctx.trusted, "oracle.mjs"),
          "import {expected} from './helper.mjs';import assert from 'node:assert/strict';import {statSync} from 'node:fs'; export default async ctx=>{assert.deepEqual(Object.keys(process.env).sort(),['HOME','LANG','PATH']);assert.equal(statSync(process.env.HOME).mode & 0o777,0o700);await ctx.case('result',()=>assert.equal(ctx.invoke('evaluate',2),expected));};"
        );
        await writeFile(
          join(ctx.trusted, "decoder.mjs"),
          "export const decode=value=>{if(typeof value!=='number'||!Number.isFinite(value))throw new Error('bad data');return value;};"
        );
        const helper =
          "export const expected=3; export const decodeNumber=value=>{if(typeof value!=='number'||!Number.isFinite(value))throw new Error('bad data');return value;};";
        await writeFile(join(ctx.trusted, "helper.mjs"), helper);
        await writeFile(join(ctx.trusted, "decoder.mjs"), "export {decodeNumber as decode} from './helper.mjs';");
        const input = configInput();
        input.artifacts.push({ id: "helper", relativePath: "helper.mjs", expectedHash: byteHash(helper) });
        input.oracles[0]!.files.push("helper.mjs");
        const config = await measureTrustedConfiguration({ ...input, image: ctx.metadata }, ctx.trusted);
        await projectRun(
          ctx,
          config,
          [{ path: "lib/value.ts", access: "writable", contentHash: null }],
          async ({ writer, project, candidate }) => {
            const usage: unknown[] = [];
            const options = {
              project,
              config,
              trustedRoot: ctx.trusted,
              programRoot,
              image: image!,
              home: ctx.home,
              onUsage: (u: unknown) => {
                usage.push(u);
              }
            };
            const verifier = new ProjectDockerVerifier(writer, options);
            const description = await writer.transaction(async () => ({ value: await verifier.describe(["value"]) }));
            const original = writer.load;
            writer.load = vi.fn(async () => {
              throw new Error("writer reentry");
            });
            expect(await verifier.describe(["value"])).toEqual(description);
            writer.load = original;
            const receipt = await verifier.check(candidate, description);
            expect(receipt.passed).toBe(true);
            expect(verifier.ownsReceipt(receipt)).toBe(true);
            expect(verifier.ownsReceipt({ ...receipt })).toBe(false);
            expect(Object.isFrozen(receipt.groups)).toBe(true);
            expect(usage).toMatchObject([{ calls: 1 }]);
            expect(new ProjectDockerVerifier(writer, options).ownsReceipt(receipt)).toBe(false);
            await expect(verifier.describe(["unknown"])).rejects.toThrow();
            await expect(
              verifier.check({ ...candidate, candidateHash: "sha256:" + "b".repeat(64) }, description)
            ).rejects.toThrow("CANDIDATE_HASH");
            const alternateRoot = join(ctx.root, "programs");
            await cp(programRoot, alternateRoot, { recursive: true });
            const altered = new ProjectDockerVerifier(writer, { ...options, programRoot: alternateRoot });
            const beforeProgram = await altered.describe(["value"]);
            await writeFile(
              join(alternateRoot, "agent-sync-checks/bridge.mjs"),
              (await readFile(join(alternateRoot, "agent-sync-checks/bridge.mjs"), "utf8")) + "\n// mutated helper\n"
            );
            const afterProgram = await altered.describe(["value"]);
            expect(afterProgram.programsHash).not.toBe(beforeProgram.programsHash);
            await expect(altered.check(candidate, beforeProgram)).rejects.toThrow("CHECK_DEFINITION_CHANGED");
            await writeFile(join(ctx.trusted, "helper.mjs"), helper + "\n// original declared helper changed\n");
            await expect(verifier.describe(["value"])).rejects.toThrow("ARTIFACT_CHANGED");
            await expect(verifier.check(candidate, description)).rejects.toThrow("ARTIFACT_CHANGED");
            await writeFile(join(ctx.trusted, "helper.mjs"), helper);
            await writeFile(join(ctx.trusted, "decoder.mjs"), "export const decode=value=>value;");
            await expect(verifier.describe(["value"])).rejects.toThrow("ARTIFACT_CHANGED");
          }
        );
      }),
    120000
  );
  it(
    "candidate passed flags cannot replace trusted assertions",
    async () =>
      fixture(async (ctx) => {
        await mkdir(join(ctx.source, "lib"));
        await writeFile(
          join(ctx.source, "lib/value.ts"),
          "export function evaluate() { return {passed:true,exitCode:0}; }"
        );
        await writeFile(join(ctx.trusted, "decoder.mjs"), "export const decode=value=>value;");
        await writeFile(
          join(ctx.trusted, "oracle.mjs"),
          "import assert from 'node:assert/strict';export default async ctx=>{await ctx.case('result',()=>assert.equal(ctx.invoke('evaluate',2),3));};"
        );
        const config = await measureTrustedConfiguration({ ...configInput(), image: ctx.metadata }, ctx.trusted);
        await projectRun(
          ctx,
          config,
          [{ path: "lib/value.ts", access: "writable", contentHash: null }],
          async ({ writer, project, candidate }) => {
            const verifier = new ProjectDockerVerifier(writer, {
              project,
              config,
              trustedRoot: ctx.trusted,
              programRoot,
              image: image!,
              home: ctx.home
            });
            const before = (await writer.load()).acceptedVersion;
            expect((await verifier.check(candidate, await verifier.describe(["value"]))).passed).toBe(false);
            expect((await writer.load()).acceptedVersion).toBe(before);
          }
        );
      }),
    120000
  );
  it(
    "unchanged frozen todo oracle files run all 16 identities through the new proxy/image",
    async () =>
      fixture(async (ctx) => {
        const config = await createTodoTrustedChecks({
          repositoryRoot: repo,
          trustedRoot: ctx.trusted,
          imageMetadata: ctx.metadata
        });
        const manifest = JSON.parse(await readFile(join(repo, "examples/todo-stats/manifest.json"), "utf8"))
          .files as core.AgentSyncProject["manifest"];
        for (const entry of manifest) {
          await mkdir(join(ctx.source, entry.path, ".."), { recursive: true });
          await writeFile(join(ctx.source, entry.path), await readFile(join(repo, "examples/todo-stats", entry.path)));
        }
        // Correct deterministic sample implementation, used only in the temporary candidate tree.
        await writeFile(
          join(ctx.source, "src/normalize.ts"),
          `import type {NormalizedTask} from './types.js';export function normalizeTasks(input:unknown):NormalizedTask[]{if(!Array.isArray(input))throw new Error('E_INPUT');const ids=new Set<number>();return input.map((x:unknown)=>{if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('E_INPUT');const t=x as Record<string,unknown>;if(!Number.isInteger(t.id)||Number(t.id)<=0||ids.has(Number(t.id))||typeof t.title!=='string'||!t.title.trim())throw new Error('E_INPUT');ids.add(Number(t.id));const state=Object.hasOwn(t,'status')?t.status:typeof t.done==='boolean'?(t.done?'done':'pending'):null;if(state!=='pending'&&state!=='done'&&state!=='cancelled')throw new Error('E_INPUT');return{id:Number(t.id),title:t.title.trim(),state};});}`
        );
        await writeFile(
          join(ctx.source, "src/report.ts"),
          `import type {NormalizedTask} from './types.js';export function renderReport(tasks:NormalizedTask[]):string{return 'total: '+tasks.length+'\\npending: '+tasks.filter(t=>t.state==='pending').length+'\\ndone: '+tasks.filter(t=>t.state==='done').length+'\\ncancelled: '+tasks.filter(t=>t.state==='cancelled').length+'\\n';}`
        );
        await projectRun(ctx, config, manifest, async ({ writer, project, candidate }) => {
          const usage: unknown[] = [];
          const verifier = new ProjectDockerVerifier(writer, {
            project,
            config,
            trustedRoot: ctx.trusted,
            programRoot,
            image: image!,
            home: ctx.home,
            onUsage: (u) => {
              usage.push(u);
            }
          });
          const groups = config.checks.map((c) => c.checkId),
            definition = await verifier.describe(groups),
            receipt = await verifier.check(candidate, definition);
          expect(receipt.passed).toBe(true);
          expect(usage[0]).toMatchObject({ calls: expect.any(Number) });
          if (process.env.COTHINK_TASK5B_VERIFIER_EVIDENCE)
            await writeFile(
              process.env.COTHINK_TASK5B_VERIFIER_EVIDENCE,
              JSON.stringify(
                {
                  definition,
                  receipt,
                  usage,
                  caseCount: config.checks.reduce((n, c) => n + c.expectedCaseIds.length, 0)
                },
                null,
                2
              )
            );
        });
      }),
    120000
  );
  it.each(["zero", "calls", "output", "timeout"])(
    "rejects actual %s without a successful receipt or formal pointer change",
    async (mode) =>
      fixture(async (ctx) => {
        await mkdir(join(ctx.source, "lib"));
        await writeFile(
          join(ctx.source, "lib/value.ts"),
          mode === "output" ? "export const evaluate=()=> 'x'.repeat(2000);" : "export const evaluate=()=>3;"
        );
        await writeFile(join(ctx.trusted, "decoder.mjs"), "export const decode=value=>value;");
        const checker =
          mode === "zero"
            ? "export default ()=>({passed:true});"
            : mode === "calls"
              ? "import assert from 'node:assert/strict';export default async ctx=>{await ctx.case('result',()=>{assert.equal(ctx.invoke('evaluate',1),3);assert.throws(()=>ctx.invoke('evaluate',2));});};"
              : mode === "output"
                ? "import assert from 'node:assert/strict';export default async ctx=>{await ctx.case('result',()=>assert.throws(()=>ctx.invoke('evaluate',1)));};"
                : "export default async ()=>{await new Promise(()=>setInterval(()=>{},1000));};";
        await writeFile(join(ctx.trusted, "oracle.mjs"), checker);
        const input = configInput();
        if (mode === "calls") input.limits.maxCalls = 1;
        if (mode === "output") input.limits.maxResultBytes = 512;
        const config = await measureTrustedConfiguration({ ...input, image: ctx.metadata }, ctx.trusted);
        await projectRun(
          ctx,
          config,
          [{ path: "lib/value.ts", access: "writable", contentHash: null }],
          async ({ writer, project, candidate }) => {
            const verifier = new ProjectDockerVerifier(writer, {
              project,
              config,
              trustedRoot: ctx.trusted,
              programRoot,
              image: image!,
              home: ctx.home,
              ...(mode === "timeout" ? { timeoutMs: 3000 } : {})
            });
            const definition = await verifier.describe(["value"]),
              before = (await writer.load()).acceptedVersion,
              start = performance.now();
            await expect(verifier.check(candidate, definition)).rejects.toThrow(
              mode === "calls" || mode === "output"
                ? "RPC_INFRASTRUCTURE"
                : mode === "timeout"
                  ? /TIMEOUT|DEADLINE/
                  : /ORACLE/
            );
            expect((await writer.load()).acceptedVersion).toBe(before);
            if (mode === "timeout") {
              expect(performance.now() - start).toBeGreaterThanOrEqual(2900);
              expect(performance.now() - start).toBeLessThan(8500);
            }
          }
        );
      }),
    120000
  );
});
