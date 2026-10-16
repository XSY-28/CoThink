import { expect } from "vitest";
import {
  BUILD_CHECK_GROUPS,
  BuildWorkspaceRequestSchema,
  freezeBuildValue,
  type BuildLease,
  type BuildStagedFile,
  type BuildToolResult,
  type BuildWorkspaceRequest,
  type BuildCheckReceipt
} from "../../src/build/contracts.js";
import { bindBuildInput, parseBuildState, type BuildState } from "../../src/build/state.js";
import { validateBuildLease } from "../../src/build/scope.js";
import {
  validatePublisherPortResult,
  validateVerifierPortResult,
  validateWorkspacePortResult,
  type BuildSyncPorts,
  type BuildVerifierRequest,
  type BuildVerifierResponse
} from "../../src/build/sync-port.js";
import { hashJson, sha256 } from "../../src/peer/hash.js";
import type { BuildStateWriter } from "../../src/build/store.js";

type Sealed = Extract<BuildToolResult, { kind: "sealed" }>;
const H = hashJson("memory-test-definition");
function groups(state: BuildState, taskId: string) {
  const ids = new Set([...state.acceptedTasks, taskId]);
  const selected = new Set(["common"]);
  for (const task of state.plan.tasks)
    if (ids.has(task.taskId))
      for (const group of state.plan.profiles.find((p) => p.profileId === task.checkProfileId)!.groups)
        selected.add(group);
  if (state.plan.tasks.every((t) => ids.has(t.taskId)))
    for (const group of state.plan.profiles.find((p) => p.profileId === "final")!.groups) selected.add(group);
  return BUILD_CHECK_GROUPS.filter((g) => selected.has(g));
}
/** Deterministic contract fixture only. It performs real in-memory state effects
 * and immutable version hashing, but provides no filesystem or process isolation. */
