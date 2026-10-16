import { freeze } from "./backend-types.js";
import { createHash } from "node:crypto";
import { hashJson } from "@onevcat/argue/agent-sync/project";
import type { ManagedWriter, StoredFile } from "./storage-types.js";
import type {
  BackendProject,
  BackendState,
  BackendLease,
  BackendProtocol,
  CheckReceipt,
  PublishReceipt,
  ToolResult,
  WorkspaceRequest
} from "./backend-types.js";
export interface WorkspaceOptions {
  clock?: () => number;
  /** Deterministic fault boundaries for disk tests, not model-controlled hooks. */
  beforeBlobWrite?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
}
type Result<K extends ToolResult["kind"]> = Extract<ToolResult, { kind: K }>;
const sha = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const sortFiles = (files: readonly StoredFile[]) =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
function overlay(attemptId: string, baseVersion: string, files: readonly StoredFile[]) {
  const sorted = sortFiles(files);
  return {
    attemptId,
    baseVersion,
    files: sorted,
    overlayHash: hashJson({ attemptId, baseVersion, files: sorted })
  };
}
function assertText(text: string): void {
  if (
    text.includes("\0") ||
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(text, "utf8")) !== text
  )
    throw new Error("Build edit must be UTF-8 text");
}

/** The worker never receives a checkout: all reads select immutable versions or its own persisted overlay. */
export class ManagedWorkspace<
  P extends BackendProject,
  L extends BackendLease,
  C extends CheckReceipt<G>,
  R extends PublishReceipt,
  T extends ToolResult,
  S extends BackendState<P, L, C, R, T>,
  G extends string
