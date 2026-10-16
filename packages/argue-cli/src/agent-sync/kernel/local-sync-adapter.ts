import { hashJson } from "@onevcat/argue/agent-sync/project";
import { freeze } from "./backend-types.js";
import type { ManagedWriter } from "./storage-types.js";
import type {
  BackendProject,
  BackendLease,
  BackendState,
  BackendProtocol,
  CheckReceipt,
  PublishReceipt,
  ToolResult,
  VerifierRequest,
  WorkspaceRequest
} from "./backend-types.js";
import { ManagedWorkspace } from "./workspace.js";
import { ManagedPublisher, ownOverlay } from "./publisher.js";
import { hashVerificationSource, type Verifier, type VerificationDefinition } from "./verification-types.js";
export interface LocalAdapterOptions<L, R> {
  clock?: () => number;
  publisher?: {
    finish(
      lease: L,
      id: string
    ): Promise<{ readonly status: "accepted"; readonly receipt: R; readonly export?: unknown }>;
  };
}
/** The local trusted backend composes existing disk/Git workspaces and the real
 * publisher. A standalone check is an observation, never a publication shortcut. */
export class ManagedLocalAdapter<
  P extends BackendProject,
  L extends BackendLease,
  C extends CheckReceipt<G>,
  R extends PublishReceipt,
  T extends ToolResult,
  S extends BackendState<P, L, C, R, T>,
  G extends string,
  D extends VerificationDefinition<G> = VerificationDefinition<G>
