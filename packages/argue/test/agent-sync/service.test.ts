import { describe, expect, it, vi } from "vitest";
import { AgentSyncError, AgentSyncService } from "../../src/agent-sync/service.js";
import { createBuildState, parseBuildState, type BuildOperationResult } from "../../src/build/state.js";
import type { BuildLease } from "../../src/build/contracts.js";
import type { BuildSyncPorts } from "../../src/build/sync-port.js";
import { reserveBuildCall } from "../../src/build/budget.js";
import { hashJson } from "../../src/peer/hash.js";
import { runInput } from "../build/fixtures.js";
import { MemoryBuildSync } from "../build/sync-port-fixture.js";

// Unit contract evidence only: actual MemoryBuildSync effects, NOT disk or Docker.
function setup(override?: (ports: BuildSyncPorts) => BuildSyncPorts) {
  let now = 1000,
    sequence = 0;
  const memory = new MemoryBuildSync(
    createBuildState(runInput()),
    {
      "SPEC.md": "spec",
      "src/normalize.ts": "v0",
      "src/report.ts": "total"
    },
    () => now
  );
  const ports = override?.(memory.ports) ?? memory.ports;
  const service = new AgentSyncService({
    writer: memory.writer,
    ports,
    expectedRunId: "run-1",
    expectedPlanHash: memory.state.plan.planHash,
    expectedOwnerEpoch: 1,
    clock: () => now,
    allocateLease: () => ({ attemptId: `attempt-${++sequence}`, token: `secret-${sequence}` })
  });
  return {
    memory,
    service,
    a: service.forWorker("member-a"),
    b: service.forWorker("member-b"),
    setNow: (n: number) => {
      now = n;
    }
  };
}
function grant(result: BuildOperationResult): BuildLease {
  expect(result.kind).toBe("granted");
  if (result.kind !== "granted") throw new Error("Expected grant");
  return result.lease;
}

