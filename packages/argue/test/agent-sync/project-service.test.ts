import { describe, expect, test } from "vitest";
import * as api from "../../src/agent-sync/project/index.js";
import { sha256 } from "../../src/peer/hash.js";
import { AgentSyncService as LegacyService, AgentSyncError as LegacyError } from "../../src/agent-sync/service.js";
import { projectState, allocate } from "./project-fixture.js";
import { MemoryProjectSync } from "./project-service-fixture.js";

function setup(count = 3, resources?: Partial<api.AgentSyncResources>) {
  let now = 1000;
  const initial = projectState(count);
  const { planHash: _hash, ...project } = initial.plan;
  void _hash;
  const state = resources
    ? api.createAgentSyncState({
        project: api.freezeAgentSyncProject({ ...project, resources: { ...project.resources, ...resources } }),
        runId: initial.runId,
        acceptedVersion: initial.acceptedVersion,
        now
      })
    : initial;
  const memory = new MemoryProjectSync(state, { "shared.ts": null, "other.ts": null }, () => now);
  expect(api).toHaveProperty("AgentSyncService", expect.any(Function));
  const open = (options: Partial<api.AgentSyncServiceOptions> = {}) =>
    new api.AgentSyncService({
      writer: memory.writer,
      ports: memory.ports,
      expectedRunId: state.runId,
      expectedPlanHash: state.plan.planHash,
      clock: () => now,
      allocateLease: allocate,
      ...options
    });
  const service = open();
  return {
    memory,
    service,
    open,
    worker: service.forWorker("custom0"),
    setNow: (value: number) => {
      now = value;
    }
  };
}
function grant(result: api.AgentSyncOperationResult) {
  expect(result.kind).toBe("granted");
  if (result.kind !== "granted") throw Error("Expected grant");
  return result.lease;
}

