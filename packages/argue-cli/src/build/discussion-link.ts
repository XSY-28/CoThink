import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BuildHashSchema,
  BuildIdSchema,
  BuildPathSchema,
  BuildVersionIdSchema,
  FrozenBuildPlanSchema,
  freezeBuildValue,
  hashBuildValue,
  parseBuildState,
  parseDiscussionRun,
  type BuildReadonly,
  type BuildState,
  type DiscussionEngine,
  type DiscussionRun,
  type DiscussionRunEvent,
  type DiscussionSource
} from "@onevcat/argue";
import { FileSnapshotStore, type SnapshotCodec } from "../storage/snapshot-store.js";

export const BUILD_INTEGRATION_VERSION = "build-integration-v1";
/** Canonical JSON SHA-256, shared with the existing core state/plan hash convention. */
export const buildIntegrationHash = hashBuildValue;
const nonempty = z.string().min(1);
const materialRef = z.object({ path: BuildPathSchema, contentHash: BuildHashSchema.nullable() }).strict();
export const BuildIntegrationRequestSchema = z
  .object({
    integrationVersion: z.literal(BUILD_INTEGRATION_VERSION),
    requestId: BuildIdSchema,
    frozenBuildPlan: FrozenBuildPlanSchema,
    materialRefs: z.array(materialRef).min(1),
    origin: z
      .object({
        sessionId: BuildIdSchema,
        segmentId: z.number().int().positive().safe(),
        selectedAnswerVersionIds: z.array(nonempty).min(1),
        finalResultHash: BuildHashSchema
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((request, ctx) => {
    const expected = request.frozenBuildPlan.manifest;
    if (
      request.materialRefs.length !== expected.length ||
      new Set(request.materialRefs.map((ref) => ref.path)).size !== expected.length ||
      expected.some(
        (entry) => !request.materialRefs.some((ref) => ref.path === entry.path && ref.contentHash === entry.contentHash)
      )
    )
      ctx.addIssue({ code: "custom", message: "Material references must exactly match the frozen initial manifest" });
    const ids = request.origin?.selectedAnswerVersionIds;
    if (ids && new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Duplicate selected answer version" });
  });
export type BuildIntegrationRequest = BuildReadonly<z.infer<typeof BuildIntegrationRequestSchema>>;
export function parseBuildIntegrationRequest(raw: unknown): BuildIntegrationRequest {
  return freezeBuildValue(BuildIntegrationRequestSchema.parse(raw));
}
export interface BuildIntegrationApproval {
  /** Supplied by the trusted host/UI, never read from the request JSON. */
  approvedPlanHash: string;
  loadDiscussion?: (sessionId: string) => Promise<DiscussionRun>;
}
export async function validateBuildIntegrationRequest(
  raw: unknown,
  options: BuildIntegrationApproval
): Promise<BuildIntegrationRequest> {
  const request = parseBuildIntegrationRequest(raw);
  if (BuildHashSchema.parse(options.approvedPlanHash) !== request.frozenBuildPlan.planHash)
    throw new Error("Build plan requires explicit host approval of its exact hash");
  if (request.origin) {
    if (!options.loadDiscussion) throw new Error("Persisted discussion source loader is required");
    const origin = request.origin;
    const run = parseDiscussionRun(await options.loadDiscussion(origin.sessionId));
    const segment = run.segments.find((segment) => segment.segmentId === origin.segmentId);
    const result = segment?.finalResult;
    if (
      run.sessionId !== origin.sessionId ||
      segment?.status !== "completed" ||
      !result ||
      result.outcome === "incomplete" ||
      result.sessionId !== origin.sessionId ||
      result.segmentId !== origin.segmentId ||
      hashBuildValue(result) !== origin.finalResultHash ||
      result.selectedAnswerVersionIds.length !== origin.selectedAnswerVersionIds.length ||
      origin.selectedAnswerVersionIds.some(
        (id) =>
          !result.selectedAnswerVersionIds.includes(id) ||
          !segment.protocol.answerVersions.some(
            (answer) => answer.answerVersionId === id && answer.segmentId === origin.segmentId
          )
      )
    ) {
      throw new Error("Discussion origin does not match a completed persisted result and its selected answers");
    }
  }
  return request;
}
export type BuildHostJson =
  | null
  | string
  | number
  | boolean
  | readonly BuildHostJson[]
  | { readonly [key: string]: BuildHostJson };
export type BuildHostContext = { readonly contextVersion: string; readonly [key: string]: BuildHostJson };
function plainHostJson(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || Object.getOwnPropertySymbols(value).length) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  return Object.values(value).every((child) => plainHostJson(child, depth + 1));
}
/** Trusted-host descriptor only. The CLI separately validates its secret-free semantic allowlist. */
export const BuildHostContextSchema = z
  .custom<BuildHostContext>((value) => {
    if (
      !plainHostJson(value) ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("contextVersion" in value) ||
      !BuildIdSchema.safeParse(value.contextVersion).success
    )
      return false;
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 65536;
  }, "Host context must be a bounded versioned plain JSON object")
  .transform((value) => JSON.parse(JSON.stringify(value)) as BuildHostContext);
const BindingSchema = z
  .object({
    requestId: BuildIdSchema,
    requestHash: BuildHashSchema,
    runId: BuildIdSchema,
    planHash: BuildHashSchema,
    workspaceRoot: nonempty,
    sourceRoot: nonempty,
    request: BuildIntegrationRequestSchema,
    hostContext: BuildHostContextSchema.optional(),
    hostContextHash: BuildHashSchema.optional(),
    recoveryRequired: z.boolean(),
    cancelRequested: z.boolean()
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (
      (binding.hostContext === undefined) !== (binding.hostContextHash === undefined) ||
      (binding.hostContext !== undefined && hashBuildValue(binding.hostContext) !== binding.hostContextHash)
    )
      ctx.addIssue({ code: "custom", message: "Host context hash binding mismatch" });
  });
export type BuildIntegrationBinding = BuildReadonly<z.infer<typeof BindingSchema>>;
export type BuildIntegrationReservation = BuildIntegrationBinding & { readonly created: boolean };
const RegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.literal("catalogue"),
    revision: z.number().int().nonnegative().safe(),
    bindings: z.array(BindingSchema)
  })
  .strict();
type Registry = BuildReadonly<z.infer<typeof RegistrySchema>>;
function runIdFor(requestId: string): string {
  return `build-${hashBuildValue(requestId).slice(7, 55)}`;
}
function absent(error: unknown, format: string, id: string): boolean {
  return (
    error instanceof Error &&
    (error.message === `${format} session does not exist: ${id}` || ("code" in error && error.code === "ENOENT"))
  );
}
/** Separate bridge records; no old build/discussion formats or managed control directories change. */
export class BuildDiscussionLink {
  private readonly root: string;
  private readonly store: FileSnapshotStore<Registry>;
  constructor(root: string) {
    this.root = resolve(root);
    const codec: SnapshotCodec<Registry> = {
      formatName: "build bridge",
      sessionId: (s) => s.sessionId,
      revision: (s) => s.revision,
      parse: (raw) => {
        const parsed = RegistrySchema.parse(raw);
        if (
          new Set(parsed.bindings.map((b) => b.requestId)).size !== parsed.bindings.length ||
          new Set(parsed.bindings.map((b) => b.runId)).size !== parsed.bindings.length
        )
          throw new Error("Duplicate build bridge binding");
        for (const b of parsed.bindings)
          if (
            b.requestId !== b.request.requestId ||
            b.requestHash !== hashBuildValue(b.request) ||
            b.planHash !== b.request.frozenBuildPlan.planHash ||
            b.runId !== runIdFor(b.requestId) ||
            b.workspaceRoot !== join(this.root, "workspaces", b.runId) ||
            resolve(b.sourceRoot) !== b.sourceRoot
          )
            throw new Error("Corrupt build bridge identity");
        return parsed;
      },
      validateTransition: (next, old) => {
        if (!old) {
          if (next.bindings.length !== 1) throw new Error("Initial bridge reservation required");
          return;
        }
        for (const previous of old.bindings) {
          const current = next.bindings.find((b) => b.runId === previous.runId);
          if (
            !current ||
            hashBuildValue({ ...current, recoveryRequired: false, cancelRequested: false }) !==
              hashBuildValue({ ...previous, recoveryRequired: false, cancelRequested: false }) ||
            (previous.cancelRequested && !current.cancelRequested)
          )
            throw new Error("Immutable bridge association changed");
        }
        if (next.bindings.length < old.bindings.length || next.bindings.length > old.bindings.length + 1)
          throw new Error("Invalid bridge reservation transition");
      }
    };
    this.store = new FileSnapshotStore(join(this.root, "bridge-records"), codec);
  }
  async reserve(
    raw: unknown,
    options: BuildIntegrationApproval & { sourceRoot: string; hostContext?: unknown }
  ): Promise<BuildIntegrationReservation> {
    // Approval and provenance validation precede even catalogue directory creation.
    const request = await validateBuildIntegrationRequest(raw, options);
    const hostContext =
      options.hostContext === undefined ? undefined : BuildHostContextSchema.parse(options.hostContext);
    const hostContextHash = hostContext === undefined ? undefined : hashBuildValue(hostContext);
    const sourceRoot = await realpath(options.sourceRoot);
    return this.store.withWriter("catalogue", async (writer) => {
      let state: Registry;
      try {
        state = await writer.load("catalogue");
      } catch (error) {
        if (!absent(error, "Build bridge", "catalogue")) throw error;
        state = { schemaVersion: 1, sessionId: "catalogue", revision: -1, bindings: [] };
      }
      const requestHash = hashBuildValue(request),
        previous = state.bindings.find((b) => b.requestId === request.requestId);
      if (previous) {
        if (
          previous.requestHash !== requestHash ||
          previous.sourceRoot !== sourceRoot ||
          (hostContext !== undefined && previous.hostContextHash !== hostContextHash)
        )
          throw new Error("Build integration request ID conflict");
        return freezeBuildValue({ ...structuredClone(previous), created: false });
      }
      const runId = runIdFor(request.requestId);
      const binding = {
        requestId: request.requestId,
        requestHash,
        runId,
        planHash: request.frozenBuildPlan.planHash,
        workspaceRoot: join(this.root, "workspaces", runId),
        sourceRoot,
        request,
        ...(hostContext === undefined ? {} : { hostContext, hostContextHash }),
        recoveryRequired: true,
        cancelRequested: false
      };
      await writer.commit(state.revision, {
        ...state,
        revision: state.revision + 1,
        bindings: [...state.bindings, binding]
      });
      return freezeBuildValue({ ...binding, created: true });
    });
  }
  async get(runId: string): Promise<BuildIntegrationBinding> {
    BuildIdSchema.parse(runId);
    const binding = (await this.store.load("catalogue")).bindings.find((b) => b.runId === runId);
    if (!binding) throw new Error("Unknown build run");
    return freezeBuildValue(binding);
  }
  private async update(
    runId: string,
    patch: { recoveryRequired?: boolean; cancelRequested?: true }
  ): Promise<BuildIntegrationBinding> {
    BuildIdSchema.parse(runId);
    return this.store.withWriter("catalogue", async (writer) => {
      const state = await writer.load("catalogue"),
        old = state.bindings.find((b) => b.runId === runId);
      if (!old) throw new Error("Unknown build run");
      const next = { ...old, ...patch };
      if (hashBuildValue(next) !== hashBuildValue(old))
        await writer.commit(state.revision, {
          ...state,
          revision: state.revision + 1,
          bindings: state.bindings.map((b) => (b === old ? next : b))
        });
      return freezeBuildValue(next);
    });
  }
  async prepareResult(runId: string, record: unknown, trustedState: BuildState): Promise<DiscussionSource> {
    return prepareBuildResultSource(await this.get(runId), record, trustedState);
  }
  markRecoveryRequired(runId: string): Promise<BuildIntegrationBinding> {
    return this.update(runId, { recoveryRequired: true });
  }
  markRecovered(runId: string): Promise<BuildIntegrationBinding> {
    return this.update(runId, { recoveryRequired: false });
  }
  requestCancel(runId: string): Promise<BuildIntegrationBinding> {
    return this.update(runId, { cancelRequested: true });
  }
}

export interface StableDiscussionEvent {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly segmentId: number;
  readonly seq: number;
  readonly type: DiscussionRunEvent["type"];
  readonly refIds: readonly string[];
  readonly data: Readonly<{
    atMs: number;
    phase?: "opening" | "discussion" | "review";
    outcome?: string;
    stopReason?: string;
  }>;
}
/** The global sequence is the persisted array index + 1, including events with no public payload. */
export function projectDiscussionEvents(raw: DiscussionRun): readonly StableDiscussionEvent[] {
  const run = parseDiscussionRun(raw);
  let segmentId = 1;
  return freezeBuildValue(
    run.events.map((event, index) => {
      if (event.type === "continued") segmentId++;
      const data: { atMs: number; phase?: "opening" | "discussion" | "review"; outcome?: string; stopReason?: string } =
        { atMs: event.atMs };
      let refIds: string[] = [];
      switch (event.type) {
        case "prepared":
          refIds = [event.batchId, ...event.jobs.map((job) => job.jobId)];
          data.phase = event.jobs[0]?.phase;
          break;
        case "settled":
          refIds = [event.attemptId];
          data.outcome = event.outcome;
          break;
        case "retry_prepared":
          refIds = Object.values(event.attemptIds);
          break;
        case "reserve_review":
          refIds = [event.reservationId];
          break;
        case "extended":
          refIds = [event.extensionId];
          break;
        case "constraints_checked":
          refIds = event.checks.map((check) => check.checkId);
          break;
        case "finalized": {
          data.stopReason = event.stopReason;
          refIds = [
            ...(run.segments.find((segment) => segment.segmentId === segmentId)?.finalResult
              ?.selectedAnswerVersionIds ?? [])
          ];
          break;
        }
      }
      return {
        schemaVersion: 1 as const,
        sessionId: run.sessionId,
        segmentId,
        seq: index + 1,
        type: event.type,
        refIds,
        data
      };
    })
  );
}
export const discussionEventKey = (event: Pick<StableDiscussionEvent, "sessionId" | "segmentId" | "seq">): string =>
  `${event.sessionId}/${event.segmentId}/${event.seq}`;
/** A wake is not a durable event, build approval, or a request to dispatch. */
export function discussionWakeObserver(
  observer: (wake: { kind: "created" | "saved"; sessionId: string }) => void | Promise<void>
): (run: DiscussionRun, event: DiscussionRunEvent | { type: "created" }) => void {
  return (run, event) => {
    try {
      void Promise.resolve(
        observer({ kind: event.type === "created" ? "created" : "saved", sessionId: run.sessionId })
      ).catch(() => {});
    } catch {
      /* observer isolation */
    }
  };
}
const CursorSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: BuildIdSchema,
    revision: z.number().int().nonnegative().safe(),
    discussionSessionId: BuildIdSchema,
    consumerId: BuildIdSchema,
    seq: z.number().int().nonnegative().safe(),
    segmentId: z.number().int().positive().safe(),
    prefixHash: BuildHashSchema
  })
  .strict();
