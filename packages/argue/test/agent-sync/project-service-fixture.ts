import {
  AGENT_SYNC_REQUEST_VERSION,
  AGENT_SYNC_WORKSPACE_VERSION,
  AGENT_SYNC_CHECK_VERSION,
  AGENT_SYNC_PUBLISH_VERSION,
  AGENT_SYNC_TOOL_RECEIPT_VERSION,
  AGENT_SYNC_CANDIDATE_VERSION,
  AgentSyncWorkspaceRequestSchema,
  bindAgentSyncInput,
  parseAgentSyncState,
  validateAgentSyncLease,
  validateAgentSyncWorkspacePortResult,
  validateAgentSyncVerifierPortResult,
  validateAgentSyncPublisherPortResult,
  agentSyncPublicationChecks,
  agentSyncPublishRequestHash,
  type AgentSyncState,
  type AgentSyncLease,
  type AgentSyncStagedFile,
  type AgentSyncToolResult,
  type AgentSyncWorkspaceRequest,
  type AgentSyncCheckReceipt,
  type AgentSyncPorts,
  type AgentSyncVerifierRequest,
  type AgentSyncVerifierResponse,
  type AgentSyncStateWriter
} from "../../src/agent-sync/project/index.js";
import { freezeSyncValue } from "../../src/agent-sync/kernel/primitives.js";
import { hashJson, sha256 } from "../../src/peer/hash.js";
type Sealed = Extract<AgentSyncToolResult, { kind: "sealed" }>;
const H = hashJson("memory-test-definition");
/** Deterministic contract fixture only. It performs real in-memory state effects
 * and immutable version hashing, but provides no filesystem or process isolation. */