describe("project service using actual shared coordination and in-memory port effects", () => {
  test.each([1, 2, 3])("admits %i declared members and completes through the same service", async (count) => {
    const { service, memory } = setup(count);
    for (let i = 0; i < count; i++) {
      const worker = service.forWorker(`custom${i}`);
      const lease = grant(await worker.requestScope(`task${i}`, `scope${i}`));
      await worker.freezeInput(lease, `freeze${i}`);
      const path = i === 2 ? "other.ts" : "shared.ts";
      const old = await worker.read(lease, `read${i}`, path);
      await worker.edit(lease, `edit${i}`, [{ path, text: `revision ${i}`, expectedContentHash: old.contentHash }]);
      const candidate = await worker.seal(lease, `seal${i}`);
      expect((await worker.check(lease, `check${i}`, candidate)).receipt.passed).toBe(true);
      const published = await worker.finish(lease, `finish${i}`);
      const snapshot = memory.state;
      expect(await worker.finish(lease, `finish${i}`)).toEqual(published);
      expect(memory.state).toEqual(snapshot);
    }
    expect(await service.status()).toMatchObject({
      serviceVersion: "agent-sync-project-service-v1",
      status: "completed"
    });
    expect(memory.state.acceptedTasks).toHaveLength(count);
  });
  test("counts unique requests atomically, retains the cap through recovery and keeps status usable", async () => {
    const { service, worker, memory } = setup(1, { maxSessionRequests: 2 });
    const lease = grant(await worker.requestScope("task0", "scope"));
    expect((await worker.requestScope("task0", "scope")).kind).toBe("replayed");
    const results = await Promise.allSettled([
      worker.freezeInput(lease, "freeze"),
      worker.read(lease, "extra", "shared.ts")
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "session_request_limit" } });
    const snapshot = memory.state;
    await expect(service.recover("recover")).rejects.toMatchObject({ code: "session_request_limit" });
    expect(memory.state).toEqual(snapshot);
    expect((await service.status()).status).toBe("active");
    service.close();
    await expect(worker.currentLease("task0")).rejects.toMatchObject({ code: "service_closed" });
  });
  test("rejects aggregate UTF-8 bytes and edit counts without workspace effects", async () => {
    const { worker, memory } = setup(1, { maxTextBytes: 3, maxEditsPerRequest: 1 });
    const lease = grant(await worker.requestScope("task0", "scope"));
    await worker.freezeInput(lease, "freeze");
    const before = memory.state;
    await expect(
      worker.edit(lease, "text", [{ path: "shared.ts", text: "中文", expectedContentHash: null }])
    ).rejects.toMatchObject({ code: "text_limit" });
    await expect(
      worker.edit(lease, "edits", [
        { path: "shared.ts", text: "a", expectedContentHash: null },
        { path: "other.ts", text: "b", expectedContentHash: null }
      ])
    ).rejects.toMatchObject({ code: "edit_limit" });
    expect(memory.state).toEqual(before);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function candidateOf(worker: api.AgentSyncWorkerClient) {
  const lease = grant(await worker.requestScope("task0", "scope"));
  await worker.freezeInput(lease, "freeze");
  return { lease, candidate: await worker.seal(lease, "seal") };
}
describe("project service authority and recovery boundaries", () => {
  test("both public wrappers inherit the exact same method implementation and error class", () => {
    expect(api.AgentSyncService.prototype.forWorker).toBe(LegacyService.prototype.forWorker);
    expect(api.AgentSyncService.prototype.recover).toBe(LegacyService.prototype.recover);
    expect(api.AgentSyncError).toBe(LegacyError);
  });
  test("waits for a shared path, permits independent work, and grants the newest accepted version", async () => {
    const { service, worker, memory } = setup();
    const b = service.forWorker("custom1"),
      c = service.forWorker("custom2");
    const lease = grant(await worker.requestScope("task0", "scope"));
    expect((await b.requestScope("task1", "wait")).kind).toBe("waiting");
    const independent = grant(await c.requestScope("task2", "independent"));
    await worker.freezeInput(lease, "freeze");
    await worker.edit(lease, "edit", [{ path: "shared.ts", text: "newest", expectedContentHash: null }]);
    await worker.finish(lease, "finish");
    const newest = memory.state.acceptedVersion;
    await c.release(independent, "release");
    const next = grant(await b.requestScope("task1", "ready"));
    expect(await b.currentLease("task1")).toEqual(next);
    expect(next).not.toBeNull();
    expect((await b.freezeInput(next!, "nextfreeze")).baseVersion).toBe(newest);
    expect((await b.read(next!, "read", "shared.ts")).text).toBe("newest");
  });
  test("rejects unknown workers, cross-worker tasks, altered full context, and malformed versions before effects", async () => {
    const { service, worker, memory } = setup();
    const unknown = service.forWorker("intruder");
    await expect(unknown.requestScope("task0", "unknown")).rejects.toMatchObject({ code: "unknown_worker" });
    await expect(service.forWorker("custom1").requestScope("task0", "foreign")).rejects.toMatchObject({
      code: "worker_task_mismatch"
    });
    const lease = grant(await worker.requestScope("task0", "scope"));
    const before = memory.state;
    for (const changed of [
      { runId: "other" },
      { projectKey: "other" },
      { planHash: sha256("other") },
      { token: "forged" },
      { taskId: "task1", workerId: "custom1" }
    ]) {
      await expect(
        worker.freezeInput({ ...lease, ...changed }, `bad${Object.keys(changed)[0]}`)
      ).rejects.toBeInstanceOf(api.AgentSyncError);
    }
    const { leaseVersion: _version, ...unversioned } = lease;
    void _version;
    await expect(worker.freezeInput(unversioned as api.AgentSyncLease, "noversion")).rejects.toMatchObject({
      code: "invalid_input"
    });
    await expect(
      worker.freezeInput({ ...lease, leaseVersion: "wrong" } as unknown as api.AgentSyncLease, "version")
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(worker.read(lease, "outside", "other.ts")).rejects.toMatchObject({ code: "scope_violation" });
    expect(memory.state).toEqual(before);
    expect(JSON.stringify(await service.status())).not.toMatch(/token|coordination|inputHash/);
    expect((await service.status()).tasks[1]!.status).toBe("pending");
  });
  test.each(["run", "plan", "owner"] as const)(
    "rejects %s identity changes and captures an initial owner eagerly",
    async (kind) => {
      const { service, open, memory } = setup();
      await service.status();
      if (kind === "run") memory.save({ ...memory.state, runId: "replacement" });
      if (kind === "plan") {
        const { planHash: _hash, ...plan } = memory.state.plan;
        void _hash;
        memory.save({
          ...memory.state,
          plan: api.freezeAgentSyncProject({ ...plan, checkConfigurationHash: sha256("replacement") })
        });
      }
      if (kind === "owner") await open().recover("replacement");
      await expect(service.status()).rejects.toMatchObject({
        code: kind === "run" ? "run_id_mismatch" : kind === "plan" ? "plan_hash_mismatch" : "owner_epoch_mismatch"
      });
    }
  );
  test("captures mutable lease, edits and candidate before the first asynchronous boundary", async () => {
    const { worker, memory } = setup(1);
    const lease = grant(await worker.requestScope("task0", "scope"));
    await worker.freezeInput(lease, "freeze");
    const mutable = { ...lease },
      edits = [{ path: "shared.ts", text: "original", expectedContentHash: null }];
    const pending = worker.edit(mutable, "edit", edits);
    edits[0]!.text = "mutated";
    mutable.token = "mutated";
    await pending;
    const candidate = { ...(await worker.seal(lease, "seal")) };
    const checking = worker.check(lease, "check", candidate);
    candidate.candidateHash = sha256("mutated");
    expect((await checking).receipt.passed).toBe(true);
    expect(memory.state.workspace?.toolReceipts.find((r) => r.requestId === "edit")?.request).toMatchObject({
      edits: [{ text: "original" }],
      lease: { token: lease.token }
    });
  });
  test("rejects a fabricated candidate and changed replay context", async () => {
    const { worker } = setup(1);
    const { lease, candidate } = await candidateOf(worker);
    await expect(
      worker.check(lease, "fabricated", { ...candidate, candidateHash: sha256("fake") })
    ).rejects.toMatchObject({ code: "candidate_mismatch" });
    await worker.check(lease, "check", candidate);
    await expect(worker.check(lease, "check", { ...candidate, version: "f".repeat(40) })).rejects.toMatchObject({
      code: "request_id_conflict"
    });
    await expect(worker.read(lease, "check", "shared.ts")).rejects.toMatchObject({ code: "request_id_conflict" });
    expect(await worker.release(lease, "check")).toEqual({ kind: "rejected", code: "request_id_conflict" });
  });
  test.each(["malformed", "configuration", "version", "passed"] as const)(
    "rejects %s verifier evidence returned by a backend",
    async (kind) => {
      const { open, memory } = setup(1);
      const ports: api.AgentSyncPorts = {
        ...memory.ports,
        verifier: {
          check: async (request) => {
            const response = await memory.ports.verifier.check(request);
            if (kind === "malformed")
              return { requestId: request.requestId, receipt: { passed: true } } as api.AgentSyncVerifierResponse;
            return {
              ...response,
              receipt: {
                ...response.receipt,
                ...(kind === "configuration"
                  ? { configurationHash: sha256("wrong") }
                  : kind === "version"
                    ? { checkVersion: "foreign" }
                    : { exitCode: 1, passed: true })
              }
            } as api.AgentSyncVerifierResponse;
          }
        }
      };
      const worker = open({ ports }).forWorker("custom0");
      const { lease, candidate } = await candidateOf(worker);
      await expect(worker.check(lease, "check", candidate)).rejects.toMatchObject({ code: "port_rejected" });
    }
  );
  test("requires the workspace result and publication to exist durably in the local writer", async () => {
    const { open, memory } = setup(1);
    const foreign = new MemoryProjectSync(memory.state, { "shared.ts": null, "other.ts": null });
    const worker = open({
      ports: {
        ...memory.ports,
        workspace: {
          ...memory.ports.workspace,
          freezeInput: async (lease, id) => {
            foreign.save(memory.state);
            return foreign.ports.workspace.freezeInput(lease, id);
          }
        }
      }
    }).forWorker("custom0");
    const lease = grant(await worker.requestScope("task0", "scope"));
    const before = memory.state;
    await expect(worker.freezeInput(lease, "fakefreeze")).rejects.toMatchObject({ code: "port_rejected" });
    expect(memory.state).toEqual(before);
    await memory.ports.workspace.freezeInput(lease, "realfreeze");
    foreign.save(memory.state);
    const finisher = open({ ports: { ...memory.ports, publisher: foreign.ports.publisher } }).forWorker("custom0");
    await expect(finisher.finish(lease, "foreignpublish")).rejects.toMatchObject({ code: "port_rejected" });
    expect(memory.state.acceptedTasks).toEqual([]);
  });
  test.each(["deadline", "cancel", "owner", "close"] as const)(
    "rechecks %s after an awaited verifier effect",
    async (kind) => {
      const { open, memory, setNow } = setup(1);
      const entered = deferred(),
        done = deferred();
      const service = open({
        ports: {
          ...memory.ports,
          verifier: {
            check: async (request) => {
              const result = await memory.ports.verifier.check(request);
              entered.resolve();
              await done.promise;
              return result;
            }
          }
        }
      });
      const worker = service.forWorker("custom0"),
        { lease, candidate } = await candidateOf(worker);
      const pending = worker.check(lease, "check", candidate);
      await entered.promise;
      if (kind === "deadline") setNow(memory.state.deadlineAt);
      if (kind === "cancel") await worker.cancel("task0", "cancel");
      if (kind === "owner") await open().recover("replace");
      if (kind === "close") service.close();
      done.resolve();
      await expect(pending).rejects.toBeInstanceOf(api.AgentSyncError);
      expect(memory.state.acceptedTasks).toEqual([]);
    }
  );
  test("claims standalone check IDs before backend awaits and rejects concurrent control reuse", async () => {
    const { open, memory } = setup(1);
    const entered = deferred(),
      done = deferred();
    const service = open({
      ports: {
        ...memory.ports,
        verifier: {
          check: async (request) => {
            entered.resolve();
            await done.promise;
            return memory.ports.verifier.check(request);
          }
        }
      }
    });
    const worker = service.forWorker("custom0"),
      { lease, candidate } = await candidateOf(worker);
    const pending = worker.check(lease, "sharedid", candidate);
    await entered.promise;
    expect(await worker.cancel("task0", "sharedid")).toEqual({ kind: "rejected", code: "request_id_conflict" });
    done.resolve();
    expect((await pending).receipt.passed).toBe(true);
    expect(memory.state.coordination.taskStates.task0).toBe("running");
  });
  test("binds rejected control IDs to epochs and never revokes fresh work on historical release replay", async () => {
    const { service, worker, memory } = setup(1);
    const lease = grant(await worker.requestScope("task0", "scope"));
    expect((await worker.requestScope("task0", "busy")).kind).toBe("rejected");
    await worker.freezeInput(lease, "freeze");
    const read = await worker.read(lease, "read", "shared.ts");
    await worker.release(lease, "release");
    const recovered = await service.recover("recover");
    expect(recovered).toMatchObject({ ownerEpoch: 2, replayedActions: 0, status: "paused" });
    const snapshot = memory.state;
    expect(await service.recover("recover")).toEqual(recovered);
    expect(memory.state).toEqual(snapshot);
    expect(await worker.requestScope("task0", "busy")).toEqual({ kind: "rejected", code: "request_id_conflict" });
    expect(await worker.read(lease, "read", "shared.ts")).toEqual(read);
    const fresh = grant(await worker.requestScope("task0", "fresh"));
    const before = memory.state;
    expect((await worker.release(lease, "release")).kind).toBe("replayed");
    expect(memory.state).toEqual(before);
    expect(await worker.currentLease("task0")).toEqual(fresh);
    await expect(worker.freezeInput(lease, "stale")).rejects.toBeInstanceOf(api.AgentSyncError);
    await service.recover("later");
    await expect(service.recover("recover")).rejects.toMatchObject({ code: "request_id_conflict" });
  });
  test("keeps cancelled tasks terminal and the original run deadline after recovery", async () => {
    const { service, worker, memory, setNow } = setup(1);
    await worker.cancel("task0", "cancel");
    const deadline = memory.state.deadlineAt;
    await service.recover("recover");
    expect(await worker.requestScope("task0", "fresh")).toEqual({ kind: "rejected", code: "task_cancelled" });
    expect(memory.state.deadlineAt).toBe(deadline);
    setNow(deadline);
    expect((await worker.requestScope("task0", "late")).kind).toBe("rejected");
  });
  test("recovers completion metadata without replaying publication and retains readonly finish replay", async () => {
    const { service, worker, memory } = setup(1);
    const { lease } = await candidateOf(worker);
    const publication = await memory.ports.publisher.finish(lease, "publish");
    expect(memory.state.status).toBe("active");
    const before = memory.state;
    expect(await worker.finish(lease, "publish")).toEqual(publication);
    expect(memory.state).toEqual(before);
    const result = await service.recover("recover");
    expect(result).toMatchObject({ status: "completed", ownerEpoch: 2, replayedActions: 0 });
    const after = memory.state;
    expect(await worker.finish(lease, "publish")).toEqual(publication);
    expect(memory.state).toEqual(after);
    expect((await worker.requestScope("task0", "again")).kind).toBe("rejected");
  });
  test("runs host recovery outside transactions and rejects a competing owner before committing", async () => {
    const { open, memory } = setup(1);
    const entered = deferred(),
      done = deferred();
    const service = open({
      host: {
        diff: async () => {
          throw Error("unused");
        },
        exportVersion: async () => {
          throw Error("unused");
        },
        recover: async () => {
          await memory.writer.transaction(async () => ({ value: undefined }));
          entered.resolve();
          await done.promise;
        }
      }
    });
    const pending = service.recover("one");
    await entered.promise;
    await open().recover("two");
    const snapshot = memory.state;
    done.resolve();
    await expect(pending).rejects.toMatchObject({ code: "owner_epoch_mismatch" });
    expect(memory.state).toEqual(snapshot);
  });
  test("single recovery ID races settle one owner shift without duplicate durable records", async () => {
    const { service, memory } = setup(1);
    const results = await Promise.allSettled([service.recover("recover"), service.recover("recover")]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(memory.state.ownerEpoch).toBe(2);
    expect(memory.state.coordination.requests.filter((r) => r.operation === "epoch")).toHaveLength(1);
    const snapshot = memory.state;
    await service.recover("recover");
    expect(memory.state).toEqual(snapshot);
  });
  test("session caps reject before additional writer reads and do not reset through successful recovery", async () => {
    const { open, memory } = setup(1, { maxSessionRequests: 2 });
    let loads = 0;
    const service = open({
      writer: {
        ...memory.writer,
        load: async () => {
          loads++;
          return memory.state;
        }
      }
    });
    const worker = service.forWorker("custom0");
    await worker.requestScope("task0", "scope");
    await service.recover("recover");
    const before = memory.state,
      reads = loads;
    await expect(worker.requestScope("task0", "fresh")).rejects.toMatchObject({ code: "session_request_limit" });
    expect(loads).toBe(reads);
    expect(memory.state).toEqual(before);
    expect((await service.status()).status).toBe("paused");
    expect((await open().forWorker("custom0").requestScope("task0", "fresh")).kind).toBe("granted");
  });
  test("hard caps reject before clone/load and aggregate bytes span all edit items", async () => {
    const { worker, memory } = setup(1, { maxTextBytes: 3, maxEditsPerRequest: 2 });
    const lease = grant(await worker.requestScope("task0", "scope"));
    const snapshot = memory.state;
    await expect(
      worker.edit(lease, "aggregate", [
        { path: "shared.ts", text: "ab", expectedContentHash: null },
        { path: "other.ts", text: "cd", expectedContentHash: null }
      ])
    ).rejects.toMatchObject({ code: "text_limit" });
    await expect(
      worker.edit(lease, "huge", [{ path: "shared.ts", text: "a".repeat(1048577), expectedContentHash: null }])
    ).rejects.toMatchObject({ code: "text_limit" });
    await expect(
      worker.edit(
        lease,
        "many",
        Array.from({ length: 129 }, () => ({ path: "shared.ts", text: "a", expectedContentHash: null }))
      )
    ).rejects.toMatchObject({ code: "edit_limit" });
    expect(memory.state).toEqual(snapshot);
  });
  test("host diff/export capture inputs and validate identity after await, while errors hide backend details", async () => {
    const { open, memory } = setup(1);
    const entered = deferred(),
      done = deferred();
    const version = memory.state.acceptedVersion;
    const service = open({
      host: {
        recover: async () => {},
        diff: async () => {
          entered.resolve();
          await done.promise;
          return { fromVersion: version, toVersion: version, files: [] };
        },
        exportVersion: async (options) => ({ status: "exported", version, directory: options.target })
      }
    });
    const options = { target: "original" },
      pendingExport = service.exportVersion(options);
    options.target = "changed";
    expect((await pendingExport).directory).toBe("original");
    const pending = service.diff();
    await entered.promise;
    await open().recover("replace");
    done.resolve();
    await expect(pending).rejects.toMatchObject({ code: "owner_epoch_mismatch" });
    const failed = open({
      host: {
        recover: async () => {},
        diff: async () => {
          throw Error("private secret token");
        },
        exportVersion: async () => {
          throw Error("unused");
        }
      }
    });
    await expect(failed.diff()).rejects.toMatchObject({
      name: "AgentSyncError",
      code: "port_rejected",
      message: "Agent sync operation rejected (port_rejected)"
    });
  });
});

test("resource-rejected admitted IDs remain bound to their full original request", async () => {
  const { worker, memory } = setup(1, { maxTextBytes: 3 });
  const lease = grant(await worker.requestScope("task0", "scope"));
  await worker.freezeInput(lease, "freeze");
  await expect(
    worker.edit(lease, "edit", [{ path: "shared.ts", text: "oversize", expectedContentHash: null }])
  ).rejects.toMatchObject({ code: "text_limit" });
  const before = memory.state;
  await expect(
    worker.edit(lease, "edit", [{ path: "shared.ts", text: "ok", expectedContentHash: null }])
  ).rejects.toMatchObject({ code: "request_id_conflict" });
  expect(memory.state).toEqual(before);
});

test("hard-size and project-size rejection performs no writer reads or workspace calls after initialization", async () => {
  const { open, memory } = setup(1, { maxTextBytes: 3, maxEditsPerRequest: 1 });
  let reads = 0,
    effects = 0;
  const service = open({
    writer: {
      ...memory.writer,
      load: async () => {
        reads++;
        return memory.state;
      }
    },
    ports: {
      ...memory.ports,
      workspace: {
        ...memory.ports.workspace,
        edit: async (...args) => {
          effects++;
          return memory.ports.workspace.edit(...args);
        }
      }
    }
  });
  const worker = service.forWorker("custom0"),
    lease = grant(await worker.requestScope("task0", "scope"));
  const before = reads;
  for (const [id, text] of [
    ["project", "long"],
    ["global", "x".repeat(1048577)]
  ] as const)
    await expect(
      worker.edit(lease, id, [{ path: "shared.ts", text, expectedContentHash: null }])
    ).rejects.toMatchObject({ code: "text_limit" });
  expect(reads).toBe(before);
  expect(effects).toBe(0);
});

test("reopening and recovering never turns a historical standalone check into current authority", async () => {
  const { open, worker, memory } = setup(1);
  const { lease, candidate } = await candidateOf(worker);
  await worker.check(lease, "check", candidate);
  const checks = memory.state.checkReceipts;
  const next = open();
  await next.recover("recover");
  await expect(next.forWorker("custom0").check(lease, "check", candidate)).rejects.toBeInstanceOf(api.AgentSyncError);
  expect(memory.state.checkReceipts).toEqual(checks);
  expect(memory.state.publishReceipts).toEqual([]);
});

test("completed-task rejected cancellation remains epoch-bound even without durable rejection receipts", async () => {
  const { service, worker, memory } = setup(1);
  const { lease } = await candidateOf(worker);
  await worker.finish(lease, "finish");
  expect((await worker.cancel("task0", "cancel")).kind).toBe("rejected");
  expect(memory.state.coordination.requests.some((r) => r.requestId === "cancel")).toBe(false);
  await service.recover("recover");
  const before = memory.state;
  expect(await worker.cancel("task0", "cancel")).toEqual({ kind: "rejected", code: "request_id_conflict" });
  expect(memory.state).toEqual(before);
});

test("standalone checks reject stale accepted heads while finish rechecks the combined newest head", async () => {
  const { service, worker, memory } = setup(3),
    other = service.forWorker("custom2");
  const { lease, candidate } = await candidateOf(worker);
  const independent = grant(await other.requestScope("task2", "other"));
  await other.freezeInput(independent, "otherfreeze");
  await other.edit(independent, "otheredit", [{ path: "other.ts", text: "independent", expectedContentHash: null }]);
  await other.finish(independent, "otherfinish");
  const newest = memory.state.acceptedVersion;
  await expect(worker.check(lease, "stalecheck", candidate)).rejects.toMatchObject({ code: "port_rejected" });
  const publication = await worker.finish(lease, "combined");
  expect(publication.receipt.baseVersion).toBe(newest);
  expect(memory.state.acceptedTasks).toEqual(["task2", "task0"]);
});