type Cursor = z.infer<typeof CursorSchema>;
/** Read -> idempotent consumer effect -> ACK. A crash before ACK intentionally replays the same key. */
export class DiscussionEventCursor {
  private readonly snapshots: FileSnapshotStore<Cursor>;
  constructor(
    root: string,
    private readonly consumerId: string
  ) {
    BuildIdSchema.parse(consumerId);
    this.snapshots = new FileSnapshotStore(join(root, "discussion-cursors"), {
      formatName: "discussion cursor",
      parse: (raw) => CursorSchema.parse(raw),
      sessionId: (s) => s.sessionId,
      revision: (s) => s.revision,
      validateTransition: (next, old) => {
        if (
          old &&
          (next.discussionSessionId !== old.discussionSessionId ||
            next.consumerId !== old.consumerId ||
            next.seq !== old.seq + 1)
        )
          throw new Error("Cursor must acknowledge the next durable event");
      }
    });
  }
  private id(sessionId: string): string {
    return `cursor-${hashBuildValue([this.consumerId, sessionId]).slice(7, 55)}`;
  }
  private verify(cursor: Cursor, events: readonly StableDiscussionEvent[], sessionId: string): void {
    if (
      cursor.sessionId !== this.id(sessionId) ||
      cursor.discussionSessionId !== sessionId ||
      cursor.consumerId !== this.consumerId ||
      cursor.seq > events.length ||
      cursor.prefixHash !== hashBuildValue(events.slice(0, cursor.seq)) ||
      (cursor.seq > 0 && cursor.segmentId !== events[cursor.seq - 1]?.segmentId)
    )
      throw new Error("Cursor does not match persisted discussion history");
  }
  async read(run: DiscussionRun): Promise<readonly StableDiscussionEvent[]> {
    const events = projectDiscussionEvents(run);
    let cursor: Cursor;
    try {
      cursor = await this.snapshots.load(this.id(run.sessionId));
    } catch (error) {
      if (absent(error, "Discussion cursor", this.id(run.sessionId))) return events;
      throw error;
    }
    this.verify(cursor, events, run.sessionId);
    return events.slice(cursor.seq);
  }
  async ack(run: DiscussionRun, key: string): Promise<void> {
    const events = projectDiscussionEvents(run),
      index = events.findIndex((event) => discussionEventKey(event) === key);
    if (index < 0) throw new Error("Unknown durable discussion event key");
    const id = this.id(run.sessionId);
    await this.snapshots.withWriter(id, async (writer) => {
      let cursor: Cursor | undefined;
      try {
        cursor = await writer.load(id);
      } catch (error) {
        if (!absent(error, "Discussion cursor", id)) throw error;
      }
      if (cursor) this.verify(cursor, events, run.sessionId);
      if (index < (cursor?.seq ?? 0)) return;
      if (index !== (cursor?.seq ?? 0)) throw new Error("Cursor must acknowledge the next durable event");
      await writer.commit(cursor?.revision ?? -1, {
        schemaVersion: 1,
        sessionId: id,
        revision: (cursor?.revision ?? -1) + 1,
        discussionSessionId: run.sessionId,
        consumerId: this.consumerId,
        seq: index + 1,
        segmentId: events[index]!.segmentId,
        prefixHash: hashBuildValue(events.slice(0, index + 1))
      });
    });
  }
}

