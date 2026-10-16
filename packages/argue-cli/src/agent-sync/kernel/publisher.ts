import { freeze } from "./backend-types.js";
import { hashJson } from "@onevcat/argue/agent-sync/project";
import type { ManagedWriter } from "./storage-types.js";
import type {
  BackendProject,
  BackendState,
  BackendLease,
  BackendProtocol,
  CheckReceipt,
  PublishReceipt,
  ToolResult
} from "./backend-types.js";
import type { Verifier, VerificationCandidate, VerificationDefinition } from "./verification-types.js";
import { hashVerificationSource } from "./verification-types.js";
import { exportManagedVersion, type ExportOptions } from "./recovery.js";
export interface PublisherOptions<W> {
  clock?: () => number;
  /** Host-only deterministic fault boundaries; never part of model actions. */
  afterCandidate?: () => Promise<void>;
  afterCheck?: () => Promise<void>;
  beforeCAS?: () => Promise<void>;
  afterCAS?: () => Promise<void>;
  exportVersion?: (
    writer: W,
    input: { version?: string; target: string },
    options?: ExportOptions
  ) => Promise<{ status: "exported"; version: string; directory: string }>;
}
export type PublicationResult<R> = {
  readonly status: "accepted";
  readonly receipt: R;
  readonly export:
    | { readonly status: "not_requested" | "not_retried" }
    | { readonly status: "exported"; readonly version: string; readonly directory: string }
    | { readonly status: "failed"; readonly error: string };
};
const queues = new WeakMap<object, Promise<void>>();
function serial<T>(writer: object, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(writer) ?? Promise.resolve()).then(action);
  queues.set(
    writer,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}
export function ownOverlay<
  P extends BackendProject,
  L extends BackendLease,
  C extends CheckReceipt<string>,
  R extends PublishReceipt,
  T extends ToolResult
>(state: BackendState<P, L, C, R, T>, lease: L) {
  const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId)!;
  const staged = state.workspace?.staging.find((s) => s.attemptId === lease.attemptId);
  if (
    staged &&
    hashJson({ attemptId: staged.attemptId, baseVersion: staged.baseVersion, files: staged.files }) !==
      staged.overlayHash
  )
    throw new Error("Build publication overlay hash mismatch");
  return (
    staged ?? {
      attemptId: lease.attemptId,
      baseVersion: attempt.baseVersion,
      files: [],
      overlayHash: hashJson({ attemptId: lease.attemptId, baseVersion: attempt.baseVersion, files: [] })
    }
  );
}
/** Checks run outside the writer transaction; acceptance patches only freshly loaded metadata. */
export class ManagedPublisher<
  P extends BackendProject,
  L extends BackendLease,
  C extends CheckReceipt<G>,
  R extends PublishReceipt,
  T extends ToolResult,
  S extends BackendState<P, L, C, R, T>,
  G extends string,
  D extends VerificationDefinition<G> = VerificationDefinition<G>
