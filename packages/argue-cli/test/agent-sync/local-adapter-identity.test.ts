import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import * as project from "../../../argue/src/agent-sync/project/index.js";
import * as legacy from "../../../argue/src/agent-sync/legacy-v1/index.js";
import * as projectHost from "../../src/agent-sync/project/index.js";
import * as legacyHost from "../../src/agent-sync/legacy-v1/backend.js";
import { FileBuildStore } from "../../src/agent-sync/legacy-v1/storage.js";
import { projectState, control, allocate } from "../../../argue/test/agent-sync/project-fixture.js";
import { runInput } from "../../../argue/test/build/fixtures.js";
import { hashVerificationSource } from "../../src/agent-sync/kernel/verification-types.js";
const H = project.hashJson("trusted identity double");
const clock = () => 1000;
function gate() {
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await blocked;
    }
  };
}
const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error: error as Error })
  );
interface Controls {
  checks: number;
  publications: number;
  passed: boolean;
  checkHook?: () => Promise<void>;
  publishHook?: () => Promise<void>;
}
interface Context {
  controls: Controls;
  check(id: string, changed?: boolean): Promise<{ receipt: { passed: boolean } }>;
  publish(id: string): Promise<{ status: "accepted" }>;
  read(id: string): Promise<unknown>;
  edit(id: string, text: string): Promise<unknown>;
  state(): Promise<{ revision: number; publishReceipts: readonly unknown[] }>;
}
/** Real managed disk/Git and actual Publisher. Verifier doubles establish no isolation. */
async function fixture(format: "project" | "legacy", test: (context: Context) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "adapter-identity-")));
  const source = join(root, "input");
  await mkdir(source);
  const controls: Controls = { checks: 0, publications: 0, passed: true };
  const issued = new WeakSet<object>();
  try {
    if (format === "project") {
      const plan = projectState(1).plan;
      const store = new projectHost.FileAgentSyncStore({ workspaceRoot: root, projectKey: plan.projectKey, clock });
      await store.withWriter(async (writer) => {
        await writer.gitFor(plan).initialize();
        const version = await writer.git.importSource(source);
        await writer.commit(
          -1,
          project.createAgentSyncState({ project: plan, runId: "run", acceptedVersion: version, now: clock() })
        );
        const lease = await writer.transaction(async (state) => {
          const t = project.reserveAgentSyncScope(state, control("reserve", 0), clock(), allocate);
          if (t.result.kind !== "granted") throw new Error("fixture grant");
          return { state: t.state, value: t.result.lease };
        });
        const verifier: projectHost.AgentSyncVerifier = {
          ownsReceipt: (r) => issued.has(r),
          describe: async (groups) => ({
            groups: [...groups],
            checksHash: H,
            configurationHash: plan.checkConfigurationHash,
            programsHash: H,
            argumentsHash: H,
            toolchainHash: H,
            isolationHash: H,
            imageDigest: H
          }),
          check: async (candidate, definition) => {
            controls.checks++;
            await controls.checkHook?.();
            const sourceHash = hashVerificationSource(await writer.git.readFiles(candidate.version));
            const receipt = project.AgentSyncCheckReceiptSchema.parse({
              ...candidate,
              ...definition,
              checkVersion: project.AGENT_SYNC_CHECK_VERSION,
              receiptId: `check-${controls.checks}`,
              passed: controls.passed,
              exitCode: controls.passed ? 0 : 1,
              sourceHashBefore: sourceHash,
              sourceHashAfter: sourceHash
            });
            issued.add(receipt);
            return receipt;
          }
        };
        class DelayedPublisher extends projectHost.Publisher {
          override async finish(...args: Parameters<projectHost.Publisher["finish"]>) {
            controls.publications++;
            await controls.publishHook?.();
            return super.finish(...args);
          }
        }
        const ports = new projectHost.LocalAgentSyncAdapter(writer, verifier, {
          clock,
          publisher: new DelayedPublisher(writer, verifier, { clock })
        }).ports;
        await ports.workspace.freezeInput(lease, "freeze");
        const candidate = await ports.workspace.seal(lease, "seal");
        await test({
          controls,
          check: (id, changed) =>
            ports.verifier.check({
              requestVersion: project.AGENT_SYNC_REQUEST_VERSION,
              requestId: id,
              lease: changed ? { ...lease, token: "different-token" } : lease,
              candidate
            }),
          publish: (id) => ports.publisher.finish(lease, id),
          read: (id) => ports.workspace.inspect(lease, id, "shared.ts"),
          edit: (id, text) => ports.workspace.edit(lease, id, [{ path: "shared.ts", text, expectedContentHash: null }]),
          state: () => writer.load()
        });
      });
    } else {
      const input = runInput();
      await mkdir(join(source, "src"));
      await writeFile(join(source, "SPEC.md"), "spec");
      await writeFile(join(source, "src/normalize.ts"), "v0");
      await writeFile(join(source, "src/report.ts"), "total");
      const store = new FileBuildStore({ workspaceRoot: root, projectKey: input.projectKey, clock });
      await store.withWriter(async (writer) => {
        await writer.gitFor(input.plan).initialize();
        const version = await writer.git.importSource(source);
        await writer.commit(-1, legacy.createBuildState({ ...input, acceptedVersion: version }));
        const lease = await writer.transaction(async (state) => {
          const t = legacy.reserveBuildScope(
            state,
            { taskId: "T-A", workerId: "member-a", requestId: "reserve", ownerEpoch: state.ownerEpoch },
            clock(),
            () => ({ attemptId: "attempt", token: "token" })
          );
          if (t.result.kind !== "granted") throw new Error("fixture grant");
          return { state: t.state, value: t.result.lease };
        });
        const verifier: legacyHost.BuildVerifier = {
          ownsReceipt: (r) => issued.has(r),
          describe: async (groups) => ({
            groups: [...groups],
            checksHash: H,
            toolchainHash: H,
            isolationHash: H,
            imageDigest: H
          }),
          check: async (candidate, definition) => {
            controls.checks++;
            await controls.checkHook?.();
            const sourceHash = hashVerificationSource(await writer.git.readFiles(candidate.version));
            const receipt = legacy.BuildCheckReceiptSchema.parse({
              ...candidate,
              ...definition,
              checkVersion: "build-check-v1",
              receiptId: `check-${controls.checks}`,
              passed: controls.passed,
              exitCode: controls.passed ? 0 : 1,
              sourceHashBefore: sourceHash,
              sourceHashAfter: sourceHash
            });
            issued.add(receipt);
            return receipt;
          }
        };
        class DelayedPublisher extends legacyHost.Publisher {
          override async finish(...args: Parameters<legacyHost.Publisher["finish"]>) {
            controls.publications++;
            await controls.publishHook?.();
            return super.finish(...args);
          }
        }
        const ports = new legacyHost.LocalBuildSyncAdapter(writer, verifier, {
          clock,
          publisher: new DelayedPublisher(writer, verifier, { clock })
        }).ports;
        await ports.workspace.freezeInput(lease, "freeze");
        const candidate = await ports.workspace.seal(lease, "seal");
        await test({
          controls,
          check: (id, changed) =>
            ports.verifier.check({
              requestId: id,
              lease: changed ? { ...lease, token: "different-token" } : lease,
              candidate
            }),
          publish: (id) => ports.publisher.finish(lease, id),
          read: (id) => ports.workspace.inspect(lease, id, "src/normalize.ts"),
          edit: (id, text) =>
            ports.workspace.edit(lease, id, [
              {
                path: "src/normalize.ts",
                text,
                expectedContentHash: input.plan.manifest.find((f) => f.path === "src/normalize.ts")!.contentHash
              }
            ]),
          state: () => writer.load()
        });
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
for (const format of ["project", "legacy"] as const)
  describe(`${format} synchronous session identity on actual backend`, { timeout: 120000 }, () => {
    it("publication-first rejects the overlapping check before any check effects", () =>
      fixture(format, async (ctx) => {
        const delay = gate();
        ctx.controls.publishHook = delay.wait;
        const before = await ctx.state();
        const publishing = settled(ctx.publish("shared-id"));
        await delay.entered;
        let checking: Awaited<ReturnType<typeof settled<{ receipt: { passed: boolean } }>>>;
        try {
          checking = await settled(ctx.check("shared-id"));
        } finally {
          delay.release();
        }
        const published = await publishing;
        expect(checking!.ok).toBe(false);
        if (!checking!.ok) expect(checking!.error.message).toMatch(/request ID conflict/);
        expect(published.ok).toBe(true);
        expect(ctx.controls.checks).toBe(1);
        expect((await ctx.state()).revision).toBe(before.revision + 1);
      }));
    it("check-first claims before its initial load and rejects overlapping publication", () =>
      fixture(format, async (ctx) => {
        const checkGate = gate(),
          publishGate = gate();
        ctx.controls.checkHook = checkGate.wait;
        ctx.controls.publishHook = publishGate.wait;
        const before = await ctx.state();
        const checking = settled(ctx.check("shared-id"));
        const publishing = settled(ctx.publish("shared-id"));
        await checkGate.entered;
        checkGate.release();
        const checked = await checking;
        publishGate.release();
        const published = await publishing;
        expect(checked.ok).toBe(true);
        expect(published.ok).toBe(false);
        if (!published.ok) expect(published.error.message).toMatch(/request ID conflict/);
        expect(ctx.controls.publications).toBe(0);
        expect(ctx.controls.checks).toBe(1);
        expect(await ctx.state()).toEqual(before);
      }));
    it("publication-first also excludes workspace receipts before their effects", () =>
      fixture(format, async (ctx) => {
        const delay = gate();
        ctx.controls.publishHook = delay.wait;
        const publishing = settled(ctx.publish("shared-id"));
        await delay.entered;
        const before = await ctx.state();
        let reading: Awaited<ReturnType<typeof settled>>;
        try {
          reading = await settled(ctx.read("shared-id"));
          expect(await ctx.state()).toEqual(before);
        } finally {
          delay.release();
        }
        expect((await publishing).ok).toBe(true);
        expect(reading!.ok).toBe(false);
        if (!reading!.ok) expect(reading!.error.message).toMatch(/request ID conflict/);
      }));
    it("workspace-first excludes a check started before its commit", () =>
      fixture(format, async (ctx) => {
        const reading = settled(ctx.read("shared-id"));
        const checking = settled(ctx.check("shared-id"));
        expect((await reading).ok).toBe(true);
        const checked = await checking;
        expect(checked.ok).toBe(false);
        if (!checked.ok) expect(checked.error.message).toMatch(/request ID conflict/);
        expect(ctx.controls.checks).toBe(0);
      }));
    it("same-context in-flight checks replay once and changed lease context conflicts", () =>
      fixture(format, async (ctx) => {
        const delay = gate();
        ctx.controls.checkHook = delay.wait;
        const before = await ctx.state();
        const first = settled(ctx.check("same")),
          second = settled(ctx.check("same"));
        const changed = settled(ctx.check("same", true));
        await delay.entered;
        delay.release();
        expect(await first).toEqual(await second);
        const different = await changed;
        expect(different.ok).toBe(false);
        if (!different.ok) expect(different.error.message).toMatch(/request ID conflict/);
        expect(ctx.controls.checks).toBe(1);
        expect(await ctx.state()).toEqual(before);
      }));
    it("execution exceptions release the claim for a valid retry", () =>
      fixture(format, async (ctx) => {
        ctx.controls.checkHook = async () => {
          throw new Error("checker transient");
        };
        await expect(ctx.check("retry")).rejects.toThrow("checker transient");
        ctx.controls.checkHook = undefined;
        expect((await ctx.check("retry")).receipt.passed).toBe(true);
        expect(ctx.controls.checks).toBe(2);
        await expect(ctx.read("retry")).rejects.toThrow(/request ID conflict/);
      }));
    it("failed data observations retain their cache and cross-operation identity", () =>
      fixture(format, async (ctx) => {
        ctx.controls.passed = false;
        const before = await ctx.state();
        expect((await ctx.check("failed")).receipt.passed).toBe(false);
        expect((await ctx.check("failed")).receipt.passed).toBe(false);
        await expect(ctx.publish("failed")).rejects.toThrow(/request ID conflict/);
        await expect(ctx.read("failed")).rejects.toThrow(/request ID conflict/);
        expect(ctx.controls.checks).toBe(1);
        expect(await ctx.state()).toEqual(before);
      }));
    it("same workspace read replays while changed workspace operation conflicts", () =>
      fixture(format, async (ctx) => {
        const first = ctx.read("read");
        const replay = ctx.read("read");
        const changed = settled(ctx.edit("read", "changed"));
        expect(await first).toEqual(await replay);
        const before = await ctx.state();
        expect(await ctx.read("read")).toEqual(await first);
        expect(await ctx.state()).toEqual(before);
        const result = await changed;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(/request ID conflict/);
      }));
    it("same-context publication in flight and durable replay execute only one check", () =>
      fixture(format, async (ctx) => {
        const delay = gate();
        ctx.controls.publishHook = delay.wait;
        const before = await ctx.state();
        const first = ctx.publish("publish"),
          replay = ctx.publish("publish");
        await delay.entered;
        delay.release();
        expect(await first).toEqual(await replay);
        expect(ctx.controls.publications).toBe(1);
        expect(ctx.controls.checks).toBe(1);
        const after = await ctx.state();
        expect(after.revision).toBe(before.revision + 1);
        expect(after.publishReceipts).toHaveLength(1);
        expect(await ctx.publish("publish")).toEqual(await first);
        expect(ctx.controls.checks).toBe(1);
        expect(await ctx.state()).toEqual(after);
      }));
    it("identical in-flight exceptions share one execution and then release for another operation", () =>
      fixture(format, async (ctx) => {
        const delay = gate();
        ctx.controls.checkHook = async () => {
          await delay.wait();
          throw new Error("transient");
        };
        const first = settled(ctx.check("retry")),
          second = settled(ctx.check("retry"));
        await delay.entered;
        delay.release();
        expect((await first).ok).toBe(false);
        expect((await second).ok).toBe(false);
        expect(ctx.controls.checks).toBe(1);
        ctx.controls.checkHook = undefined;
        await ctx.read("retry");
        expect((await ctx.state()).publishReceipts).toHaveLength(0);
        await expect(ctx.check("retry")).rejects.toThrow(/request ID conflict/);
      }));
  });