const candidateRef = z
  .object({ attemptId: BuildIdSchema, version: BuildVersionIdSchema, candidateHash: BuildHashSchema })
  .strict();
export const BuildIntegrationResultSchema = z
  .object({
    resultVersion: z.literal("build-integration-result-v1"),
    integrationVersion: z.literal(BUILD_INTEGRATION_VERSION),
    requestId: BuildIdSchema,
    runId: BuildIdSchema,
    planHash: BuildHashSchema,
    acceptedVersion: BuildVersionIdSchema,
    status: z.literal("completed"),
    candidateRefs: z.array(candidateRef).min(1),
    checkReceiptIds: z.array(BuildIdSchema).min(1),
    publishReceiptIds: z.array(BuildIdSchema).min(1)
  })
  .strict();
export type BuildIntegrationResult = BuildReadonly<z.infer<typeof BuildIntegrationResultSchema>>;
/** The state argument must come from the trusted host's authoritative store/recovery, never from a submitted result. */
export function createBuildIntegrationResult(
  binding: BuildIntegrationBinding & { readonly created?: boolean },
  input: BuildState
): BuildIntegrationResult {
  const { created: _created, ...durableBinding } = binding;
  void _created;
  const parsedBinding = BindingSchema.parse(durableBinding),
    state = parseBuildState(input);
  if (
    parsedBinding.requestId !== parsedBinding.request.requestId ||
    parsedBinding.requestHash !== hashBuildValue(parsedBinding.request) ||
    parsedBinding.planHash !== parsedBinding.request.frozenBuildPlan.planHash ||
    state.runId !== parsedBinding.runId ||
    state.plan.planHash !== parsedBinding.planHash ||
    hashBuildValue(state.plan) !== hashBuildValue(parsedBinding.request.frozenBuildPlan)
  )
    throw new Error("Build result is for a different integration request/run/plan");
  if (
    state.status !== "completed" ||
    state.acceptedTasks.length !== state.plan.tasks.length ||
    state.plan.tasks.some((task) => !state.acceptedTasks.includes(task.taskId))
  )
    throw new Error("Build integration return requires a completed run with every frozen task formally accepted");
  const publications = state.publishReceipts;
  if (!publications.length || publications.at(-1)!.acceptedVersion !== state.acceptedVersion)
    throw new Error("Build result requires the current formally accepted version");
  for (const [index, publish] of publications.entries()) {
    const check = state.checkReceipts.find((check) => check.receiptId === publish.checkReceiptId);
    const attempt = state.attempts.find((attempt) => attempt.attemptId === publish.attemptId);
    if (
      !check?.passed ||
      check.exitCode !== 0 ||
      !publish.requestHash ||
      publish.planHash !== state.plan.planHash ||
      check.planHash !== state.plan.planHash ||
      check.version !== publish.acceptedVersion ||
      check.candidateHash !== publish.candidateHash ||
      check.checksHash !== publish.checksHash ||
      !attempt ||
      attempt.status !== "completed" ||
      !state.acceptedTasks.includes(attempt.taskId) ||
      (index > 0 && publish.baseVersion !== publications[index - 1]!.acceptedVersion)
    )
      throw new Error("Build result lacks linked accepted candidate/check/publication evidence");
  }
  if (
    state.acceptedTasks.length !== publications.length ||
    state.acceptedTasks.some(
      (taskId) =>
        !publications.some(
          (publish) => state.attempts.find((attempt) => attempt.attemptId === publish.attemptId)?.taskId === taskId
        )
    )
  )
    throw new Error("Accepted tasks and publication evidence differ");
  return freezeBuildValue(
    BuildIntegrationResultSchema.parse({
      resultVersion: "build-integration-result-v1",
      integrationVersion: BUILD_INTEGRATION_VERSION,
      requestId: parsedBinding.requestId,
      runId: state.runId,
      planHash: state.plan.planHash,
      acceptedVersion: state.acceptedVersion,
      status: "completed",
      candidateRefs: publications.map((publish) => ({
        attemptId: publish.attemptId,
        version: publish.acceptedVersion,
        candidateHash: publish.candidateHash
      })),
      checkReceiptIds: publications.map((publish) => publish.checkReceiptId),
      publishReceiptIds: publications.map((publish) => publish.receiptId)
    })
  );
}
/** Prepare inert versioned material only. A passing build check never becomes a discussion check or consensus vote. */
export function prepareBuildResultSource(
  binding: BuildIntegrationBinding,
  raw: unknown,
  state: BuildState
): DiscussionSource {
  const record = BuildIntegrationResultSchema.parse(raw),
    expected = createBuildIntegrationResult(binding, state);
  if (hashBuildValue(record) !== hashBuildValue(expected))
    throw new Error("Build integration return is stale, incomplete or does not match authoritative evidence");
  const content = JSON.stringify(expected, null, 2);
  return freezeBuildValue({
    sourceId: `build:${expected.runId}:${expected.acceptedVersion}`,
    name: "Accepted construction result",
    content,
    contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    lineCount: content.split("\n").length
  });
}
/** Explicit host action; this is the only bridge helper that can dispatch discussion models. */
export async function continueBuildResult(
  engine: DiscussionEngine,
  sessionId: string,
  source: DiscussionSource,
  approval: { authorized: boolean }
): Promise<DiscussionRun> {
  BuildIdSchema.parse(sessionId);
  if (approval.authorized !== true) throw new Error("Explicit new-segment authorization is required");
  if (
    source.contentHash !== `sha256:${createHash("sha256").update(source.content).digest("hex")}` ||
    source.lineCount !== source.content.split("\n").length
  )
    throw new Error("Prepared result source integrity mismatch");
  const record = BuildIntegrationResultSchema.parse(JSON.parse(source.content));
  if (source.sourceId !== `build:${record.runId}:${record.acceptedVersion}`)
    throw new Error("Prepared result source identity mismatch");
  return engine.continue(sessionId, {
    sources: [
      {
        sourceId: source.sourceId,
        ...(source.name === undefined ? {} : { name: source.name }),
        content: source.content
      }
    ]
  });
}
