import { afterEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_SYNC_PROJECT_VERSION,
  freezeAgentSyncProject,
  type AgentSyncService,
  type AgentSyncWorkerClient
} from "@onevcat/argue/agent-sync/project";
import {
  FileAgentSyncStore,
  LocalAgentSync,
  initializeAgentSyncProject,
  configurationHash,
  measureTrustedConfiguration
} from "../../src/agent-sync/project/index.js";
import { byteHash, treeHash } from "../../src/agent-sync/checks/measure.js";
import { configInput } from "./trusted-checks-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-local-project-")));
  roots.push(root);
  const source = join(root, "source"),
    workspaceRoot = join(root, "managed"),
    trustedRoot = join(root, "trusted"),
    home = join(root, "home"),
    bin = join(root, "bin");
  await Promise.all([
    mkdir(join(source, "lib"), { recursive: true }),
    mkdir(workspaceRoot),
    mkdir(trustedRoot),
    mkdir(home),
    mkdir(bin)
  ]);
  await writeFile(join(source, "lib/value.ts"), "export const evaluate = () => 3;\n");
  await writeFile(join(home, "caller-owned"), "keep");
  await writeFile(join(trustedRoot, "oracle.mjs"), "export {};\n");
  await writeFile(join(trustedRoot, "decoder.mjs"), "export const decode = x => x;\n");
  // A Docker invocation would fail and leave evidence, including context discovery.
  await writeFile(join(bin, "docker"), '#!/bin/sh\nprintf invoked > "' + join(root, "docker-called") + '"\nexit 97\n');
  await chmod(join(bin, "docker"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const config = await measureTrustedConfiguration(configInput(), trustedRoot);
  const projectInput = {
    projectVersion: AGENT_SYNC_PROJECT_VERSION,
    projectKey: "independent",
    memberIds: ["worker"],
    manifest: [
      { path: "lib/value.ts", access: "writable", contentHash: byteHash(await readFile(join(source, "lib/value.ts"))) },
      { path: "lib/optional.ts", access: "writable", contentHash: null }
    ],
    tasks: [
      {
        taskId: "change",
        workerId: "worker",
        scope: { read: [], write: ["lib/value.ts", "lib/optional.ts"] },
        dependsOn: [],
        checkProfileId: "full"
      }
    ],
    profiles: config.profiles,
    finalProfileId: config.finalProfileId,
    checkConfigurationHash: configurationHash(config)
  };
  const project = freezeAgentSyncProject(projectInput);
  let now = 1000;
  const options = {
    workspaceRoot,
    project,
    runId: "run",
    sourceRoot: source,
    image: `sha256:${"a".repeat(64)}`,
    config,
    trustedRoot,
    programRoot: resolve("../../tools"),
    home,
    clock: () => now
  };
  const store = new FileAgentSyncStore({ workspaceRoot, projectKey: project.projectKey });
  return {
    root,
    source,
    options,
    store,
    projectInput,
    advance: () => {
      now += 100;
    },
    untouched: async () => {
      await expect(readFile(join(root, "docker-called"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(home, "caller-owned"), "utf8")).toBe("keep");
    }
  };
}

describe("strict project LocalAgentSync with real disk/Git, Docker forbidden", { timeout: 120000 }, () => {
  test("imports once, freezes inputs, preserves deadlines, source-free reopen and readonly diff/export", async () => {
    const h = await fixture();
    const mutable = structuredClone({ project: h.options.project, config: h.options.config });
    const supplied = { ...h.options, ...mutable };
    const local = new LocalAgentSync(supplied);
    supplied.runId = "mutated";
    supplied.sourceRoot = "/does-not-exist";
    mutable.project.memberIds[0] = "changed";
    mutable.config.profiles[0]!.profileId = "changed";
    const sourceBefore = await treeHash(h.source);
    const first = await local.withSession(async (s) => {
      const status = await s.status();
      expect(status.serviceVersion).toBe("agent-sync-project-service-v1");
      expect(await s.diff()).toEqual({
        fromVersion: status.acceptedVersion,
        toVersion: status.acceptedVersion,
        files: []
      });
      await s.exportVersion({ target: join(h.root, "export") });
      await expect(s.diff({ toVersion: "b".repeat(40) })).rejects.toMatchObject({ code: "version_not_accepted" });
      return status;
    });
    expect(await treeHash(h.source)).toBe(sourceBefore);
    const before = await h.store.load();
    expect(before.runId).toBe("run");
    expect(before.startedAt).toBe(1000);
    expect(before.deadlineAt).toBe(1000 + h.options.project.resources.runTimeoutMs);
    await rm(h.source, { recursive: true });
    h.advance();
    const reopened = new LocalAgentSync({ ...h.options, sourceRoot: undefined });
    expect((await reopened.withSession((s) => s.status())).acceptedVersion).toBe(first.acceptedVersion);
    const after = await h.store.load();
    expect(after.ownerEpoch).toBe(2);
    expect(after.deadlineAt).toBe(before.deadlineAt);
    expect(after.startedAt).toBe(before.startedAt);
    await h.untouched();
  });

  test("project/run/config mismatches never advance existing owner or modify authoritative bytes", async () => {
    const h = await fixture();
    await new LocalAgentSync(h.options).withSession((s) => s.status());
    const before = await treeHash(h.options.workspaceRoot);
    await expect(new LocalAgentSync({ ...h.options, runId: "other" }).withSession((s) => s.status())).rejects.toThrow(
      /identity/
    );
    const project = freezeAgentSyncProject({ ...h.projectInput, memberIds: ["worker", "extra"] });
    await expect(new LocalAgentSync({ ...h.options, project }).withSession((s) => s.status())).rejects.toThrow(
      /identity/
    );
    const config = {
      ...h.options.config,
      checks: h.options.config.checks.map((c) => ({ ...c, parameters: { expected: 4 } }))
    };
    expect(() => new LocalAgentSync({ ...h.options, config })).toThrow("AGENT_SYNC_CHECK_CONFIGURATION");
    expect(await treeHash(h.options.workspaceRoot)).toBe(before);
    await h.untouched();
  });

  test("changed and missing declared assets reject before writer acquisition, including initial roots", async () => {
    const h = await fixture();
    const host = new LocalAgentSync(h.options);
    await host.withSession((s) => s.status());
    const before = await treeHash(h.options.workspaceRoot);
    await writeFile(join(h.options.trustedRoot, "oracle.mjs"), "changed");
    await expect(host.withSession((s) => s.status())).rejects.toThrow("AGENT_SYNC_TRUSTED_ARTIFACT_CHANGED");
    expect(await treeHash(h.options.workspaceRoot)).toBe(before);
    await rm(join(h.options.trustedRoot, "oracle.mjs"));
    await expect(host.withSession((s) => s.status())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await treeHash(h.options.workspaceRoot)).toBe(before);
    const fresh = join(h.root, "fresh");
    await mkdir(fresh);
    await expect(
      new LocalAgentSync({ ...h.options, workspaceRoot: fresh }).withSession((s) => s.status())
    ).rejects.toThrow();
    await expect(readFile(join(fresh, ".agent-sync/project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await h.untouched();
  });

  test("declared dependency changes also reject before owner acquisition", async () => {
    const h = await fixture();
    await mkdir(join(h.options.trustedRoot, "dependency"));
    await writeFile(join(h.options.trustedRoot, "dependency/index.mjs"), "export {};\n");
    const config = await measureTrustedConfiguration(
      { ...h.options.config, dependencies: [{ id: "helper", relativePath: "dependency", expectedHash: byteHash("") }] },
      h.options.trustedRoot
    );
    const project = freezeAgentSyncProject({ ...h.projectInput, checkConfigurationHash: configurationHash(config) });
    const host = new LocalAgentSync({ ...h.options, project, config });
    await host.withSession((s) => s.status());
    const before = await treeHash(h.options.workspaceRoot);
    await writeFile(join(h.options.trustedRoot, "dependency/index.mjs"), "changed");
    await expect(host.withSession((s) => s.status())).rejects.toThrow("AGENT_SYNC_TRUSTED_DEPENDENCY_CHANGED");
    expect(await treeHash(h.options.workspaceRoot)).toBe(before);
    await h.untouched();
  });

  test("one writer for callback, active guard, escaped capabilities, callback failure and stale owner", async () => {
    const h = await fixture(),
      host = new LocalAgentSync(h.options);
    let escaped: AgentSyncService | undefined, client: AgentSyncWorkerClient | undefined;
    await expect(
      host.withSession(async (service) => {
        escaped = service;
        client = service.forWorker("worker");
        await expect(host.withSession((s) => s.status())).rejects.toMatchObject({ code: "session_active" });
        await expect(new LocalAgentSync(h.options).withSession((s) => s.status())).rejects.toThrow(/writer lock/);
        expect((await h.store.load()).ownerEpoch).toBe(1);
        throw new Error("callback failure");
      })
    ).rejects.toThrow("callback failure");
    const before = await treeHash(h.options.workspaceRoot);
    await expect(escaped!.status()).rejects.toMatchObject({ code: "service_closed" });
    await expect(client!.requestScope("change", "escaped")).rejects.toMatchObject({ code: "service_closed" });
    expect(await treeHash(h.options.workspaceRoot)).toBe(before);
    await host.withSession(async (s) => {
      expect((await h.store.load()).ownerEpoch).toBe(2);
      await s.status();
    });
    await h.untouched();
  });

  test("recovery replays zero actions, preserves deadlines and source bytes, permits diff after authorized owner shift", async () => {
    const h = await fixture(),
      host = new LocalAgentSync(h.options);
    const sourceBefore = await treeHash(h.source);
    await host.withSession(async (s) => {
      const client = s.forWorker("worker");
      const grant = await client.requestScope("change", "reserve");
      if (grant.kind !== "granted") throw new Error("grant");
      await client.freezeInput(grant.lease, "freeze");
      const before = await h.store.load();
      h.advance();
      expect(await s.recover("recover")).toMatchObject({ ownerEpoch: 2, replayedActions: 0, status: "paused" });
      const after = await h.store.load();
      expect(after.deadlineAt).toBe(before.deadlineAt);
      expect(after.workspace).toEqual(before.workspace);
      expect(after.checkReceipts).toEqual([]);
      expect(after.publishReceipts).toEqual([]);
      expect(await client.currentLease("change")).toBeNull();
      await expect(client.read(grant.lease, "stale-read", "lib/value.ts")).rejects.toThrow();
      expect((await s.diff()).files).toEqual([]);
      expect(await s.recover("recover")).toMatchObject({ ownerEpoch: 2, replayedActions: 0 });
    });
    expect(await treeHash(h.source)).toBe(sourceBefore);
    await h.untouched();
  });

  test("strict initializer validates synchronously and freezes before first I/O; reopen ignores source", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      const config = { ...h.options.config, finalProfileId: "absent" };
      expect(() => initializeAgentSyncProject(writer, { ...h.options, config })).toThrow();
      const mutable = JSON.parse(JSON.stringify(h.options.project));
      const pending = initializeAgentSyncProject(writer, { ...h.options, project: mutable });
      mutable.memberIds[0] = "changed";
      await pending;
      expect((await writer.load()).plan.memberIds).toEqual(["worker"]);
      await initializeAgentSyncProject(writer, { ...h.options, sourceRoot: "/missing" });
      await expect(initializeAgentSyncProject(writer, { ...h.options, runId: "wrong" })).rejects.toThrow(
        /identity mismatch/
      );
    });
    await h.untouched();
  });

  test("requires initial source, pinned image and strict independent project before imports", async () => {
    const h = await fixture();
    expect(() => new LocalAgentSync({ ...h.options, image: "latest" })).toThrow("AGENT_SYNC_IMAGE_DIGEST");
    expect(
      () =>
        new LocalAgentSync({ ...h.options, project: { ...h.options.project, planVersion: "build-plan-v1" } as never })
    ).toThrow();
    expect(() => new LocalAgentSync({ ...h.options, timeoutMs: 0 })).toThrow("AGENT_SYNC_CHECK_TIMEOUT");
    await expect(readFile(join(h.options.workspaceRoot, ".agent-sync/project.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      new LocalAgentSync({ ...h.options, sourceRoot: undefined }).withSession((s) => s.status())
    ).rejects.toThrow("Agent sync source is required for initial import");
    await h.untouched();
  });
});