> {
  private readonly clock: () => number;
  constructor(
    private readonly writer: ManagedWriter<P, S>,
    private readonly protocol: BackendProtocol<P, L, C, R, T, S, G>,
    private readonly verifier: Verifier<G, C, D>,
    private readonly options: PublisherOptions<ManagedWriter<P, S>> = {}
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

  private assertLease(state: S, lease: L, now: number) {
    const valid = this.protocol.validateLease(state, lease, now);
    if (!valid.valid) throw new Error(`Build publication lease rejected: ${valid.code}`);
    if (state.attempts.find((a) => a.attemptId === lease.attemptId)!.inputHash === null)
      throw new Error("Build publication input is not frozen");
  }

  async finish(
    rawLease: L,
    rawRequestId: string,
    rawOptions: { exportTarget?: string } = {}
  ): Promise<PublicationResult<R>> {
    const lease = freeze(this.protocol.parseLease(rawLease));
    const requestId = this.protocol.parseId(rawRequestId);
    if (
      Object.keys(rawOptions).some((k) => k !== "exportTarget") ||
      (rawOptions.exportTarget !== undefined && typeof rawOptions.exportTarget !== "string")
    )
      return Promise.reject(new Error("Build publication options rejected"));
    const exportTarget = rawOptions.exportTarget;
    return serial(this.writer, async () => {
      const current = await this.writer.load();
      const requestHash = this.protocol.publishHash(current, lease, requestId, exportTarget);
      const replay = current.publishReceipts.find((r) => r.requestId === requestId);
      if (replay) {
        if (replay.requestHash !== requestHash || replay.attemptId !== lease.attemptId)
          throw new Error("Build publication request ID conflict");
        return freeze({
          status: "accepted",
          receipt: replay,
          export: { status: exportTarget ? "not_retried" : "not_requested" }
        });
      }
      if (
        current.coordination.requests.some((r) => r.requestId === requestId) ||
        current.workspace?.toolReceipts.some((r) => r.requestId === requestId) ||
        this.protocol.extraRequestIds(current).includes(requestId)
      )
        throw new Error("Build publication request ID conflict");
      const prepared = await this.writer.transaction(async (state) => {
        this.assertLease(state, lease, this.clock());
        const attempt = state.attempts.find((a) => a.attemptId === lease.attemptId)!;
        const view = await this.writer.git.readFiles(state.acceptedVersion);
        for (const [path, hash] of Object.entries(attempt.contentHashes))
          if (view[path]!.contentHash !== hash) throw new Error("Build publication granted input changed");
        const overlay = ownOverlay(state, lease);
        const snapshot = await this.writer.git.createSnapshot(state.acceptedVersion, overlay.files);
        const source = await this.writer.git.readFiles(snapshot.version);
        const sourceHash = hashVerificationSource(source);
        const candidate: VerificationCandidate = freeze({
          attemptId: lease.attemptId,
          baseVersion: state.acceptedVersion,
          version: snapshot.version,
          candidateHash: snapshot.candidateHash,
          planHash: state.plan.planHash
        });
        return {
          value: {
            candidate,
            sourceHash,
            inputHash: attempt.inputHash!,
            overlayHash: overlay.overlayHash,
            groups: this.protocol.groups(state, lease.taskId)
          }
        };
      });
      await this.options.afterCandidate?.();
      const definition = freeze(await this.verifier.describe(prepared.groups));
      if (hashJson(definition.groups) !== hashJson(prepared.groups)) throw new Error("Build check groups changed");
      const output = await this.verifier.check(prepared.candidate, definition);
      if (!this.verifier.ownsReceipt(output)) throw new Error("Build check receipt is not program produced");
      const check = freeze(this.protocol.parseCheck(output));
      if (
        this.protocol.evidenceKeys.some((key) => check[key] !== definition[key]) ||
        (this.protocol.configurationHash(current) !== undefined &&
          definition.configurationHash !== this.protocol.configurationHash(current)) ||
        !check.passed ||
        check.attemptId !== lease.attemptId ||
        check.baseVersion !== prepared.candidate.baseVersion ||
        check.version !== prepared.candidate.version ||
        check.planHash !== prepared.candidate.planHash ||
        check.candidateHash !== prepared.candidate.candidateHash ||
        check.checksHash !== definition.checksHash ||
        check.toolchainHash !== definition.toolchainHash ||
        check.isolationHash !== definition.isolationHash ||
        check.imageDigest !== definition.imageDigest ||
        hashJson(check.groups) !== hashJson(prepared.groups) ||
        check.sourceHashBefore !== prepared.sourceHash ||
        check.sourceHashAfter !== prepared.sourceHash
      )
        throw new Error("Build isolated check evidence rejected");
      await this.options.afterCheck?.();
      const latestDefinition = freeze(await this.verifier.describe(prepared.groups));
      if (hashJson(latestDefinition) !== hashJson(definition)) throw new Error("Build check basis changed");
      await this.options.beforeCAS?.();
      const receipt = await this.writer.transaction(async (latest) => {
        const guard = (s: S) => {
          this.assertLease(s, lease, this.clock());
          if (
            s.acceptedVersion !== prepared.candidate.baseVersion ||
            s.plan.planHash !== prepared.candidate.planHash ||
            ownOverlay(s, lease).overlayHash !== prepared.overlayHash ||
            hashJson(this.protocol.groups(s, lease.taskId)) !== hashJson(prepared.groups)
          )
            throw new Error("Build publication baseline or overlay changed");
          if (
            s.publishReceipts.some((r) => r.requestId === requestId) ||
            s.coordination.requests.some((r) => r.requestId === requestId) ||
            s.workspace?.toolReceipts.some((r) => r.requestId === requestId) ||
            this.protocol.extraRequestIds(s).includes(requestId)
          )
            throw new Error("Build publication request ID conflict");
        };
        guard(latest);
        const latestView = await this.writer.git.readFiles(latest.acceptedVersion);
        const attempt = latest.attempts.find((a) => a.attemptId === lease.attemptId)!;
        for (const [path, hash] of Object.entries(attempt.contentHashes))
          if (latestView[path]!.contentHash !== hash) throw new Error("Build publication granted input changed");
        if (hashVerificationSource(await this.writer.git.readFiles(prepared.candidate.version)) !== prepared.sourceHash)
          throw new Error("Build isolated check source changed");
        if (latest.checkReceipts.some((r) => r.receiptId === check.receiptId))
          throw new Error("Build check receipt ID conflict");
        const publication = freeze(
          this.protocol.parsePublish({
            ...Object.fromEntries(this.protocol.evidenceKeys.map((key) => [key, check[key]])),
            publishVersion: this.protocol.publishVersion,
            receiptId: `publish-${requestHash.slice(7, 47)}`,
            attemptId: lease.attemptId,
            requestId,
            checkReceiptId: check.receiptId,
            baseVersion: prepared.candidate.baseVersion,
            acceptedVersion: prepared.candidate.version,
            candidateHash: check.candidateHash,
            checksHash: check.checksHash,
            requestHash,
            planHash: prepared.candidate.planHash,
            ownerEpoch: lease.ownerEpoch,
            leaseEpoch: lease.leaseEpoch,
            inputHash: prepared.inputHash,
            overlayHash: prepared.overlayHash,
            toolchainHash: check.toolchainHash,
            isolationHash: check.isolationHash,
            imageDigest: check.imageDigest
          })
        );
        const next = this.protocol.parseState({
          ...latest,
          revision: latest.revision + 1,
          acceptedVersion: prepared.candidate.version,
          acceptedTasks: [...latest.acceptedTasks, lease.taskId],
          attempts: latest.attempts.map((a) => (a.attemptId === lease.attemptId ? { ...a, status: "completed" } : a)),
          checkReceipts: [...latest.checkReceipts, check],
          publishReceipts: [...latest.publishReceipts, publication],
          coordination: {
            ...latest.coordination,
            lastNow: this.clock(),
            taskStates: { ...latest.coordination.taskStates, [lease.taskId]: "completed" },
            taskEpochs: { ...latest.coordination.taskEpochs, [lease.taskId]: lease.leaseEpoch + 1 },
            locks: latest.coordination.locks.filter((l) => l.attemptId !== lease.attemptId),
            requests: latest.coordination.requests.map((r) =>
              r.attemptId === lease.attemptId && r.status === "pending" ? { ...r, status: "invalidated" } : r
            )
          }
        });
        return {
          state: next,
          value: publication,
          beforeCommit: async (s) => {
            guard(s);
            if (s.revision !== latest.revision) throw new Error("Build publication CAS conflict");
            await this.writer.assertOwner();
            const finalDefinition = await this.verifier.describe(prepared.groups);
            if (hashJson(finalDefinition) !== hashJson(definition))
              throw new Error("Build check basis changed before CAS");
            this.assertLease(s, lease, this.clock());
          }
        };
      });
      await this.options.afterCAS?.();
      let exported: PublicationResult<R>["export"] = { status: "not_requested" };
      if (exportTarget)
        try {
          exported = await (
            this.options.exportVersion ??
            ((writer, input) => exportManagedVersion(writer, input, {}, this.protocol.allowLegacyChecks))
          )(this.writer, {
            version: receipt.acceptedVersion,
            target: exportTarget
          });
        } catch (error) {
          exported = { status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      return freeze({ status: "accepted", receipt, export: exported });
    });
  }
}