> {
  readonly ports;
  private readonly checks = new Map<
    string,
    { hash: string; result: Promise<{ readonly requestId: string; readonly receipt: C }>; basis?: D }
  >();
  // Session-only claims precede every await. Durable receipts remain the replay authority.
  private readonly requests = new Map<string, { hash: string; retained: boolean; inflight?: Promise<unknown> }>();
  private readonly clock: () => number;
  constructor(
    private readonly writer: ManagedWriter<P, S>,
    private readonly protocol: BackendProtocol<P, L, C, R, T, S, G>,
    private readonly verifier: Verifier<G, C, D>,
    options: LocalAdapterOptions<L, R> = {}
  ) {
    this.protocol = freeze({
      ...protocol,
      evidenceKeys: [...protocol.evidenceKeys],
      toolMetadata: { ...protocol.toolMetadata },
      candidateMetadata: { ...protocol.candidateMetadata }
    });
    this.clock = options.clock ?? Date.now;
    const publisher = options.publisher ?? new ManagedPublisher(writer, protocol, verifier, { clock: this.clock });
    const workspace = new ManagedWorkspace(writer, protocol, { clock: this.clock });
    const workspaceRequest = async (raw: WorkspaceRequest<L>) => {
      const request = freeze(this.protocol.workspace(raw));
      return this.claimRequest<T>(request.requestId, { operation: "workspace", request }, () => {
        switch (request.operation) {
          case "freeze":
            return workspace.freezeInput(request.lease, request.requestId);
          case "inspect":
            return workspace.inspect(request.lease, request.requestId, request.path);
          case "edit":
            return workspace.edit(request.lease, request.requestId, request.edits);
          case "seal":
            return workspace.seal(request.lease, request.requestId);
        }
      });
    };
    this.ports = {
      workspace: {
        freezeInput: (lease: L, id: string) =>
          workspaceRequest({ operation: "freeze", lease, requestId: id }) as Promise<Extract<T, { kind: "frozen" }>>,
        inspect: (lease: L, id: string, path: string) =>
          workspaceRequest({ operation: "inspect", lease, requestId: id, path }) as Promise<
            Extract<T, { kind: "inspected" }>
          >,
        edit: (
          lease: L,
          id: string,
          edits: readonly { path: string; text: string; expectedContentHash: string | null }[]
        ) =>
          workspaceRequest({ operation: "edit", lease, requestId: id, edits }) as Promise<
            Extract<T, { kind: "edited" }>
          >,
        seal: (lease: L, id: string) =>
          workspaceRequest({ operation: "seal", lease, requestId: id }) as Promise<Extract<T, { kind: "sealed" }>>
      },
      verifier: {
        check: async (raw: VerifierRequest<L, T>) => {
          const request = freeze(this.protocol.verifierRequest(raw));
          return this.claimRequest(request.requestId, { operation: "check", request }, () => this.check(request));
        }
      },
      publisher: {
        finish: async (rawLease: L, rawRequestId: string) => {
          const lease = freeze(this.protocol.parseLease(rawLease));
          const requestId = this.protocol.parseId(rawRequestId);
          return this.claimRequest(requestId, { operation: "publish", lease, requestId }, async () => {
            const before = await writer.load();
            const response = await publisher.finish(lease, requestId);
            return this.protocol.validatePublisher(before, lease, requestId, response, await writer.load());
          });
        }
      }
    };
  }
  private claimRequest<V>(requestId: string, identity: unknown, action: () => Promise<V>): Promise<V> {
    const hash = hashJson({ projectKey: this.writer.projectKey, identity });
    const previous = this.requests.get(requestId);
    if (previous && previous.hash !== hash) throw new Error("Build sync request ID conflict");
    const claim = previous ?? { hash, retained: false, inflight: undefined };
    // The same strictly parsed identity binds the operation and its result type.
    if (claim.inflight) return claim.inflight as Promise<V>;
    const result = Promise.resolve()
      .then(action)
      .then((value) => {
        // A failed check result is still a successful observation, unlike an execution exception.
        claim.retained = true;
        return value;
      })
      .finally(() => {
        if (this.requests.get(requestId) !== claim || claim.inflight !== result) return;
        claim.inflight = undefined;
        if (!claim.retained) this.requests.delete(requestId);
      });
    // Install before action can run, including before any writer load or trusted callback.
    claim.inflight = result;
    this.requests.set(requestId, claim);
    return result;
  }
  private assertCandidate(state: S, request: VerifierRequest<L, T>): void {
    const lease = this.protocol.validateLease(state, request.lease, this.clock());
    if (!lease.valid) throw new Error(`Build sync lease rejected: ${lease.code}`);
    const attempt = state.attempts.find((a) => a.attemptId === request.lease.attemptId)!;
    const overlayHash = ownOverlay(state, request.lease).overlayHash;
    if (
      attempt.inputHash === null ||
      request.candidate.baseVersion !== attempt.baseVersion ||
      request.candidate.baseVersion !== state.acceptedVersion ||
      request.candidate.overlayHash !== overlayHash ||
      !state.workspace?.candidates.some(
        (c) => hashJson(c) === hashJson({ attemptId: attempt.attemptId, ...request.candidate, kind: undefined })
      )
    )
      throw new Error("Build sync candidate is stale, unknown or unbound");
  }
  private async check(raw: VerifierRequest<L, T>): Promise<{ readonly requestId: string; readonly receipt: C }> {
    const request = freeze(this.protocol.verifierRequest(raw));
    const initial = await this.writer.load();
    const hash = hashJson({
      projectKey: initial.projectKey,
      runId: initial.runId,
      planHash: initial.plan.planHash,
      request
    });
    const cached = this.checks.get(request.requestId);
    if (cached) {
      if (cached.hash !== hash) throw new Error("Build sync request ID conflict");
      if (this.protocol.configurationHash(initial) !== undefined) {
        this.assertCandidate(initial, request);
        const response = await cached.result;
        const current = await this.verifier.describe(this.protocol.groups(initial, request.lease.taskId));
        if (!cached.basis || hashJson(current) !== hashJson(cached.basis))
          throw new Error("Build sync check basis changed");
        await this.writer.assertOwner();
        this.assertCandidate(await this.writer.load(), request);
        return response;
      }
      return cached.result;
    }
    if (
      initial.coordination.requests.some((r) => r.requestId === request.requestId) ||
      initial.workspace?.toolReceipts.some((r) => r.requestId === request.requestId) ||
      this.protocol.extraRequestIds(initial).includes(request.requestId) ||
      initial.publishReceipts.some((r) => r.requestId === request.requestId)
    )
      throw new Error("Build sync request ID conflict");
    this.assertCandidate(initial, request);
    const result = this.runCheck(initial, request);
    this.checks.set(request.requestId, { hash, result });
    try {
      return await result;
    } catch (error) {
      this.checks.delete(request.requestId);
      throw error;
    }
  }
  private async runCheck(
    initial: S,
    request: VerifierRequest<L, T>
  ): Promise<{ readonly requestId: string; readonly receipt: C }> {
    const groups = this.protocol.groups(initial, request.lease.taskId);
    const definition = freeze(await this.verifier.describe(groups));
    if (hashJson(definition.groups) !== hashJson(groups)) throw new Error("Build sync check groups changed");
    const cache = this.checks.get(request.requestId);
    if (cache) cache.basis = definition;
    const sourceHash = hashVerificationSource(await this.writer.git.readFiles(request.candidate.version));
    const candidate = {
      attemptId: request.lease.attemptId,
      baseVersion: request.candidate.baseVersion,
      version: request.candidate.version,
      candidateHash: request.candidate.candidateHash,
      planHash: initial.plan.planHash
    };
    const output = await this.verifier.check(candidate, definition);
    if (!this.verifier.ownsReceipt(output)) throw new Error("Build sync receipt is not program produced");
    const receipt = this.protocol.parseCheck(output);
    if (
      this.protocol.evidenceKeys.some((key) => receipt[key] !== definition[key]) ||
      (this.protocol.configurationHash(initial) !== undefined &&
        definition.configurationHash !== this.protocol.configurationHash(initial)) ||
      receipt.checksHash !== definition.checksHash ||
      receipt.toolchainHash !== definition.toolchainHash ||
      receipt.isolationHash !== definition.isolationHash ||
      receipt.imageDigest !== definition.imageDigest ||
      receipt.sourceHashBefore !== sourceHash ||
      receipt.sourceHashAfter !== sourceHash ||
      hashVerificationSource(await this.writer.git.readFiles(request.candidate.version)) !== sourceHash
    )
      throw new Error("Build sync isolated check evidence rejected");
    if (hashJson(await this.verifier.describe(groups)) !== hashJson(definition))
      throw new Error("Build sync check basis changed");
    await this.writer.assertOwner();
    const latest = await this.writer.load();
    this.assertCandidate(latest, request);
    if (
      latest.coordination.requests.some((r) => r.requestId === request.requestId) ||
      latest.workspace?.toolReceipts.some((r) => r.requestId === request.requestId) ||
      this.protocol.extraRequestIds(latest).includes(request.requestId) ||
      latest.publishReceipts.some((r) => r.requestId === request.requestId)
    )
      throw new Error("Build sync request ID conflict");
    if (latest.plan.planHash !== initial.plan.planHash) throw new Error("Build sync plan changed during check");
    return this.protocol.validateVerifier(latest, request, { requestId: request.requestId, receipt });
  }
}
