import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import * as core from "../../../argue/src/agent-sync/project/index.js";
import { projectState, control, allocate } from "../../../argue/test/agent-sync/project-fixture.js";
import { FileAgentSyncStore, type FileAgentSyncWriter } from "../../src/agent-sync/project/storage.js";
import {
  Workspace,
  Publisher,
  LocalAgentSyncAdapter,
  exportAcceptedVersion,
  recoverAgentSyncProject,
  type AgentSyncCheckDefinition,
  type AgentSyncVerificationCandidate,
  type PublisherOptions
} from "../../src/agent-sync/project/backend.js";
import { hashVerificationSource } from "../../src/agent-sync/kernel/verification-types.js";
let root: string, now: number;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-backend-")));
  now = 1000;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const H = core.hashJson("trusted-double");
/** Authority/CAS test double only: does NOT execute or prove any isolation. */
class TrustedVerifier {
  checks = 0;
  descriptions = 0;
  salt = "stable";
  passed = true;
  owned = true;
  hook?: () => Promise<void>;
  mutate?: (receipt: Record<string, unknown>) => void;
  private readonly issued = new WeakSet<object>();
  constructor(private writer: FileAgentSyncWriter) {}
  ownsReceipt(receipt: object) {
    return this.owned && this.issued.has(receipt);
  }
  async describe(groups: readonly string[]): Promise<AgentSyncCheckDefinition> {
    this.descriptions++;
    return {
      groups: [...groups],
      checksHash: core.hashJson({ groups, salt: this.salt }),
      configurationHash: projectState().plan.checkConfigurationHash,
      programsHash: H,
      argumentsHash: H,
      toolchainHash: H,
      isolationHash: H,
      imageDigest: `sha256:${"a".repeat(64)}`
    };
  }
  async check(candidate: AgentSyncVerificationCandidate, definition: AgentSyncCheckDefinition) {
    this.checks++;
    await this.hook?.();
    const source = hashVerificationSource(await this.writer.git.readFiles(candidate.version));
    const raw = {
      checkVersion: core.AGENT_SYNC_CHECK_VERSION,
      receiptId: `check-${this.checks}`,
      ...candidate,
      ...definition,
      passed: this.passed,
      exitCode: this.passed ? 0 : 1,
      sourceHashBefore: source,
      sourceHashAfter: source
    };
    this.mutate?.(raw);
    const receipt = core.AgentSyncCheckReceiptSchema.parse(raw);
    this.issued.add(receipt);
    return receipt;
  }
}
async function fixture(count = 3, patch: (raw: ReturnType<typeof projectState>["plan"]) => unknown = (p) => p) {
  const original = projectState(count).plan;
  const { planHash: _hash, ...definition } = patch(original) as typeof original;
  void _hash;
  const project = core.freezeAgentSyncProject(definition);
  const source = join(root, "input");
  await mkdir(source);
  const store = new FileAgentSyncStore({ workspaceRoot: root, projectKey: project.projectKey, clock: () => now });
  const initialize = async (writer: FileAgentSyncWriter) => {
    await writer.gitFor(project).initialize();
    const acceptedVersion = await writer.git.importSource(source);
    await writer.commit(-1, core.createAgentSyncState({ project, runId: "run", acceptedVersion, now }));
  };
  const reserve = (writer: FileAgentSyncWriter, index: number, id = `reserve${index}`) =>
    writer.transaction(async (state) => {
      const transition = core.reserveAgentSyncScope(
        state,
        { ...control("reserve", index, id), ownerEpoch: state.ownerEpoch },
        now,
        allocate
      );
      return { state: transition.state, value: transition.result };
    });
  const grant = async (writer: FileAgentSyncWriter, index: number) => {
    const result = await reserve(writer, index);
    if (result.kind !== "granted") throw new Error(`Expected grant: ${result.kind}`);
    return result.lease;
  };
  return { store, source, initialize, reserve, grant };
}
const bytes = () => readFile(join(root, ".agent-sync/state/project/session.json"), "utf8");
const clock = () => now;
describe("shared actual backend with trusted verifier doubles (not isolation evidence)", { timeout: 120000 }, () => {
  it.each([1, 2, 3])(
    "supports %i members, formal CAS without a seal, durable readonly replay and source-free recovery",
    async (count) => {
      const f = await fixture(count);
      let old: core.AgentSyncLease;
      let accepted: string;
      await f.store.withWriter(async (writer) => {
        await f.initialize(writer);
        const ws = new Workspace(writer, { clock });
        const verifier = new TrustedVerifier(writer);
        const publisher = new Publisher(writer, verifier, { clock });
        for (let i = 0; i < count; i++) {
          const lease = await f.grant(writer, i);
          old = lease;
          await ws.freezeInput(lease, `freeze${i}`);
          const state = await writer.load();
          const revision = state.revision;
          const result = await publisher.finish(lease, `publish${i}`);
          const after = await writer.load();
          accepted = after.acceptedVersion;
          expect(after.revision).toBe(revision + 1);
          expect(after.acceptedTasks).toContain(`task${i}`);
          expect(after.attempts.find((a) => a.attemptId === lease.attemptId)?.status).toBe("completed");
          expect(after.coordination.locks.some((l) => l.attemptId === lease.attemptId)).toBe(false);
          expect(result.receipt.requestHash).toBe(core.agentSyncPublishRequestHash(state, lease, `publish${i}`));
          const before = await bytes();
          expect(await publisher.finish(lease, `publish${i}`)).toEqual(result);
          expect(await bytes()).toBe(before);
        }
        expect(verifier.checks).toBe(count);
        const state = await writer.load();
        const recovered = await recoverAgentSyncProject(writer);
        expect(recovered.acceptedVersion).toBe(state.acceptedVersion);
        expect(recovered).not.toHaveProperty("modelCalls");
        expect((await writer.load()).ownerEpoch).toBe(state.ownerEpoch);
      });
      await rm(f.source, { recursive: true });
      await f.store.withWriter(async (writer) => {
        expect((await recoverAgentSyncProject(writer)).acceptedVersion).toBe(accepted!);
        expect(core.validateAgentSyncLease(await writer.load(), old!, now).valid).toBe(false);
      });
    }
  );
  it("waits for conflicts, preserves independent latest publication, and freezes queued input only on grant", async () => {
    const f = await fixture();
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const ws = new Workspace(writer, { clock });
      const verifier = new TrustedVerifier(writer);
      const publisher = new Publisher(writer, verifier, { clock });
      const a = await f.grant(writer, 0);
      expect((await f.reserve(writer, 1)).kind).toBe("waiting");
      const c = await f.grant(writer, 2);
      await ws.freezeInput(a, "freeze-a");
      await ws.freezeInput(c, "freeze-c");
      await ws.edit(a, "edit-a", [{ path: "shared.ts", text: "a", expectedContentHash: null }]);
      await ws.edit(c, "edit-c", [{ path: "other.ts", text: "c", expectedContentHash: null }]);
      await publisher.finish(c, "publish-c");
      const independent = (await writer.load()).acceptedVersion;
      const result = await publisher.finish(a, "publish-a");
      expect(result.receipt.baseVersion).toBe(independent);
      const view = await writer.git.readFiles(result.receipt.acceptedVersion);
      expect(view["other.ts"].text).toBe("c");
      expect(view["shared.ts"].text).toBe("a");
      const scheduled = await writer.transaction(async (state) => {
        const t = core.scheduleAgentSyncTasks(state, { ownerEpoch: state.ownerEpoch }, now, allocate);
        return { state: t.state, value: t };
      });
      const attempt = scheduled.state.attempts.find((x) => x.taskId === "task1")!;
      const b = core.agentSyncLeaseFromAttempt(scheduled.state, attempt);
      const frozen = await ws.freezeInput(b, "freeze-b");
      expect(frozen.baseVersion).toBe(result.receipt.acceptedVersion);
      expect(frozen.contentHashes["shared.ts"]).toBe(view["shared.ts"].contentHash);
    });
  });
  it("checks every old hash before multi-file blob writes and enforces direct edit resource limits", async () => {
    const f = await fixture(1, (p) => ({
      ...p,
      tasks: p.tasks.map((t) => ({ ...t, scope: { read: [], write: ["shared.ts", "other.ts"] } })),
      resources: { ...p.resources, maxEditsPerRequest: 2, maxTextBytes: 6 }
    }));
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      let writes = 0;
      const ws = new Workspace(writer, {
        clock,
        beforeBlobWrite: async () => {
          writes++;
        }
      });
      await ws.freezeInput(lease, "freeze");
      const before = await bytes();
      await expect(
        ws.edit(lease, "atomic", [
          { path: "shared.ts", text: "ok", expectedContentHash: null },
          { path: "other.ts", text: "bad", expectedContentHash: H }
        ])
      ).rejects.toThrow(/expected content/);
      expect(writes).toBe(0);
      expect(await bytes()).toBe(before);
      await expect(
        ws.edit(lease, "too-big", [{ path: "shared.ts", text: "你好啊", expectedContentHash: null }])
      ).rejects.toMatchObject({ code: "text_limit" });
      expect(writes).toBe(0);
      expect(await bytes()).toBe(before);
      await ws.edit(lease, "valid", [
        { path: "shared.ts", text: "a", expectedContentHash: null },
        { path: "other.ts", text: "b", expectedContentHash: null }
      ]);
      expect(writes).toBe(2);
    });
  });
  it("keeps a standalone check observational, rejects a stale overlay, and rechecks on formal finish", async () => {
    const f = await fixture(1);
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      const verifier = new TrustedVerifier(writer);
      const ports = new LocalAgentSyncAdapter(writer, verifier, { clock }).ports;
      await ports.workspace.freezeInput(lease, "freeze");
      const candidate = await ports.workspace.seal(lease, "seal");
      const before = await bytes();
      const request = { requestVersion: core.AGENT_SYNC_REQUEST_VERSION, requestId: "check", lease, candidate };
      await ports.verifier.check(request);
      expect(await bytes()).toBe(before);
      expect((await writer.load()).checkReceipts).toEqual([]);
      await ports.verifier.check(request);
      expect(verifier.checks).toBe(1);
      verifier.salt = "changed";
      await expect(ports.verifier.check(request)).rejects.toThrow(/basis changed/);
      expect(await bytes()).toBe(before);
      verifier.salt = "stable";
      await ports.workspace.edit(lease, "edit", [{ path: "shared.ts", text: "new", expectedContentHash: null }]);
      await expect(ports.verifier.check({ ...request, requestId: "stale" })).rejects.toThrow(/stale/);
      await ports.publisher.finish(lease, "finish");
      expect(verifier.checks).toBe(2);
      expect((await writer.load()).checkReceipts).toHaveLength(1);
    });
  });
  it.each([
    "checksHash",
    "toolchainHash",
    "isolationHash",
    "imageDigest",
    "configurationHash",
    "programsHash",
    "argumentsHash",
    "sourceHashBefore",
    "sourceHashAfter",
    "planHash",
    "candidateHash",
    "baseVersion",
    "version"
  ])("refuses forged formal %s evidence without advancing", async (field) => {
    const f = await fixture(1);
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      await new Workspace(writer, { clock }).freezeInput(lease, "freeze");
      const verifier = new TrustedVerifier(writer);
      verifier.mutate = (receipt) => {
        receipt[field] = ["baseVersion", "version"].includes(field) ? "b".repeat(40) : core.hashJson("forged");
      };
      const before = await bytes();
      await expect(new Publisher(writer, verifier, { clock }).finish(lease, "finish")).rejects.toThrow();
      expect(await bytes()).toBe(before);
    });
  });
  it.each(["unowned", "configuration-drift", "late-deadline", "cancel", "stale-owner"])(
    "refuses %s after checking",
    async (mode) => {
      const f = await fixture(1);
      await f.store.withWriter(async (writer) => {
        await f.initialize(writer);
        const lease = await f.grant(writer, 0);
        await new Workspace(writer, { clock }).freezeInput(lease, "freeze");
        const verifier = new TrustedVerifier(writer);
        const before = (await writer.load()).acceptedVersion;
        if (mode === "unowned") verifier.owned = false;
        if (mode === "configuration-drift")
          verifier.hook = async () => {
            verifier.salt = "drift";
          };
        if (mode === "late-deadline")
          verifier.hook = async () => {
            now = (await writer.load()).attempts[0].deadlineAt;
          };
        if (mode === "stale-owner")
          verifier.hook = async () => {
            await writer.transaction(async (state) => {
              const t = core.advanceAgentSyncOwnerEpoch(
                state,
                {
                  requestVersion: core.AGENT_SYNC_REQUEST_VERSION,
                  operation: "epoch",
                  requestId: "new-owner",
                  ownerEpoch: state.ownerEpoch
                },
                now
              );
              return { state: t.state, value: undefined };
            });
          };
        if (mode === "cancel")
          verifier.hook = async () => {
            await writer.transaction(async (state) => {
              const t = core.cancelAgentSyncTask(state, { ...control("cancel", 0), ownerEpoch: state.ownerEpoch }, now);
              return { state: t.state, value: undefined };
            });
          };
        await expect(new Publisher(writer, verifier, { clock }).finish(lease, "finish")).rejects.toThrow();
        expect((await writer.load()).acceptedVersion).toBe(before);
        expect((await writer.load()).publishReceipts).toHaveLength(0);
      });
    }
  );
  it.each(["afterCandidate", "afterCheck", "beforeCAS", "afterCAS"] as const)(
    "recovers exactly across %s fault",
    async (boundary) => {
      const f = await fixture(1);
      await f.store.withWriter(async (writer) => {
        await f.initialize(writer);
        const lease = await f.grant(writer, 0);
        await new Workspace(writer, { clock }).freezeInput(lease, "freeze");
        const verifier = new TrustedVerifier(writer);
        const options: PublisherOptions = {
          clock,
          [boundary]: async () => {
            throw new Error("fault");
          }
        };
        await expect(new Publisher(writer, verifier, options).finish(lease, "finish")).rejects.toThrow("fault");
        const state = await writer.load();
        expect(state.publishReceipts.length).toBe(boundary === "afterCAS" ? 1 : 0);
        await recoverAgentSyncProject(writer);
        const before = verifier.checks;
        await new Publisher(writer, verifier, { clock }).finish(lease, "finish");
        expect(verifier.checks).toBe(before + (boundary === "afterCAS" ? 0 : 1));
        expect((await writer.load()).publishReceipts).toHaveLength(1);
      });
    }
  );
  it.each([".agent-sync", ".AGENT-SYNC", ".cothink-build", ".COTHINK-BUILD"])(
    "refuses absent or ancestor control export target %s",
    async (name) => {
      const f = await fixture(1);
      await f.store.withWriter(async (writer) => {
        await f.initialize(writer);
        const target = join(root, "outside");
        await mkdir(target);
        await expect(exportAcceptedVersion(writer, { target: join(target, name) })).rejects.toThrow(/control/);
        await mkdir(join(target, name));
        await expect(exportAcceptedVersion(writer, { target: join(target, name, "export") })).rejects.toThrow(
          /control/
        );
        await expect(exportAcceptedVersion(writer, { target })).rejects.toThrow(/control/);
      });
    }
  );
  it("preserves exact export hash identity and retry after parent sync fault", async () => {
    const f = await fixture(1);
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      const ws = new Workspace(writer, { clock });
      await ws.freezeInput(lease, "freeze");
      await ws.edit(lease, "edit", [{ path: "shared.ts", text: "value", expectedContentHash: null }]);
      const verifier = new TrustedVerifier(writer);
      const publisher = new Publisher(writer, verifier, { clock });
      const before = await writer.load();
      const target = join(root, "export");
      const accepted = await publisher.finish(lease, "finish", { exportTarget: target });
      expect(accepted.receipt.requestHash).toBe(core.agentSyncPublishRequestHash(before, lease, "finish", target));
      expect(await readFile(join(target, "shared.ts"), "utf8")).toBe("value");
      expect((await publisher.finish(lease, "finish", { exportTarget: target })).export.status).toBe("not_retried");
      await expect(publisher.finish(lease, "finish", { exportTarget: join(root, "other") })).rejects.toThrow(
        /conflict/
      );
      const target2 = join(root, "export2");
      await expect(
        exportAcceptedVersion(
          writer,
          { target: target2 },
          {
            beforeParentSync: async () => {
              throw new Error("sync-fault");
            }
          }
        )
      ).rejects.toThrow("sync-fault");
      expect((await exportAcceptedVersion(writer, { target: target2 })).directory).toBe(target2);
    });
  });
  it("returns stable direct global edit and text limits before strict schema rejection", async () => {
    const f = await fixture(1);
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      const ws = new Workspace(writer, { clock });
      await ws.freezeInput(lease, "freeze");
      const before = await bytes();
      await expect(
        ws.edit(lease, "global-text", [{ path: "shared.ts", text: "x".repeat(1048577), expectedContentHash: null }])
      ).rejects.toMatchObject({ code: "text_limit" });
      await expect(
        ws.edit(
          lease,
          "global-edits",
          Array.from({ length: 129 }, () => ({ path: "shared.ts", text: "x", expectedContentHash: null }))
        )
      ).rejects.toMatchObject({ code: "edit_limit" });
      expect(await bytes()).toBe(before);
    });
  });
  it("captures mutable edit payloads before awaiting and fences deadline after blob preparation", async () => {
    const f = await fixture(1);
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      const ws = new Workspace(writer, { clock });
      await ws.freezeInput(lease, "freeze");
      const edits = [{ path: "shared.ts", text: "original", expectedContentHash: null }];
      const promise = ws.edit(lease, "captured", edits);
      edits[0].text = "mutated";
      await promise;
      expect((await ws.inspect(lease, "read", "shared.ts")).text).toBe("original");
      const before = await bytes();
      const input = (await writer.load()).workspace!.staging[0].files[0].contentHash;
      const late = new Workspace(writer, {
        clock,
        beforeCommit: async () => {
          now = 999999999;
        }
      });
      await expect(
        late.edit(lease, "late", [{ path: "shared.ts", text: "late", expectedContentHash: input }])
      ).rejects.toThrow(/lease rejected/);
      expect(await bytes()).toBe(before);
    });
  });
  it.each(["old-check-version", "missing-programs", "missing-checker", "wrong-configuration"])(
    "refuses %s trusted checker output",
    async (mode) => {
      const f = await fixture(1);
      await f.store.withWriter(async (writer) => {
        await f.initialize(writer);
        const lease = await f.grant(writer, 0);
        await new Workspace(writer, { clock }).freezeInput(lease, "freeze");
        const verifier = new TrustedVerifier(writer);
        if (mode === "old-check-version")
          verifier.mutate = (r) => {
            r.checkVersion = "build-check-v1";
          };
        if (mode === "missing-programs")
          verifier.mutate = (r) => {
            delete r.programsHash;
          };
        const original = verifier.describe.bind(verifier);
        if (mode === "missing-checker")
          verifier.describe = async () => {
            throw new Error("Missing trusted checker");
          };
        if (mode === "wrong-configuration")
          verifier.describe = async (groups) => ({
            ...(await original(groups)),
            configurationHash: core.hashJson("different config")
          });
        const before = await bytes();
        await expect(new Publisher(writer, verifier, { clock }).finish(lease, "finish")).rejects.toThrow();
        expect(await bytes()).toBe(before);
      });
    }
  );
  it("rejects cross-project leases, request-version changes and operation request ID collisions", async () => {
    const f = await fixture(1);
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      const verifier = new TrustedVerifier(writer);
      const adapter = new LocalAgentSyncAdapter(writer, verifier, { clock });
      const ws = adapter.ports.workspace;
      await expect(ws.freezeInput({ ...lease, projectKey: "elsewhere" }, "cross-project")).rejects.toThrow();
      await ws.freezeInput(lease, "freeze");
      const candidate = await ws.seal(lease, "seal");
      await expect(
        adapter.ports.verifier.check({
          requestVersion: "build-request-v1",
          requestId: "wrong-version",
          lease,
          candidate
        } as core.AgentSyncVerifierRequest)
      ).rejects.toThrow();
      const request = { requestVersion: core.AGENT_SYNC_REQUEST_VERSION, requestId: "private", lease, candidate };
      await adapter.ports.verifier.check(request);
      await expect(ws.inspect(lease, "private", "shared.ts")).rejects.toThrow(/conflict/);
      await expect(adapter.ports.publisher.finish(lease, "private")).rejects.toThrow(/conflict/);
      await expect(adapter.ports.publisher.finish(lease, "seal")).rejects.toThrow(/conflict/);
      await adapter.ports.publisher.finish(lease, "finish");
      await expect(new Workspace(writer, { clock }).inspect(lease, "finish", "shared.ts")).rejects.toThrow(/conflict/);
    });
  });
  it("applies configured maxEdits on direct Workspace calls without any writes", async () => {
    const f = await fixture(1, (p) => ({
      ...p,
      tasks: p.tasks.map((t) => ({ ...t, scope: { read: [], write: ["shared.ts", "other.ts"] } })),
      resources: { ...p.resources, maxEditsPerRequest: 1 }
    }));
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const lease = await f.grant(writer, 0);
      let writes = 0;
      const ws = new Workspace(writer, {
        clock,
        beforeBlobWrite: async () => {
          writes++;
        }
      });
      await ws.freezeInput(lease, "freeze");
      const before = await bytes();
      await expect(
        ws.edit(lease, "two-edits", [
          { path: "shared.ts", text: "a", expectedContentHash: null },
          { path: "other.ts", text: "b", expectedContentHash: null }
        ])
      ).rejects.toMatchObject({ code: "edit_limit" });
      expect(writes).toBe(0);
      expect(await bytes()).toBe(before);
    });
  });
  it("selects accepted-task union and final composition, with final descriptor freshness before CAS", async () => {
    const f = await fixture(3, (p) => ({
      ...p,
      tasks: p.tasks.map((t) => ({ ...t, checkProfileId: t.taskId === "task2" ? "other" : "quality" })),
      profiles: [
        { profileId: "quality", checkIds: ["types"] },
        { profileId: "other", checkIds: ["other-check"] },
        { profileId: "combined", checkIds: ["combined-check"] }
      ],
      finalProfileId: "combined"
    }));
    await f.store.withWriter(async (writer) => {
      await f.initialize(writer);
      const ws = new Workspace(writer, { clock });
      const verifier = new TrustedVerifier(writer);
      const publisher = new Publisher(writer, verifier, { clock });
      for (const index of [0, 2]) {
        const lease = await f.grant(writer, index);
        await ws.freezeInput(lease, `freeze${index}`);
        const result = await publisher.finish(lease, `publish${index}`);
        const check = (await writer.load()).checkReceipts.find((c) => c.receiptId === result.receipt.checkReceiptId)!;
        expect(check.groups).toEqual(index === 0 ? ["types"] : ["types", "other-check"]);
      }
      const lease = await f.grant(writer, 1);
      await ws.freezeInput(lease, "freeze1");
      await expect(
        new Publisher(writer, verifier, {
          clock,
          beforeCAS: async () => {
            verifier.salt = "late-drift";
          }
        }).finish(lease, "final")
      ).rejects.toThrow(/basis changed before CAS/);
      const result = await publisher.finish(lease, "final");
      const check = (await writer.load()).checkReceipts.find((c) => c.receiptId === result.receipt.checkReceiptId)!;
      expect(check.groups).toEqual(["types", "other-check", "combined-check"]);
    });
  });
  it.each(["configurationHash", "programsHash", "argumentsHash"] as const)(
    "rejects the same cached check ID after live %s changes without authority writes",
    async (field) => {
      const f = await fixture(1);
      await f.store.withWriter(async (writer) => {
        await f.initialize(writer);
        const lease = await f.grant(writer, 0);
        const verifier = new TrustedVerifier(writer);
        const ports = new LocalAgentSyncAdapter(writer, verifier, { clock }).ports;
        await ports.workspace.freezeInput(lease, "freeze");
        const candidate = await ports.workspace.seal(lease, "seal");
        const request: core.AgentSyncVerifierRequest = {
          requestVersion: core.AGENT_SYNC_REQUEST_VERSION,
          requestId: "same-id",
          lease,
          candidate
        };
        const result = await ports.verifier.check(request);
        expect(result.receipt.passed).toBe(true);
        const before = await bytes();
        const original = verifier.describe.bind(verifier);
        verifier.describe = async (groups) => ({
          ...(await original(groups)),
          [field]: core.hashJson("new actual basis")
        });
        await expect(ports.verifier.check(request)).rejects.toThrow(/basis changed/);
        expect(await bytes()).toBe(before);
        expect(verifier.checks).toBe(1);
      });
    }
  );
});