> {
  private readonly clock: () => number;
  constructor(
    private readonly writer: ManagedWriter<P, S>,
    private readonly protocol: BackendProtocol<P, L, C, R, T, S, G>,
    private readonly options: WorkspaceOptions = {}
  ) {
    this.options = Object.freeze({ ...options });
    this.protocol = freeze({
      ...protocol,
      evidenceKeys: [...protocol.evidenceKeys],
      toolMetadata: { ...protocol.toolMetadata },
      candidateMetadata: { ...protocol.candidateMetadata }
    });
    this.clock = options.clock ?? Date.now;
  }
  private assertLease(state: S, lease: L, now: number): void {
    const valid = this.protocol.validateLease(state, lease, now);
    if (!valid.valid) throw new Error(`Build workspace lease rejected: ${valid.code}`);
  }
  private async run(
    raw: WorkspaceRequest<L>,
    prepare: (
      state: S,
      request: WorkspaceRequest<L>
    ) => Promise<{ result: ToolResult; apply?: (state: S, now: number) => S }>
  ): Promise<ToolResult> {
    // Parse/copy before awaiting the transaction; callers cannot change the payload during I/O.
    const request = freeze(this.protocol.workspace(raw));
    return this.writer.transaction(async (current) => {
      const requestHash = hashJson({
        projectKey: current.projectKey,
        runId: current.runId,
        planHash: current.plan.planHash,
        request
      });
      const previous = current.workspace?.toolReceipts.find((r) => r.requestId === request.requestId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Error("Build workspace request ID conflict");
        return { value: previous.result }; // Historical success query, no execution or metadata commit.
      }
      if (
        current.coordination.requests.some((r) => r.requestId === request.requestId) ||
        current.publishReceipts.some((r) => r.requestId === request.requestId) ||
        this.protocol.extraRequestIds(current).includes(request.requestId)
      )
        throw new Error("Build workspace request ID conflict");
      this.assertLease(current, request.lease, this.clock());
      const attempt = current.attempts.find((a) => a.attemptId === request.lease.attemptId)!;
      if (request.operation !== "freeze" && attempt.inputHash === null) throw new Error("Build input is not frozen");
      this.protocol.validateResources(current, request);
      const prepared = await prepare(current, request);
      prepared.result = this.protocol.tool(prepared.result);
      await this.options.beforeCommit?.();
      await this.writer.assertOwner();
      const now = this.clock();
      this.assertLease(current, request.lease, now);
      let next = this.protocol.expire(current, now);
      if (prepared.apply) next = prepared.apply(next, now);
      const workspace = next.workspace ?? {
        workspaceVersion: this.protocol.workspaceVersion,
        staging: [],
        candidates: [],
        toolReceipts: []
      };
      const receipt = {
        ...this.protocol.toolMetadata,
        requestId: request.requestId,
        attemptId: request.lease.attemptId,
        operation: request.operation,
        requestHash,
        request,
        outputHash: hashJson(prepared.result),
        result: prepared.result
      };
      next = this.protocol.parseState({
        ...next,
        revision: current.revision + 1,
        workspace: { ...workspace, toolReceipts: [...workspace.toolReceipts, receipt] }
      });
      return {
        state: next,
        value: freeze(prepared.result),
        beforeCommit: (latest: S) => {
          if (latest.revision !== current.revision) throw new Error("Build workspace revision conflict");
          this.assertLease(latest, request.lease, this.clock());
        }
      };
    });
  }
  async freezeInput(lease: L, requestId: string): Promise<Extract<T, { kind: "frozen" }>> {
    return this.run({ operation: "freeze", lease, requestId }, async (state, request) => {
      const attempt = state.attempts.find((a) => a.attemptId === request.lease.attemptId)!;
      if (attempt.inputHash !== null)
        return {
          result: {
            kind: "frozen",
            baseVersion: attempt.baseVersion,
            inputHash: attempt.inputHash,
            contentHashes: attempt.contentHashes
          }
        };
      const task = state.plan.tasks.find((t) => t.taskId === attempt.taskId)!;
      // Full-scope grant was verified before reading a version view. No queued material is reused.
      const view = await this.writer.git.readFiles(attempt.baseVersion);
      const contentHashes = Object.fromEntries(
        [...task.scope.read, ...task.scope.write].map((path) => [path, view[path]!.contentHash])
      );
      const inputHash = hashJson({
        planHash: state.plan.planHash,
        attemptId: attempt.attemptId,
        baseVersion: attempt.baseVersion,
        contentHashes
      });
      const result: Result<"frozen"> = { kind: "frozen", baseVersion: attempt.baseVersion, inputHash, contentHashes };
      const bindingId = `input-${hashJson(request).slice(7, 47)}`;
      return {
        result,
        apply: (s, now) => {
          const bound = this.protocol.bind(
            s,
            request.lease,
            bindingId,
            { baseVersion: attempt.baseVersion, inputHash, contentHashes },
            now
          );
          if (bound.result.kind !== "bound") throw new Error(`Build input binding rejected: ${bound.result.kind}`);
          return bound.state;
        }
      };
    }) as Promise<Extract<T, { kind: "frozen" }>>;
  }
  async inspect(lease: L, requestId: string, path: string): Promise<Extract<T, { kind: "inspected" }>> {
    return this.run({ operation: "inspect", lease, requestId, path }, async (state, request) => {
      if (request.operation !== "inspect") throw new Error("Invalid inspect request");
      const attempt = state.attempts.find((a) => a.attemptId === request.lease.attemptId)!;
      const task = state.plan.tasks.find((t) => t.taskId === attempt.taskId)!;
      if (![...task.scope.read, ...task.scope.write].includes(request.path))
        throw new Error("Build inspect is outside exact scope");
      const staged = state.workspace?.staging
        .find((x) => x.attemptId === attempt.attemptId)
        ?.files.find((x) => x.path === request.path);
      const file = staged
        ? { text: await this.writer.git.readBlob(staged.blobId), contentHash: staged.contentHash }
        : await this.writer.git.readFile(attempt.baseVersion, request.path);
      if (file.text !== null && sha(file.text) !== file.contentHash)
        throw new Error("Build inspected object hash mismatch");
      return {
        result: {
          kind: "inspected",
          baseVersion: attempt.baseVersion,
          path: request.path,
          text: file.text,
          contentHash: file.contentHash
        }
      };
    }) as Promise<Extract<T, { kind: "inspected" }>>;
  }
  async edit(
    lease: L,
    requestId: string,
    edits: readonly { path: string; text: string; expectedContentHash: string | null }[]
  ): Promise<Extract<T, { kind: "edited" }>> {
    return this.run({ operation: "edit", lease, requestId, edits }, async (state, request) => {
      if (request.operation !== "edit") throw new Error("Invalid edit request");
      const attempt = state.attempts.find((a) => a.attemptId === request.lease.attemptId)!;
      const task = state.plan.tasks.find((t) => t.taskId === attempt.taskId)!;
      if (
        new Set(request.edits.map((x) => x.path)).size !== request.edits.length ||
        request.edits.some((x) => !task.scope.write.includes(x.path))
      )
        throw new Error("Build edit is outside exact write scope or duplicated");
      for (const edit of request.edits) assertText(edit.text);
      const before =
        state.workspace?.staging.find((x) => x.attemptId === attempt.attemptId) ??
        overlay(attempt.attemptId, attempt.baseVersion, []);
      const view = await this.writer.git.readFiles(attempt.baseVersion);
      // Check the entire batch before any write; a later conflict cannot expose an earlier file.
      for (const edit of request.edits) {
        const old = before.files.find((x) => x.path === edit.path)?.contentHash ?? view[edit.path]!.contentHash;
        if (edit.expectedContentHash !== old) throw new Error("Build expected content hash mismatch");
      }
      const files = new Map(before.files.map((x) => [x.path, x]));
      for (const edit of request.edits) {
        await this.options.beforeBlobWrite?.();
        const blob = await this.writer.git.writeBlob(edit.text);
        files.set(edit.path, { path: edit.path, ...blob });
      }
      const staged = overlay(attempt.attemptId, attempt.baseVersion, [...files.values()]);
      const result: Result<"edited"> = {
        kind: "edited",
        baseVersion: attempt.baseVersion,
        overlayHash: staged.overlayHash,
        files: staged.files
      };
      return {
        result,
        apply: (s) => {
          const w = s.workspace ?? {
            workspaceVersion: this.protocol.workspaceVersion,
            staging: [],
            candidates: [],
            toolReceipts: []
          };
          const exists = w.staging.some((x) => x.attemptId === attempt.attemptId);
          return this.protocol.parseState({
            ...s,
            workspace: {
              ...w,
              staging: exists
                ? w.staging.map((x) => (x.attemptId === attempt.attemptId ? staged : x))
                : [...w.staging, staged]
            }
          });
        }
      };
    }) as Promise<Extract<T, { kind: "edited" }>>;
  }
  async seal(lease: L, requestId: string): Promise<Extract<T, { kind: "sealed" }>> {
    return this.run({ operation: "seal", lease, requestId }, async (state, request) => {
      const attempt = state.attempts.find((a) => a.attemptId === request.lease.attemptId)!;
      const staged =
        state.workspace?.staging.find((x) => x.attemptId === attempt.attemptId) ??
        overlay(attempt.attemptId, attempt.baseVersion, []);
      const candidate = await this.writer.git.createSnapshot(attempt.baseVersion, staged.files);
      const record = {
        ...this.protocol.candidateMetadata,
        attemptId: attempt.attemptId,
        baseVersion: attempt.baseVersion,
        overlayHash: staged.overlayHash,
        ...candidate
      };
      return {
        result: { kind: "sealed", baseVersion: attempt.baseVersion, overlayHash: staged.overlayHash, ...candidate },
        apply: (s) => {
          const w = s.workspace ?? {
            workspaceVersion: this.protocol.workspaceVersion,
            staging: [],
            candidates: [],
            toolReceipts: []
          };
          const prior = w.candidates.find((c) => c.attemptId === record.attemptId && c.version === record.version);
          if (prior && hashJson(prior) !== hashJson(record)) throw new Error("Build immutable candidate conflict");
          return this.protocol.parseState({
            ...s,
            workspace: { ...w, candidates: prior ? w.candidates : [...w.candidates, record] }
          });
        }
      };
    }) as Promise<Extract<T, { kind: "sealed" }>>;
  }
}