export class MemoryBuildSync {
  private current: BuildState;
  private readonly versions = new Map<string, Readonly<Record<string, string | null>>>();
  private readonly blobs = new Map<string, string>();
  private readonly checks = new Map<string, { hash: string; result: BuildVerifierResponse }>();
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  readonly writer: BuildStateWriter = {
    load: async () => this.current,
    commit: async (expectedRevision, next) => {
      await this.writer.transaction(async (current) => {
        if (current.revision !== expectedRevision) throw new Error("Memory revision conflict");
        return { state: next, value: undefined };
      });
    },
    transaction: <T>(operation: Parameters<BuildStateWriter["transaction"]>[0]): Promise<T> => {
      const result = this.queue.then(async () => {
        const revision = this.current.revision;
        const prepared = await operation(this.current);
        if (prepared.state) {
          await prepared.beforeCommit?.(this.current);
          if (revision !== this.current.revision) throw new Error("Memory revision conflict");
          if (prepared.state.revision !== revision + 1) throw new Error("Memory snapshot revision must advance by one");
          this.current = parseBuildState(prepared.state);
        }
        return prepared.value as T;
      });
      this.queue = result.then(
        () => {},
        () => {}
      );
      return result;
    }
  };
  readonly ports: BuildSyncPorts;
  constructor(
    initial: BuildState,
    files: Readonly<Record<string, string | null>>,
    private readonly clock = () => 1000
  ) {
    this.current = parseBuildState(initial);
    this.versions.set(initial.acceptedVersion, freezeBuildValue({ ...files }));
    this.ports = {
      workspace: {
        freezeInput: (lease, requestId) =>
          this.workspace({ operation: "freeze", lease, requestId }) as Promise<
            Extract<BuildToolResult, { kind: "frozen" }>
          >,
        inspect: (lease, requestId, path) =>
          this.workspace({ operation: "inspect", lease, requestId, path }) as Promise<
            Extract<BuildToolResult, { kind: "inspected" }>
          >,
        edit: (lease, requestId, edits) =>
          this.workspace({ operation: "edit", lease, requestId, edits }) as Promise<
            Extract<BuildToolResult, { kind: "edited" }>
          >,
        seal: (lease, requestId) => this.workspace({ operation: "seal", lease, requestId }) as Promise<Sealed>
      },
      verifier: { check: async (request) => this.check(request) },
      publisher: { finish: async (lease, requestId) => this.finish(lease, requestId) }
    };
  }
  get state() {
    return this.current;
  }
  async load() {
    return this.current;
  }
  save(next: BuildState) {
    this.current = parseBuildState(next);
  }
  private guard(lease: BuildLease) {
    const valid = validateBuildLease(this.current, lease, this.clock());
    if (!valid.valid) throw new Error(`Memory sync lease: ${valid.code}`);
    return this.current.attempts.find((a) => a.attemptId === lease.attemptId)!;
  }
  private files(version: string) {
    const files = this.versions.get(version);
    if (!files) throw new Error("Unknown memory version");
    return files;
  }
  private overlay(lease: BuildLease) {
    const attempt = this.current.attempts.find((a) => a.attemptId === lease.attemptId)!;
    return (
      this.current.workspace?.staging.find((s) => s.attemptId === lease.attemptId) ?? {
        attemptId: lease.attemptId,
        baseVersion: attempt.baseVersion,
        files: [],
        overlayHash: hashJson({ attemptId: lease.attemptId, baseVersion: attempt.baseVersion, files: [] })
      }
    );
  }
  private snapshot(baseVersion: string, staged: readonly BuildStagedFile[]) {
    const files = { ...this.files(baseVersion) };
    for (const file of staged) files[file.path] = this.blobs.get(file.blobId)!;
    const records = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, text]) => ({ path, contentHash: text === null ? null : sha256(text) }));
    const candidateHash = hashJson({ baseVersion, files: records });
    const version = hashJson({ candidateHash, files }).slice(7, 47);
    this.versions.set(version, freezeBuildValue(files));
    return { version, candidateHash };
  }
  private async workspace(raw: BuildWorkspaceRequest): Promise<BuildToolResult> {
    const request = freezeBuildValue(BuildWorkspaceRequestSchema.parse(raw));
    const state = this.current;
    const requestHash = hashJson({
      projectKey: state.projectKey,
      runId: state.runId,
      planHash: state.plan.planHash,
      request
    });
    const replay = state.workspace?.toolReceipts.find((r) => r.requestId === request.requestId);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new Error("Memory request ID conflict");
      return replay.result;
    }
    if (
      this.checks.has(request.requestId) ||
      state.coordination.requests.some((r) => r.requestId === request.requestId)
    )
      throw new Error("Memory request ID conflict");
    const attempt = this.guard(request.lease);
    const task = state.plan.tasks.find((t) => t.taskId === attempt.taskId)!;
    if (request.operation !== "freeze" && attempt.inputHash === null) throw new Error("Memory input not frozen");
    let next = state;
    let workspace = state.workspace ?? {
      workspaceVersion: "build-workspace-v1" as const,
      staging: [],
      candidates: [],
      toolReceipts: []
    };
    let result: BuildToolResult;
    const baseVersion = attempt.baseVersion;
    const staged = this.overlay(request.lease);
    if (request.operation === "freeze") {
      const files = this.files(baseVersion);
      const contentHashes = Object.fromEntries(
        [...task.scope.read, ...task.scope.write].map((path) => [
          path,
          files[path] == null ? null : sha256(files[path]!)
        ])
      );
      const inputHash = hashJson({
        planHash: state.plan.planHash,
        attemptId: attempt.attemptId,
        baseVersion,
        contentHashes
      });
      if (attempt.inputHash === null) {
        const transition = bindBuildInput(
          state,
          request.lease,
          `memory-bind-${++this.sequence}`,
          { baseVersion, inputHash, contentHashes },
          this.clock()
        );
        if (transition.result.kind !== "bound") throw new Error("Memory bind rejected");
        next = transition.state;
      }
      result = { kind: "frozen", baseVersion, inputHash, contentHashes };
    } else if (request.operation === "inspect") {
      if (![...task.scope.read, ...task.scope.write].includes(request.path)) throw new Error("Memory scope rejected");
      const file = staged.files.find((f) => f.path === request.path);
      const text = file ? this.blobs.get(file.blobId)! : this.files(baseVersion)[request.path]!;
      result = {
        kind: "inspected",
        baseVersion,
        path: request.path,
        text,
        contentHash: text === null ? null : sha256(text)
      };
    } else if (request.operation === "edit") {
      if (new Set(request.edits.map((e) => e.path)).size !== request.edits.length)
        throw new Error("Memory duplicate edits");
      for (const edit of request.edits) {
        if (!task.scope.write.includes(edit.path)) throw new Error("Memory scope rejected");
        if (
          edit.text.includes("\0") ||
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(edit.text)) !==
            edit.text
        )
          throw new Error("Memory edit must be UTF-8 text");
        const text = this.files(baseVersion)[edit.path]!;
        const old =
          staged.files.find((f) => f.path === edit.path)?.contentHash ?? (text === null ? null : sha256(text));
        if (edit.expectedContentHash !== old) throw new Error("Memory old hash rejected");
      }
      const map = new Map(staged.files.map((f) => [f.path, f]));
      for (const edit of request.edits) {
        const blobId = sha256(edit.text).slice(7, 47);
        this.blobs.set(blobId, edit.text);
        map.set(edit.path, { path: edit.path, blobId, contentHash: sha256(edit.text) });
      }
      const files = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const overlay = {
        attemptId: attempt.attemptId,
        baseVersion,
        files,
        overlayHash: hashJson({ attemptId: attempt.attemptId, baseVersion, files })
      };
      workspace = {
        ...workspace,
        staging: [...workspace.staging.filter((s) => s.attemptId !== attempt.attemptId), overlay]
      };
      result = { kind: "edited", baseVersion, files, overlayHash: overlay.overlayHash };
    } else {
      result = {
        kind: "sealed",
        baseVersion,
        overlayHash: staged.overlayHash,
        ...this.snapshot(baseVersion, staged.files)
      };
      const { kind: _kind, ...fields } = result;
      void _kind;
      if (!workspace.candidates.some((c) => c.attemptId === attempt.attemptId && c.version === fields.version))
        workspace = {
          ...workspace,
          candidates: [...workspace.candidates, { attemptId: attempt.attemptId, ...fields }]
        };
    }
    this.current = parseBuildState({
      ...next,
      revision: state.revision + 1,
      workspace: {
        ...workspace,
        toolReceipts: [
          ...workspace.toolReceipts,
          {
            requestId: request.requestId,
            requestHash,
            request,
            attemptId: attempt.attemptId,
            operation: request.operation,
            result,
            outputHash: hashJson(result)
          }
        ]
      }
    });
    return validateWorkspacePortResult(this.current, request, result);
  }
  private evidence(lease: BuildLease, candidate: Sealed): BuildCheckReceipt {
    const sourceHash = hashJson(
      Object.entries(this.files(candidate.version))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, text]) => ({ path, contentHash: text === null ? null : sha256(text) }))
    );
    return freezeBuildValue({
      checkVersion: "build-check-v1",
      receiptId: `memory-check-${++this.sequence}`,
      attemptId: lease.attemptId,
      baseVersion: candidate.baseVersion,
      version: candidate.version,
      candidateHash: candidate.candidateHash,
      planHash: this.current.plan.planHash,
      groups: groups(this.current, lease.taskId),
      checksHash: H,
      toolchainHash: H,
      isolationHash: H,
      imageDigest: `sha256:${"a".repeat(64)}`,
      sourceHashBefore: sourceHash,
      sourceHashAfter: sourceHash,
      exitCode: 0,
      passed: true
    });
  }
  private check(request: BuildVerifierRequest): BuildVerifierResponse {
    const hash = hashJson(request);
    const replay = this.checks.get(request.requestId);
    if (replay) {
      if (replay.hash !== hash) throw new Error("Memory request ID conflict");
      return replay.result;
    }
    if (
      this.current.coordination.requests.some((r) => r.requestId === request.requestId) ||
      this.current.workspace?.toolReceipts.some((r) => r.requestId === request.requestId) ||
      this.current.publishReceipts.some((r) => r.requestId === request.requestId)
    )
      throw new Error("Memory request ID conflict");
    this.guard(request.lease);
    const result = validateVerifierPortResult(this.current, request, {
      requestId: request.requestId,
      receipt: this.evidence(request.lease, request.candidate)
    });
    this.checks.set(request.requestId, { hash, result });
    return result;
  }
  private finish(lease: BuildLease, requestId: string) {
    const before = this.current;
    const requestHash = hashJson({
      projectKey: before.projectKey,
      runId: before.runId,
      planHash: before.plan.planHash,
      operation: "publish",
      lease,
      requestId,
      exportTarget: null
    });
    const replay = before.publishReceipts.find((r) => r.requestId === requestId);
    if (replay)
      return validatePublisherPortResult(before, lease, requestId, { status: "accepted", receipt: replay }, before);
    if (this.checks.has(requestId) || before.workspace?.toolReceipts.some((r) => r.requestId === requestId))
      throw new Error("Memory request ID conflict");
    const attempt = this.guard(lease);
    if (attempt.inputHash === null) throw new Error("Memory input not frozen");
    for (const [path, hash] of Object.entries(attempt.contentHashes)) {
      const text = this.files(before.acceptedVersion)[path]!;
      if ((text === null ? null : sha256(text)) !== hash) throw new Error("Memory granted input changed");
    }
    const staged = this.overlay(lease);
    const candidate = {
      kind: "sealed" as const,
      baseVersion: before.acceptedVersion,
      overlayHash: staged.overlayHash,
      ...this.snapshot(before.acceptedVersion, staged.files)
    };
    const check = this.evidence(lease, candidate);
    const receipt = {
      publishVersion: "build-publish-v1" as const,
      receiptId: `memory-publish-${++this.sequence}`,
      requestId,
      attemptId: lease.attemptId,
      checkReceiptId: check.receiptId,
      baseVersion: candidate.baseVersion,
      acceptedVersion: candidate.version,
      candidateHash: candidate.candidateHash,
      checksHash: check.checksHash,
      requestHash,
      planHash: before.plan.planHash,
      ownerEpoch: lease.ownerEpoch,
      leaseEpoch: lease.leaseEpoch,
      inputHash: attempt.inputHash,
      overlayHash: staged.overlayHash,
      toolchainHash: check.toolchainHash,
      isolationHash: check.isolationHash,
      imageDigest: check.imageDigest
    };
    this.current = parseBuildState({
      ...before,
      revision: before.revision + 1,
      acceptedVersion: candidate.version,
      acceptedTasks: [...before.acceptedTasks, lease.taskId],
      attempts: before.attempts.map((a) => (a.attemptId === lease.attemptId ? { ...a, status: "completed" } : a)),
      checkReceipts: [...before.checkReceipts, check],
      publishReceipts: [...before.publishReceipts, receipt],
      coordination: {
        ...before.coordination,
        lastNow: this.clock(),
        taskStates: { ...before.coordination.taskStates, [lease.taskId]: "completed" },
        taskEpochs: { ...before.coordination.taskEpochs, [lease.taskId]: lease.leaseEpoch + 1 },
        locks: before.coordination.locks.filter((l) => l.attemptId !== lease.attemptId),
        requests: before.coordination.requests.map((r) =>
          r.attemptId === lease.attemptId && r.status === "pending" ? { ...r, status: "invalidated" } : r
        )
      }
    });
    return validatePublisherPortResult(before, lease, requestId, { status: "accepted", receipt }, this.current);
  }
}