export class MemoryProjectSync {
  private current: AgentSyncState;
  private readonly versions = new Map<string, Readonly<Record<string, string | null>>>();
  private readonly blobs = new Map<string, string>();
  private readonly checks = new Map<string, { hash: string; result: AgentSyncVerifierResponse }>();
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  readonly writer: AgentSyncStateWriter = {
    load: async () => this.current,
    commit: async (expectedRevision, next) => {
      await this.writer.transaction(async (current) => {
        if (current.revision !== expectedRevision) throw new Error("Memory revision conflict");
        return { state: next, value: undefined };
      });
    },
    transaction: <T>(operation: Parameters<AgentSyncStateWriter["transaction"]>[0]): Promise<T> => {
      const result = this.queue.then(async () => {
        const revision = this.current.revision;
        const prepared = await operation(this.current);
        if (prepared.state) {
          await prepared.beforeCommit?.(this.current);
          if (revision !== this.current.revision) throw new Error("Memory revision conflict");
          if (prepared.state.revision !== revision + 1) throw new Error("Memory snapshot revision must advance by one");
          this.current = parseAgentSyncState(prepared.state);
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
  readonly ports: AgentSyncPorts;
  constructor(
    initial: AgentSyncState,
    files: Readonly<Record<string, string | null>>,
    private readonly clock = () => 1000
  ) {
    this.current = parseAgentSyncState(initial);
    this.versions.set(initial.acceptedVersion, freezeSyncValue({ ...files }));
    this.ports = {
      workspace: {
        freezeInput: (lease, requestId) =>
          this.workspace({
            requestVersion: AGENT_SYNC_REQUEST_VERSION,
            operation: "freeze",
            lease,
            requestId
          }) as Promise<Extract<AgentSyncToolResult, { kind: "frozen" }>>,
        inspect: (lease, requestId, path) =>
          this.workspace({
            requestVersion: AGENT_SYNC_REQUEST_VERSION,
            operation: "inspect",
            lease,
            requestId,
            path
          }) as Promise<Extract<AgentSyncToolResult, { kind: "inspected" }>>,
        edit: (lease, requestId, edits) =>
          this.workspace({
            requestVersion: AGENT_SYNC_REQUEST_VERSION,
            operation: "edit",
            lease,
            requestId,
            edits
          }) as Promise<Extract<AgentSyncToolResult, { kind: "edited" }>>,
        seal: (lease, requestId) =>
          this.workspace({
            requestVersion: AGENT_SYNC_REQUEST_VERSION,
            operation: "seal",
            lease,
            requestId
          }) as Promise<Sealed>
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
  save(next: AgentSyncState) {
    this.current = parseAgentSyncState(next);
  }
  private guard(lease: AgentSyncLease) {
    const valid = validateAgentSyncLease(this.current, lease, this.clock());
    if (!valid.valid) throw new Error(`Memory sync lease: ${valid.code}`);
    return this.current.attempts.find((a) => a.attemptId === lease.attemptId)!;
  }
  private files(version: string) {
    const files = this.versions.get(version);
    if (!files) throw new Error("Unknown memory version");
    return files;
  }
  private overlay(lease: AgentSyncLease) {
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
  private snapshot(baseVersion: string, staged: readonly AgentSyncStagedFile[]) {
    const files = { ...this.files(baseVersion) };
    for (const file of staged) files[file.path] = this.blobs.get(file.blobId)!;
    const records = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, text]) => ({ path, contentHash: text === null ? null : sha256(text) }));
    const candidateHash = hashJson({ baseVersion, files: records });
    const version = hashJson({ candidateHash, files }).slice(7, 47);
    this.versions.set(version, freezeSyncValue(files));
    return { version, candidateHash };
  }
  private async workspace(raw: AgentSyncWorkspaceRequest): Promise<AgentSyncToolResult> {
    const request = freezeSyncValue(AgentSyncWorkspaceRequestSchema.parse(raw));
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
      workspaceVersion: AGENT_SYNC_WORKSPACE_VERSION,
      staging: [],
      candidates: [],
      toolReceipts: []
    };
    let result: AgentSyncToolResult;
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
        const transition = bindAgentSyncInput(
          state,
          {
            requestVersion: AGENT_SYNC_REQUEST_VERSION,
            operation: "bind",
            lease: request.lease,
            requestId: `memory-bind-${++this.sequence}`,
            snapshot: { baseVersion, inputHash, contentHashes }
          },
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
        candidateVersion: AGENT_SYNC_CANDIDATE_VERSION,
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
    this.current = parseAgentSyncState({
      ...next,
      revision: state.revision + 1,
      workspace: {
        ...workspace,
        toolReceipts: [
          ...workspace.toolReceipts,
          {
            receiptVersion: AGENT_SYNC_TOOL_RECEIPT_VERSION,
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
    return validateAgentSyncWorkspacePortResult(this.current, request, result);
  }
  private evidence(lease: AgentSyncLease, candidate: Sealed): AgentSyncCheckReceipt {
    const sourceHash = hashJson(
      Object.entries(this.files(candidate.version))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, text]) => ({ path, contentHash: text === null ? null : sha256(text) }))
    );
    return freezeSyncValue({
      checkVersion: AGENT_SYNC_CHECK_VERSION,
      receiptId: `memory-check-${++this.sequence}`,
      attemptId: lease.attemptId,
      baseVersion: candidate.baseVersion,
      version: candidate.version,
      candidateHash: candidate.candidateHash,
      planHash: this.current.plan.planHash,
      configurationHash: this.current.plan.checkConfigurationHash,
      programsHash: H,
      argumentsHash: H,
      groups: agentSyncPublicationChecks(this.current, lease.taskId),
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
  private check(request: AgentSyncVerifierRequest): AgentSyncVerifierResponse {
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
    const result = validateAgentSyncVerifierPortResult(this.current, request, {
      requestId: request.requestId,
      receipt: this.evidence(request.lease, request.candidate)
    });
    this.checks.set(request.requestId, { hash, result });
    return result;
  }
  private finish(lease: AgentSyncLease, requestId: string) {
    const before = this.current;
    const requestHash = agentSyncPublishRequestHash(before, lease, requestId);
    const replay = before.publishReceipts.find((r) => r.requestId === requestId);
    if (replay)
      return validateAgentSyncPublisherPortResult(
        before,
        lease,
        requestId,
        { status: "accepted", receipt: replay },
        before
      );
    if (this.checks.has(requestId) || before.workspace?.toolReceipts.some((r) => r.requestId === requestId))
      throw new Error("Memory request ID conflict");
    const attempt = this.guard(lease);
    if (attempt.inputHash === null) throw new Error("Memory input not frozen");
    for (const [path, hash] of Object.entries(attempt.contentHashes)) {
      const text = this.files(before.acceptedVersion)[path]!;
      if ((text === null ? null : sha256(text)) !== hash) throw new Error("Memory granted input changed");
    }
    const staged = this.overlay(lease);
    const candidate: Sealed = {
      kind: "sealed" as const,
      candidateVersion: AGENT_SYNC_CANDIDATE_VERSION,
      baseVersion: before.acceptedVersion,
      overlayHash: staged.overlayHash,
      ...this.snapshot(before.acceptedVersion, staged.files)
    };
    const check = this.evidence(lease, candidate);
    const receipt = {
      publishVersion: AGENT_SYNC_PUBLISH_VERSION,
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
      configurationHash: check.configurationHash,
      programsHash: check.programsHash,
      argumentsHash: check.argumentsHash,
      ownerEpoch: lease.ownerEpoch,
      leaseEpoch: lease.leaseEpoch,
      inputHash: attempt.inputHash,
      overlayHash: staged.overlayHash,
      toolchainHash: check.toolchainHash,
      isolationHash: check.isolationHash,
      imageDigest: check.imageDigest
    };
    this.current = parseAgentSyncState({
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
    return validateAgentSyncPublisherPortResult(
      before,
      lease,
      requestId,
      { status: "accepted", receipt },
      this.current
    );
  }
}