describe("AgentSyncService — pure memory unit contract (NOT disk/Docker)", () => {
  it("identifies the public projection without changing persisted schema versions", async () => {
    const { memory, service } = setup();
    expect(await service.status()).toMatchObject({ serviceVersion: "agent-sync-service-v1" });
    expect(memory.state).not.toHaveProperty("serviceVersion");
  });
  it("admits A, waits B2, independently admits B1 and completes through actual ports without model calls", async () => {
    const { memory, service, a, b } = setup();
    const la = grant(await a.requestScope("T-A", "scope-a"));
    expect((await b.requestScope("T-B2", "scope-b2")).kind).toBe("waiting");
    const lb = grant(await b.requestScope("T-B1", "scope-b1"));
    await a.freezeInput(la, "freeze-a");
    const read = await a.read(la, "read-a", "src/normalize.ts");
    await a.edit(la, "edit-a", [{ path: read.path, text: "updated", expectedContentHash: read.contentHash }]);
    const candidate = await a.seal(la, "seal-a");
    const before = memory.state.acceptedVersion;
    expect((await a.check(la, "check-a", candidate)).receipt.passed).toBe(true);
    expect(memory.state.acceptedVersion).toBe(before);
    await a.finish(la, "finish-a");
    await b.freezeInput(lb, "freeze-b1");
    await b.finish(lb, "finish-b1");
    const l2 = grant(await b.requestScope("T-B2", "scope-b2-new"));
    expect(Object.keys(l2).sort()).toEqual(["attemptId", "leaseEpoch", "ownerEpoch", "taskId", "token", "workerId"]);
    await b.freezeInput(l2, "freeze-b2");
    await b.finish(l2, "finish-b2");
    expect((await service.status()).status).toBe("completed");
    expect(memory.state.acceptedTasks).toEqual(["T-A", "T-B1", "T-B2"]);
    expect(memory.state.calls).toEqual([]);
    expect(memory.state.workspace?.toolReceipts.find((r) => r.requestId === "freeze-a")?.result).toMatchObject({
      contentHashes: { "SPEC.md": expect.any(String), "src/normalize.ts": expect.any(String) }
    });
    expect(memory.state.workspace?.staging[0]?.files[0]?.path).toBe("src/normalize.ts");
  });

  it("binds workers, rejects foreign/forged/malformed authority before backend effects, and redacts status", async () => {
    const effects = vi.fn();
    const { memory, service, a, b } = setup((p) => ({
      ...p,
      workspace: {
        ...p.workspace,
        freezeInput: async (...args) => {
          effects();
          return p.workspace.freezeInput(...args);
        }
      }
    }));
    expect(() => service.forWorker("intruder")).toThrow(AgentSyncError);
    await expect(a.requestScope("missing-task", "unknown-task")).rejects.toMatchObject({ code: "unknown_task" });
    await expect(b.requestScope("T-A", "foreign-task")).rejects.toMatchObject({ code: "worker_task_mismatch" });
    const lease = grant(await a.requestScope("T-A", "scope-a"));
    await expect(b.freezeInput(lease, "foreign-lease")).rejects.toMatchObject({ code: "worker_task_mismatch" });
    await expect(a.freezeInput({ ...lease, token: "forged" }, "forged")).rejects.toMatchObject({
      code: "identity_mismatch"
    });
    await expect(
      a.freezeInput({ ...lease, inputHash: hashJson("forged") } as BuildLease, "extra-field")
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(effects).not.toHaveBeenCalled();
    const publicText = JSON.stringify(await service.status());
    expect(publicText).not.toMatch(/secret-|token|nonce|inputHash|calls|coordination/);
    expect(memory.state.attempts).toHaveLength(1);
  });

  it("copies and freezes mutable input before awaiting IO", async () => {
    const { memory, a } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const read = await a.read(lease, "read", "src/normalize.ts");
    const edits = [{ path: read.path, text: "original", expectedContentHash: read.contentHash }];
    const mutableLease = { ...lease };
    const pending = a.edit(mutableLease, "edit", edits);
    edits[0]!.text = "mutated";
    mutableLease.token = "mutated";
    await pending;
    const receipt = memory.state.workspace?.toolReceipts.find((r) => r.requestId === "edit");
    expect(receipt?.request).toMatchObject({ edits: [{ text: "original" }], lease: { token: lease.token } });
    expect(Object.isFrozen(receipt?.request)).toBe(true);
  });

  it("exposes incidental older waiter grants only through their worker currentLease without dispatch", async () => {
    const { memory, service, a, b } = setup();
    const la = grant(await a.requestScope("T-A", "scope-a"));
    await b.requestScope("T-B2", "wait-b2");
    await a.release(la, "release");
    expect(await b.currentLease("T-B2")).toBeNull();
    expect((await b.requestScope("T-B1", "scope-b1")).kind).toBe("waiting");
    const incidental = await b.currentLease("T-B2");
    expect(incidental?.taskId).toBe("T-B2");
    expect(await b.currentLease("T-B2")).toEqual(incidental);
    expect(memory.state.attempts.filter((x) => x.taskId === "T-B2")).toHaveLength(1);
    expect(memory.state.calls).toEqual([]);
    expect("run" in service || "dispatch" in service).toBe(false);
    await expect(a.currentLease("T-B2")).rejects.toMatchObject({ code: "worker_task_mismatch" });
  });

  it("preserves successful read/release/cancel replay without reviving capability or cancelled tasks", async () => {
    const { memory, a, b } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const read = await a.read(lease, "read", "src/normalize.ts");
    await a.release(lease, "release");
    const before = memory.state;
    expect((await a.release(lease, "release")).kind).toBe("replayed");
    expect(await a.read(lease, "read", read.path)).toEqual(read);
    expect(memory.state).toEqual(before);
    await expect(a.read(lease, "fresh-read", read.path)).rejects.toMatchObject({ code: "attempt_invalidated" });
    await expect(a.read(lease, "read", "SPEC.md")).rejects.toMatchObject({ code: "request_id_conflict" });
    expect((await a.cancel("T-A", "cancel")).kind).toBe("cancelled");
    expect((await a.cancel("T-A", "cancel")).kind).toBe("replayed");
    expect(await a.requestScope("T-A", "retry-cancelled")).toEqual({ kind: "rejected", code: "task_cancelled" });
    expect(await b.requestScope("T-B1", "read")).toEqual({ kind: "rejected", code: "request_id_conflict" });
  });

  it("refuses check ID reuse across operations and altered candidates", async () => {
    const { a } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const candidate = await a.seal(lease, "seal");
    await a.check(lease, "check", candidate);
    await expect(a.check(lease, "check", { ...candidate, candidateHash: hashJson("changed") })).rejects.toMatchObject({
      code: "request_id_conflict"
    });
    expect(await a.cancel("T-A", "check")).toEqual({ kind: "rejected", code: "request_id_conflict" });
    await expect(a.read(lease, "check", "SPEC.md")).rejects.toMatchObject({ code: "request_id_conflict" });
  });

  it("binds rejected scope IDs to their trusted owner epoch without resuming or allocating after recovery", async () => {
    const { memory, service, a } = setup();
    grant(await a.requestScope("T-A", "initial-grant"));
    expect(await a.requestScope("T-A", "old-rejected-id")).toEqual({
      kind: "rejected",
      code: "task_already_active"
    });
    expect(memory.state.coordination.requests.some((r) => r.requestId === "old-rejected-id")).toBe(false);
    await service.recover("recover-rejected-id");
    const recovered = memory.state;
    expect(recovered.status).toBe("paused");
    expect(await a.requestScope("T-A", "old-rejected-id")).toEqual({
      kind: "rejected",
      code: "request_id_conflict"
    });
    expect(memory.state).toBe(recovered);
    expect(memory.state.status).toBe("paused");
    expect(memory.state.revision).toBe(recovered.revision);
    expect(memory.state.attempts).toHaveLength(1);
    expect(await a.currentLease("T-A")).toBeNull();
    const fresh = grant(await a.requestScope("T-A", "fresh-after-recovery"));
    expect(fresh.ownerEpoch).toBe(2);
    expect(memory.state.status).toBe("active");
    expect(memory.state.revision).toBe(recovered.revision + 1);
    expect(memory.state.attempts).toHaveLength(2);
  });

  it("binds rejected completed-task cancellation IDs to their trusted owner epoch", async () => {
    const { memory, service, a } = setup();
    const lease = grant(await a.requestScope("T-A", "grant"));
    await a.freezeInput(lease, "freeze");
    await a.finish(lease, "finish");
    expect(await a.cancel("T-A", "old-rejected-cancel")).toEqual({ kind: "rejected", code: "task_completed" });
    expect(memory.state.coordination.requests.some((r) => r.requestId === "old-rejected-cancel")).toBe(false);
    await service.recover("recover-rejected-cancel");
    const recovered = memory.state;
    expect(await a.cancel("T-A", "old-rejected-cancel")).toEqual({ kind: "rejected", code: "request_id_conflict" });
    expect(memory.state).toBe(recovered);
    expect(await a.cancel("T-A", "fresh-completed-cancel")).toEqual({ kind: "rejected", code: "task_completed" });
    expect(memory.state).toBe(recovered);
  });

  it("preserves exact lease-bound historical release replay across recovery without revoking fresh work", async () => {
    const { memory, service, a } = setup();
    const original = grant(await a.requestScope("T-A", "original-grant"));
    expect((await a.release(original, "original-release")).kind).toBe("released");
    await service.recover("recover-release");
    const fresh = grant(await a.requestScope("T-A", "fresh-grant"));
    const before = memory.state;
    expect(await a.release(original, "original-release")).toMatchObject({
      kind: "replayed",
      receipt: { kind: "released", attemptId: original.attemptId }
    });
    expect(memory.state).toBe(before);
    expect(await a.currentLease("T-A")).toEqual(fresh);
  });

  it.each(["owner", "plan", "run"])("rejects stale %s without touching replacement state", async (replacement) => {
    const { memory, service, a } = setup();
    await service.status();
    if (replacement === "owner") memory.save(parseBuildState({ ...memory.state, ownerEpoch: 2 }));
    else if (replacement === "run") memory.save(parseBuildState({ ...memory.state, runId: "replacement" }));
    else {
      const { freezeBuildPlan } = await import("../../src/build/contracts.js");
      const { planInput } = await import("../build/fixtures.js");
      const input = planInput();
      input.budget.maxCalls--;
      memory.save(parseBuildState({ ...memory.state, plan: freezeBuildPlan(input) }));
    }
    const before = memory.state;
    await expect(a.requestScope("T-A", "scope")).rejects.toBeInstanceOf(AgentSyncError);
    await expect(service.recover("recover")).rejects.toBeInstanceOf(AgentSyncError);
    expect(memory.state).toBe(before);
  });

  it("rejects expired IO and closes escaped clients", async () => {
    const { memory, service, a, setNow } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    setNow(901000);
    expect(await a.currentLease("T-A")).toBeNull();
    await expect(a.freezeInput(lease, "freeze")).rejects.toMatchObject({ code: "deadline_exceeded" });
    const escaped = a.currentLease;
    const before = memory.state;
    service.close();
    await expect(escaped("T-A")).rejects.toMatchObject({ code: "service_closed" });
    await expect(service.status()).rejects.toMatchObject({ code: "service_closed" });
    expect(() => service.forWorker("member-a")).toThrow(AgentSyncError);
    expect(memory.state).toBe(before);
  });

  it("validates actual check and publication evidence rather than trusting fake passed/accepted replies", async () => {
    const { memory, a } = setup((p) => ({
      ...p,
      verifier: { check: async () => ({ requestId: "fake", receipt: { passed: true } }) as never },
      publisher: { finish: async () => ({ status: "accepted", receipt: {} }) as never }
    }));
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const candidate = await a.seal(lease, "seal");
    const before = memory.state;
    await expect(a.check(lease, "check", candidate)).rejects.toMatchObject({ code: "port_rejected" });
    await expect(a.finish(lease, "finish")).rejects.toMatchObject({ code: "port_rejected" });
    expect(memory.state).toBe(before);
  });

  it("rejects structurally complete mismatched replies and current clock expiry after a check", async () => {
    let mutate = true;
    const h = setup((p) => ({
      ...p,
      verifier: {
        check: async (request) => {
          const response = await p.verifier.check(request);
          if (mutate) return { ...response, receipt: { ...response.receipt, candidateHash: hashJson("wrong") } };
          h.setNow(901000);
          return response;
        }
      }
    }));
    const lease = grant(await h.a.requestScope("T-A", "scope"));
    await h.a.freezeInput(lease, "freeze");
    const candidate = await h.a.seal(lease, "seal");
    await expect(h.a.check(lease, "check", candidate)).rejects.toMatchObject({ code: "port_rejected" });
    mutate = false;
    await expect(h.a.check(lease, "check-again", candidate)).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(h.memory.state.publishReceipts).toEqual([]);
  });

  it("recovers legacy allocations without ports, preserves accepted tasks/history and resumes only explicit fresh requests", async () => {
    let portCalls = 0;
    const { memory, service, a, b } = setup((p) => ({
      workspace: Object.fromEntries(
        Object.entries(p.workspace).map(([k, f]) => [
          k,
          (...args: unknown[]) => {
            portCalls++;
            return (f as (...a: unknown[]) => unknown)(...args);
          }
        ])
      ) as unknown as BuildSyncPorts["workspace"],
      verifier: {
        check: async (request) => {
          portCalls++;
          return p.verifier.check(request);
        }
      },
      publisher: {
        finish: async (...args) => {
          portCalls++;
          return p.publisher.finish(...args);
        }
      }
    }));
    const lb = grant(await b.requestScope("T-B1", "scope-b1"));
    await b.freezeInput(lb, "freeze-b1");
    const completedRead = await b.read(lb, "historic-read", "src/report.ts");
    const published = await b.finish(lb, "finish-b1");
    const la = grant(await a.requestScope("T-A", "scope-a"));
    await a.freezeInput(la, "freeze-a");
    await b.requestScope("T-B2", "wait-b2");
    memory.save(reserveBuildCall(memory.state, la, "legacy-call", 1000, 128).state);
    const accepted = memory.state.acceptedVersion,
      deadline = memory.state.deadlineAt,
      count = portCalls;
    const result = await service.recover("recovery-1");
    expect(result).toMatchObject({ replayedActions: 0, ownerEpoch: 2, acceptedVersion: accepted, status: "paused" });
    expect(portCalls).toBe(count);
    expect(memory.state.calls[0]).toMatchObject({ status: "unknown", allocatedOutputTokens: 128 });
    expect(memory.state.acceptedTasks).toEqual(["T-B1"]);
    expect(memory.state.waiting).toEqual([{ taskId: "T-B2", sequence: expect.any(Number) }]);
    const after = memory.state;
    await service.recover("recovery-1");
    expect(memory.state).toBe(after);
    await expect(a.read(la, "fresh-old-lease", "SPEC.md")).rejects.toMatchObject({ code: "attempt_invalidated" });
    expect(await b.read(lb, "historic-read", "src/report.ts")).toEqual(completedRead);
    expect(await b.finish(lb, "finish-b1")).toEqual(published);
    expect(await a.requestScope("T-A", "scope-a")).toEqual({ kind: "rejected", code: "request_id_conflict" });
    expect(memory.state.status).toBe("paused");
    await b.requestScope("T-B2", "resume-new");
    expect(memory.state.status).toBe("active");
    expect(memory.state.deadlineAt).toBe(deadline);
    expect(memory.state.calls).toHaveLength(1);
    const resumed = memory.state;
    await service.recover("recovery-1");
    expect(memory.state).toBe(resumed);
    expect(await b.currentLease("T-B2")).not.toBeNull();
  });

  it("guards optional host operations and keeps them off worker clients", async () => {
    const { memory, service, a } = setup();
    await expect(service.diff()).rejects.toMatchObject({ code: "host_operation_unavailable" });
    await expect(service.exportVersion({ target: "target" })).rejects.toMatchObject({
      code: "host_operation_unavailable"
    });
    expect("diff" in a || "exportVersion" in a || "recover" in a).toBe(false);
    const calls: string[] = [];
    const hostService = new AgentSyncService({
      writer: memory.writer,
      ports: memory.ports,
      expectedPlanHash: memory.state.plan.planHash,
      expectedRunId: "run-1",
      clock: () => 1000,
      host: {
        diff: async (options) => {
          calls.push("diff");
          return {
            fromVersion: options?.fromVersion ?? memory.state.acceptedVersion,
            toVersion: memory.state.acceptedVersion,
            files: []
          };
        },
        exportVersion: async (options) => {
          calls.push("export");
          return { status: "exported", version: memory.state.acceptedVersion, directory: options.target };
        },
        recover: async () => {
          calls.push("recover");
        }
      }
    });
    expect((await hostService.diff()).files).toEqual([]);
    expect((await hostService.exportVersion({ target: "out" })).directory).toBe("out");
    await hostService.recover("host-recover");
    expect(calls).toEqual(["diff", "export", "recover"]);
    hostService.close();
    await expect(hostService.diff()).rejects.toMatchObject({ code: "service_closed" });
    expect(calls).toHaveLength(3);
  });

  it("keeps historical publication queries effect-free even if completion marking was interrupted", async () => {
    const { memory, service, a, b } = setup();
    for (const [worker, task] of [
      [a, "T-A"],
      [b, "T-B1"],
      [b, "T-B2"]
    ] as const) {
      const lease = grant(await worker.requestScope(task, `scope-${task}`));
      await worker.freezeInput(lease, `freeze-${task}`);
      await worker.finish(lease, `finish-${task}`);
    }
    expect(memory.state.status).toBe("completed");
    memory.save(parseBuildState({ ...memory.state, status: "active", revision: memory.state.revision + 1 }));
    const interrupted = memory.state;
    const lease = memory.state.attempts.find((x) => x.taskId === "T-B2")!;
    const capability = {
      attemptId: lease.attemptId,
      taskId: lease.taskId,
      workerId: lease.workerId,
      ownerEpoch: lease.ownerEpoch,
      leaseEpoch: lease.leaseEpoch!,
      token: lease.token
    };
    await b.finish(capability, "finish-T-B2");
    expect(memory.state).toBe(interrupted);
    const receipts = memory.state.publishReceipts;
    await service.recover("reconcile-completion");
    expect(memory.state.status).toBe("completed");
    expect(memory.state.publishReceipts).toEqual(receipts);
  });

  it("checks scope and durable sealed candidate before calling any backend", async () => {
    const verifier = vi.fn();
    const { memory, a } = setup((p) => ({
      ...p,
      verifier: {
        check: async (request) => {
          verifier();
          return p.verifier.check(request);
        }
      }
    }));
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const before = memory.state;
    await expect(a.read(lease, "foreign-path", "src/report.ts")).rejects.toMatchObject({ code: "scope_violation" });
    await expect(
      a.edit(lease, "readonly-path", [{ path: "SPEC.md", text: "write", expectedContentHash: null }])
    ).rejects.toMatchObject({ code: "scope_violation" });
    const candidate = await a.seal(lease, "seal");
    await expect(a.check(lease, "forged-candidate", { ...candidate, version: "b".repeat(40) })).rejects.toMatchObject({
      code: "candidate_mismatch"
    });
    expect(verifier).not.toHaveBeenCalled();
    expect(memory.state.workspace?.toolReceipts).toHaveLength((before.workspace?.toolReceipts.length ?? 0) + 1);
  });

  it("rejects a backend workspace result without the exact durable matching result", async () => {
    const { a } = setup((p) => ({
      ...p,
      workspace: {
        ...p.workspace,
        inspect: async (...args) => ({ ...(await p.workspace.inspect(...args)), text: "forged" })
      }
    }));
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    await expect(a.read(lease, "read", "SPEC.md")).rejects.toMatchObject({ code: "port_rejected" });
  });

  it("rejects an incomplete durable grant before backend IO", async () => {
    const { memory, a } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    const broken = { ...memory.state, coordination: { ...memory.state.coordination, locks: [] } };
    const effect = vi.fn();
    const service = new AgentSyncService({
      writer: { ...memory.writer, load: async () => broken },
      ports: {
        ...memory.ports,
        workspace: {
          ...memory.ports.workspace,
          freezeInput: async (...args) => {
            effect();
            return memory.ports.workspace.freezeInput(...args);
          }
        }
      },
      expectedPlanHash: memory.state.plan.planHash,
      expectedRunId: "run-1",
      clock: () => 1000
    });
    await expect(service.forWorker("member-a").freezeInput(lease, "freeze")).rejects.toMatchObject({
      code: "port_rejected"
    });
    expect(effect).not.toHaveBeenCalled();
    expect(memory.state.coordination.locks.length).toBeGreaterThan(0);
  });

  it("rejects a structurally valid publication produced in a different memory store without local durable acceptance", async () => {
    const h = setup((p) => ({
      ...p,
      publisher: {
        finish: async (lease, requestId) => {
          const shadow = new MemoryBuildSync(h.memory.state, {
            "SPEC.md": "spec",
            "src/normalize.ts": "v0",
            "src/report.ts": "total"
          });
          return shadow.ports.publisher.finish(lease, requestId);
        }
      }
    }));
    const lease = grant(await h.a.requestScope("T-A", "scope"));
    await h.a.freezeInput(lease, "freeze");
    const before = h.memory.state;
    await expect(h.a.finish(lease, "finish")).rejects.toMatchObject({ code: "port_rejected" });
    expect(h.memory.state).toBe(before);
    expect(h.memory.state.acceptedTasks).toEqual([]);
  });

  it("reserves same-session check IDs before backend await so a concurrent control cannot claim them", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { memory, a } = setup((p) => ({
      ...p,
      verifier: {
        check: async (request) => {
          enter();
          await barrier;
          return p.verifier.check(request);
        }
      }
    }));
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const candidate = await a.seal(lease, "seal");
    const pending = a.check(lease, "shared-check", candidate);
    await entered;
    const before = memory.state;
    expect(await a.cancel("T-A", "shared-check")).toEqual({ kind: "rejected", code: "request_id_conflict" });
    expect(memory.state).toBe(before);
    release();
    await pending;
  });

  it("does not resume terminal runs or extend an expired global cutoff", async () => {
    for (const status of ["paused", "cancelled", "completed"] as const) {
      const { memory, a, setNow } = setup();
      if (status === "completed") {
        // Terminal run status is independent of acceptance projection in the legacy schema.
        memory.save(parseBuildState({ ...memory.state, status }));
      } else memory.save(parseBuildState({ ...memory.state, status }));
      if (status === "paused") setNow(memory.state.deadlineAt);
      const before = memory.state;
      expect(await a.requestScope("T-A", "scope")).toEqual({ kind: "rejected", code: "run_inactive" });
      expect(memory.state).toBe(before);
    }
  });

  it("normalizes recovery with legacy call settlement and epoch revocation into one durable revision", async () => {
    const { memory, service, a } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    memory.save(reserveBuildCall(memory.state, lease, "old-call", 1000, 128).state);
    const revision = memory.state.revision;
    await service.recover("recover");
    expect(memory.state.revision).toBe(revision + 1);
    expect(memory.state.ownerEpoch).toBe(2);
  });

  it("never treats a prior standalone check as fresh authority after reopening and recovery", async () => {
    const { memory, service, a } = setup();
    const lease = grant(await a.requestScope("T-A", "scope"));
    await a.freezeInput(lease, "freeze");
    const candidate = await a.seal(lease, "seal");
    await a.check(lease, "old-check", candidate);
    service.close();
    const reopened = new AgentSyncService({
      writer: memory.writer,
      ports: memory.ports,
      expectedPlanHash: memory.state.plan.planHash,
      expectedRunId: "run-1",
      clock: () => 1000
    });
    await reopened.recover("reopened-recovery");
    const before = memory.state;
    await expect(reopened.forWorker("member-a").check(lease, "old-check", candidate)).rejects.toMatchObject({
      code: "attempt_invalidated"
    });
    expect(memory.state).toBe(before);
  });

  it("validates host committed assets outside the writer and leaves state untouched on failure or replacement", async () => {
    for (const replacement of [false, true]) {
      const { memory } = setup();
      let replacementState = memory.state;
      const hostService = new AgentSyncService({
        writer: memory.writer,
        ports: memory.ports,
        expectedPlanHash: memory.state.plan.planHash,
        expectedRunId: "run-1",
        clock: () => 1000,
        host: {
          diff: async () => ({
            fromVersion: memory.state.acceptedVersion,
            toVersion: memory.state.acceptedVersion,
            files: []
          }),
          exportVersion: async (options) => ({
            status: "exported",
            version: memory.state.acceptedVersion,
            directory: options.target
          }),
          recover: async () => {
            await memory.writer.transaction(async () => ({ value: undefined }));
            if (replacement) {
              memory.save(parseBuildState({ ...memory.state, ownerEpoch: 2 }));
              replacementState = memory.state;
            } else throw new Error("private backend diagnostic");
          }
        }
      });
      const failure = hostService.recover("recovery");
      await expect(failure).rejects.toMatchObject({ code: replacement ? "owner_epoch_mismatch" : "port_rejected" });
      await expect(failure).rejects.not.toThrow("private backend diagnostic");
      expect(memory.state).toBe(replacementState);
    }
  });

  it("guards host diffs/exports after external replacement and after close", async () => {
    const { memory } = setup();
    const calls = vi.fn();
    const hostService = new AgentSyncService({
      writer: memory.writer,
      ports: memory.ports,
      expectedPlanHash: memory.state.plan.planHash,
      expectedRunId: "run-1",
      clock: () => 1000,
      host: {
        diff: async () => {
          calls();
          return { fromVersion: memory.state.acceptedVersion, toVersion: memory.state.acceptedVersion, files: [] };
        },
        exportVersion: async (options) => {
          calls();
          return { status: "exported", version: memory.state.acceptedVersion, directory: options.target };
        },
        recover: async () => {}
      }
    });
    await hostService.status();
    memory.save(parseBuildState({ ...memory.state, ownerEpoch: 2 }));
    await expect(hostService.diff()).rejects.toMatchObject({ code: "owner_epoch_mismatch" });
    await expect(hostService.exportVersion({ target: "out" })).rejects.toMatchObject({ code: "owner_epoch_mismatch" });
    hostService.close();
    await expect(hostService.exportVersion({ target: "out" })).rejects.toMatchObject({ code: "service_closed" });
    expect(calls).not.toHaveBeenCalled();
  });
});