/** The identical exercise runs against memory and real disk/Git local ports. */
export async function exerciseSyncPortContract(h: {
  ports: BuildSyncPorts;
  lease: BuildLease;
  load(): Promise<BuildState>;
}) {
  const { ports, lease } = h;
  const frozen = await ports.workspace.freezeInput(lease, "contract-freeze");
  expect(frozen.kind).toBe("frozen");
  const read = await ports.workspace.inspect(lease, "contract-inspect", "src/normalize.ts");
  expect(read.baseVersion).toBe(frozen.baseVersion);
  const edits = [
    { path: read.path, text: read.text + "\n// contract private edit\n", expectedContentHash: read.contentHash }
  ];
  const edit = await ports.workspace.edit(lease, "contract-edit", edits);
  expect(await ports.workspace.edit(lease, "contract-edit", edits)).toEqual(edit);
  await expect(ports.workspace.edit(lease, "contract-edit", [{ ...edits[0]!, text: "different" }])).rejects.toThrow();
  expect((await h.load()).acceptedVersion).toBe(frozen.baseVersion);
  const candidate = await ports.workspace.seal(lease, "contract-seal");
  const request = { requestId: "contract-check", lease, candidate };
  const beforeCheck = await h.load();
  const check = await ports.verifier.check(request);
  expect(validateVerifierPortResult(await h.load(), request, check).receipt.passed).toBe(true);
  expect(await h.load()).toEqual(beforeCheck);
  expect(await ports.verifier.check(request)).toEqual(check);
  await expect(ports.workspace.inspect(lease, request.requestId, read.path)).rejects.toThrow();
  await expect(ports.verifier.check({ ...request, candidate: { ...candidate, candidateHash: H } })).rejects.toThrow();
  const before = await h.load();
  const published = await ports.publisher.finish(lease, "contract-publish");
  expect(validatePublisherPortResult(before, lease, "contract-publish", published, await h.load())).toEqual(published);
  const after = await h.load();
  expect(await ports.publisher.finish(lease, "contract-publish")).toEqual(published);
  expect(await h.load()).toEqual(after);
}
