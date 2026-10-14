import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, lstat, rename, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import {
  DiscussionEngine,
  FinalResultSchema,
  JsonDiscussionCodec,
  PeerSessionDriver,
  createDiscussionRun,
  currentDiscussionSegment,
  normalizeDiscussionPolicy,
  buildDiscussionMemberRequest,
  OPENING_OUTPUT_TOKENS,
  type DiscussionRun,
  type DiscussionRunInput,
  type FinalResult,
  type ModelCall,
  type ModelTransport,
  type MemberRuntime,
  type PeerSession,
  type DiscussionPolicy,
  type PeerMemberConfig
} from "@onevcat/argue";
import { loadDiscussionConfig, type DiscussionConfigPolicy } from "./config.js";
import { FileDiscussionStore } from "./file-store.js";
import { renderFinalResult } from "./render.js";
import { FilePeerStore } from "../peer/file-store.js";
import { createPeerApiRuntime } from "../runtime/peer-api.js";
import { createApiModelTransport, validateModelCall } from "../runtime/model-api.js";
import { DEFAULT_PEER_CONFIG, DEFAULT_PEER_ENV, readPeerEnvironment } from "../peer/local-config.js";
import { loadStoredSessionIdentity } from "../storage/session-routing.js";

type Io = Pick<Console, "log" | "error">;
export interface DiscussionCommandDependencies {
  env?: Record<string, string | undefined>;
  transport?: ModelTransport;
  legacyRuntime?: MemberRuntime;
  now?: () => number;
}
export class DiscussionCommandError extends Error {}
type Options = { positionals: string[]; values: Map<string, string[]>; flags: Set<string> };
const policyFlags = [
  "effort",
  "max-rounds",
  "participation-weight",
  "decision-weight",
  "max-calls",
  "max-allocated-output-tokens",
  "max-duration-ms",
  "call-timeout-ms"
];
const common = ["root", "env-file", "json"];
const allowed: Record<string, string[]> = {
  start: [
    ...common,
    ...policyFlags,
    "config",
    "question",
    "question-file",
    "constraint",
    "context",
    "session-id",
    "rounds"
  ],
  show: common,
  retry: [...common, "extra-calls", "extra-output-tokens", "extend-seconds"],
  continue: [...common, ...policyFlags, "config", "note", "context", "rounds"],
  export: [...common, "format", "output"],
  view: [...common, "output", "no-open"]
};
const repeated = new Set(["constraint", "context", "participation-weight", "decision-weight"]);
function parse(command: string, args: string[]): Options {
  if (!allowed[command]) throw new DiscussionCommandError("Use start, show, retry, continue, export or view.");
  const result: Options = { positionals: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      result.positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!allowed[command]!.includes(key)) throw new DiscussionCommandError("Unknown option. Use cothink --help.");
    if (result.flags.has(key) || (!repeated.has(key) && result.values.has(key)))
      throw new DiscussionCommandError("Duplicate option.");
    if (["json", "no-open"].includes(key)) {
      result.flags.add(key);
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new DiscussionCommandError(`Missing value for --${key}.`);
    result.values.set(key, [...(result.values.get(key) ?? []), value]);
  }
  if (result.positionals.length !== (command === "start" ? 0 : 1))
    throw new DiscussionCommandError(
      command === "start" ? "start takes --session-id, not a positional ID." : `${command} requires one session ID.`
    );
  if (command !== "start" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.positionals[0]!))
    throw new DiscussionCommandError("Invalid session ID.");
  const effort = result.values.get("effort")?.[0];
  if (effort !== undefined && !["low", "standard", "high"].includes(effort))
    throw new DiscussionCommandError("Effort must be low, standard or high.");
  weightOverrides(result);
  if (result.values.has("max-rounds") && result.values.has("rounds"))
    throw new DiscussionCommandError("Choose --max-rounds; do not combine it with --rounds.");
  for (const key of [
    "max-rounds",
    "rounds",
    "max-calls",
    "max-allocated-output-tokens",
    "max-duration-ms",
    "call-timeout-ms",
    "extra-calls",
    "extra-output-tokens",
    "extend-seconds"
  ]) {
    const raw = result.values.get(key)?.[0];
    if (raw !== undefined) positive(raw, `--${key}`);
  }
  const seconds = result.values.get("extend-seconds")?.[0];
  if (seconds !== undefined && !Number.isSafeInteger(Number(seconds) * 1000))
    throw new DiscussionCommandError("Deadline extension is too large.");
  return result;
}
const get = (options: Options, key: string) => options.values.get(key)?.[0];
const list = (options: Options, key: string) => options.values.get(key) ?? [];
function positive(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new DiscussionCommandError(`${name} must be a positive integer.`);
  return number;
}
function optionalNumber(options: Options, key: string): number | undefined {
  const raw = get(options, key);
  return raw === undefined ? undefined : positive(raw, `--${key}`);
}
function weightOverrides(
  options: Options,
  memberIds?: readonly string[]
): Record<string, { participationWeight?: number; decisionWeight?: number }> {
  const result: Record<string, { participationWeight?: number; decisionWeight?: number }> = {};
  for (const [flag, field] of [
    ["participation-weight", "participationWeight"],
    ["decision-weight", "decisionWeight"]
  ] as const) {
    const seen = new Set<string>();
    for (const value of list(options, flag)) {
      const match = /^([^=]+)=([^=]+)$/.exec(value);
      if (!match || (memberIds !== undefined && !memberIds.includes(match[1]!)) || seen.has(match[1]!))
        throw new DiscussionCommandError(`--${flag} requires each known member once as member=value.`);
      const weight = Number(match[2]);
      if (!Number.isFinite(weight) || weight < 0.1 || weight > 100)
        throw new DiscussionCommandError("Weights must be finite and between 0.1 and 100.");
      result[match[1]!] = { ...result[match[1]!], [field]: weight };
      seen.add(match[1]!);
    }
  }
  return result;
}
function policy(
  base: DiscussionConfigPolicy | DiscussionPolicy,
  options: Options,
  memberIds: readonly string[]
): DiscussionPolicy {
  const weights = Object.fromEntries(memberIds.map((id) => [id, { ...base.weights?.[id] }]));
  for (const [id, override] of Object.entries(weightOverrides(options, memberIds)))
    weights[id] = { ...weights[id], ...override };
  const effort = get(options, "effort") ?? base.effort;
  const overrides = {
    ...base,
    effort,
    weights,
    ...(get(options, "max-rounds") !== undefined
      ? { maxRounds: optionalNumber(options, "max-rounds") }
      : get(options, "rounds") !== undefined
        ? { maxRounds: optionalNumber(options, "rounds") }
        : {}),
    ...Object.fromEntries(
      [
        ["max-calls", "maxCalls"],
        ["max-allocated-output-tokens", "maxAllocatedOutputTokens"],
        ["max-duration-ms", "maxDurationMs"],
        ["call-timeout-ms", "callTimeoutMs"]
      ].flatMap(([flag, key]) => (get(options, flag!) === undefined ? [] : [[key, optionalNumber(options, flag!)]]))
    )
  };
  try {
    return normalizeDiscussionPolicy(overrides, memberIds);
  } catch {
    throw new DiscussionCommandError("Invalid discussion effort, weights or limits.");
  }
}
function continuationBase(saved: DiscussionPolicy, options: Options): DiscussionConfigPolicy | DiscussionPolicy {
  return get(options, "effort") === undefined
    ? saved
    : {
        effort: saved.effort,
        weights: saved.weights,
        ...(saved.maxRounds === undefined ? {} : { maxRounds: saved.maxRounds })
      };
}
async function copiedSources(
  paths: string[],
  segmentId: number
): Promise<Array<{ sourceId: string; name: string; content: string }>> {
  return Promise.all(
    paths.map(async (path, index) => {
      if (![".md", ".txt"].includes(extname(path).toLowerCase()))
        throw new DiscussionCommandError("Context files must use .md or .txt.");
      try {
        return {
          sourceId: `segment-${segmentId}:source-${index + 1}`,
          name: path.split(/[\\/]/).at(-1)!,
          content: await readFile(path, "utf8")
        };
      } catch {
        throw new DiscussionCommandError("Cannot read context file.");
      }
    })
  );
}
async function credentials(
  options: Options,
  dependencies: DiscussionCommandDependencies
): Promise<Record<string, string | undefined>> {
  const path = resolve(get(options, "env-file") ?? DEFAULT_PEER_ENV),
    base = dependencies.env ?? process.env;
  if (get(options, "env-file") === undefined) {
    try {
      await access(path);
    } catch {
      return { ...base };
    }
  }
  try {
    return await readPeerEnvironment(path, base);
  } catch {
    throw new DiscussionCommandError("Cannot read credential file.");
  }
}
function preflight(calls: readonly ModelCall[], env: Record<string, string | undefined>): void {
  for (const call of calls) {
    if (!env[call.apiKeyEnv]?.trim())
      throw new DiscussionCommandError(
        "Missing member credentials. Configure both members' key environment variables."
      );
    try {
      validateModelCall(call);
    } catch {
      throw new DiscussionCommandError("Invalid provider settings or output quota.");
    }
  }
}
function openingCalls(run: DiscussionRun): ModelCall[] {
  const segment = currentDiscussionSegment(run);
  return segment.protocol.memberIds.map((id) => {
    const config = segment.members[id]!;
    const request = buildDiscussionMemberRequest(
      segment.protocol,
      id,
      OPENING_OUTPUT_TOKENS,
      new JsonDiscussionCodec()
    );
    if (
      request.messages.reduce((size, message) => size + message.content.length, 0) >
      (config.maxInputCharacters ?? 100000)
    )
      throw new DiscussionCommandError("Input exceeds a member's configured character limit.");
    return {
      protocol: config.protocol,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      apiKeyEnv: config.apiKeyEnv,
      outputMode: config.outputMode,
      generationOptions: config.generationOptions,
      maxOutputTokens: request.maxOutputTokens,
      messages: request.messages
    };
  });
}
/** Only a final result crosses into rendering. Pause messages and raw diagnostics stay internal. */
export function discussionCommandResult(run: DiscussionRun): FinalResult {
  const segment = currentDiscussionSegment(run);
  if (segment.finalResult) return segment.finalResult;
  const code = segment.pauseReason?.code;
  const reason =
    code === "constraint_failed"
      ? "constraint_failed"
      : segment.protocol.phase === "review"
        ? "incomplete_review"
        : "abnormal_stop";
  const instructions =
    code === "deadline"
      ? "The deadline was reached. Retry with an explicit --extend-seconds value, or continue in a new segment."
      : code === "budget_exhausted"
        ? "The budget cannot fund a complete batch. Retry with explicit extra capacity, or continue in a new segment."
        : code === "constraint_failed"
          ? "A saved host constraint check failed. Continue with corrected material in a new segment."
          : run.status === "active"
            ? "An interrupted session needs recovery. The first retry saves a pause with zero model calls; retry again to resume."
            : "Run retry to resume only missing members, or continue with new material and policy.";
  return FinalResultSchema.parse({
    resultVersion: "discussion.result.v1",
    sessionId: run.sessionId,
    segmentId: segment.segmentId,
    outcome: "incomplete",
    answer: "",
    selectedAnswerVersionIds: [],
    importantDissent: [],
    limitations: [instructions],
    incompleteReason: reason
  });
}
function legacyResult(state: PeerSession): FinalResult {
  return FinalResultSchema.parse({
    resultVersion: "discussion.result.v1",
    sessionId: state.config.sessionId,
    segmentId: state.currentSegmentId,
    outcome: "incomplete",
    answer: "",
    selectedAnswerVersionIds: [],
    importantDissent: [],
    limitations: [
      `Legacy peer format: ${state.status}. There is no saved discussion FinalResult; consensus cannot be inferred.`,
      state.status === "completed"
        ? "Continue the legacy session, or start a new discussion session."
        : "Retry to recover the legacy session. Interrupted active sessions first recover without model calls."
    ],
    incompleteReason: "incomplete_review"
  });
}
function emit(result: FinalResult, options: Options, io: Io): { ok: boolean; code: number } {
  io.log(renderFinalResult(result, options.flags.has("json") ? "json" : "txt"));
  const code = result.outcome === "incomplete" ? 2 : 0;
  return { ok: code === 0, code };
}
async function artifact(result: FinalResult, command: string, options: Options, root: string, io: Io): Promise<void> {
  const format = command === "view" ? "html" : get(options, "format");
  if (!format || !["txt", "md", "json", "html"].includes(format))
    throw new DiscussionCommandError("--format must be txt, md, json or html.");
  const output = resolve(get(options, "output") ?? join(root, result.sessionId, `final.${format}`));
  if (
    ["session.json", ".writer.lock", ".recovery.lock"].includes(output.split(/[\\/]/).at(-1)!) ||
    [resolve(DEFAULT_PEER_CONFIG), resolve(get(options, "env-file") ?? DEFAULT_PEER_ENV)].includes(output)
  )
    throw new DiscussionCommandError("Output cannot replace a session, lock, configuration or credential file.");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(output);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw new DiscussionCommandError("Output must be a single regular file, not a link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Replace the path atomically, never truncate another file through an alias.
  const temporary = join(dirname(output), `.final-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    try {
      await file.writeFile(renderFinalResult(result, format as "txt" | "md" | "json" | "html"));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  io.error(`Saved final result: ${output}`);
  if (command === "view" && !options.flags.has("no-open")) {
    const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const child = spawn(executable, process.platform === "win32" ? ["/c", "start", "", output] : [output], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => {});
    child.unref();
  }
}
function withoutId(members: Record<string, PeerMemberConfig>): DiscussionRunInput["members"] {
  return Object.fromEntries(
    Object.entries(members).map(([id, member]) => {
      const { id: _, ...config } = member;
      void _;
      return [id, config];
    })
  );
}
async function withSignal<T>(io: Io, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(),
    interrupt = () => {
      io.error("Interrupted; saving a recoverable pause.");
      controller.abort();
    };
  process.on("SIGINT", interrupt);
  try {
    return await action(controller.signal);
  } finally {
    process.off("SIGINT", interrupt);
  }
}
export async function runDiscussionCommand(
  args: string[],
  io: Io,
  dependencies: DiscussionCommandDependencies = {}
): Promise<{ ok: boolean; code: number }> {
  const [command = "", ...rest] = args;
  try {
    const options = parse(command, rest),
      root = resolve(get(options, "root") ?? ".cothink/sessions"),
      now = dependencies.now ?? Date.now;
    const store = new FileDiscussionStore(root);
    if (command === "start") {
      if (Number(get(options, "question") !== undefined) + Number(get(options, "question-file") !== undefined) !== 1)
        throw new DiscussionCommandError("Choose exactly one of --question or --question-file.");
      let question = get(options, "question");
      if (question === undefined) {
        try {
          question = await readFile(resolve(get(options, "question-file")!), "utf8");
        } catch {
          throw new DiscussionCommandError("Cannot read question file.");
        }
      }
      if (!question.trim()) throw new DiscussionCommandError("Question must not be empty.");
      const sessionId = get(options, "session-id") ?? randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new DiscussionCommandError("Invalid session ID.");
      const env = await credentials(options, dependencies);
      let config;
      try {
        config = await loadDiscussionConfig(resolve(get(options, "config") ?? DEFAULT_PEER_CONFIG), env);
      } catch {
        throw new DiscussionCommandError("Invalid configuration or configuration version.");
      }
      const input: DiscussionRunInput = {
        sessionId,
        question: question.trim(),
        members: withoutId(config.members),
        policy: policy(config.discussion, options, Object.keys(config.members)),
        constraints: list(options, "constraint"),
        sources: await copiedSources(list(options, "context"), 1)
      };
      let draft;
      try {
        draft = createDiscussionRun(input, now());
        preflight(openingCalls(draft), env);
      } catch (error) {
        if (error instanceof DiscussionCommandError) throw error;
        throw new DiscussionCommandError("Invalid question, context or discussion limits.");
      }
      const transport =
        dependencies.transport ??
        createApiModelTransport(
          env,
          Object.values(input.members).map((member) => member.apiKeyEnv)
        );
      const ended = await store.withWriter(sessionId, (writer) =>
        withSignal(io, (signal) => new DiscussionEngine(writer, transport, { now }).start(input, signal))
      );
      return emit(discussionCommandResult(ended), options, io);
    }
    const id = options.positionals[0]!;
    let identity;
    try {
      identity = await loadStoredSessionIdentity(root, id);
    } catch {
      throw new DiscussionCommandError("Invalid session snapshot, version or format; no model call was made.");
    }
    let result: FinalResult;
    if (identity.kind === "discussion") {
      let initial;
      try {
        initial = await store.load(id);
      } catch {
        throw new DiscussionCommandError("Invalid discussion runtime snapshot or version; no model call was made.");
      }
      if (command === "continue") {
        const segment = currentDiscussionSegment(initial);
        weightOverrides(options, segment.protocol.memberIds);
        if (initial.status === "active") {
          // Recovery does not authorize ignoring an invalid submitted policy.
          let base = continuationBase(segment.protocol.policy, options);
          if (get(options, "config") !== undefined) {
            const env = await credentials(options, dependencies);
            try {
              base = (await loadDiscussionConfig(resolve(get(options, "config")!), env)).discussion;
            } catch {
              throw new DiscussionCommandError("Invalid configuration or configuration version.");
            }
          }
          policy(base, options, segment.protocol.memberIds);
        }
      }
      if (["show", "view", "export"].includes(command)) result = discussionCommandResult(initial);
      else {
        const ended = await store.withWriter(id, async (writer) => {
          const current = await writer.load(id);
          const idleTransport: ModelTransport = {
            respond: async () => {
              throw new Error("Recovery cannot dispatch");
            }
          };
          if (current.status === "active") return new DiscussionEngine(writer, idleTransport, { now }).recover(id);
          if (command === "retry" && current.status === "completed") return current;
          const env = await credentials(options, dependencies),
            segment = currentDiscussionSegment(current);
          if (command === "retry") {
            const jobs =
              segment.currentBatch?.jobIds
                .filter((jobId) => !segment.seals.some((seal) => seal.jobId === jobId))
                .map((jobId) => segment.jobs.find((job) => job.jobId === jobId)!.call) ??
              Object.values(segment.members).map((member) => ({
                protocol: member.protocol,
                modelId: member.modelId,
                baseUrl: member.baseUrl,
                apiKeyEnv: member.apiKeyEnv,
                outputMode: member.outputMode,
                generationOptions: member.generationOptions,
                maxOutputTokens: OPENING_OUTPUT_TOKENS,
                messages: []
              }));
            preflight(jobs, env);
            return withSignal(io, (signal) =>
              new DiscussionEngine(
                writer,
                dependencies.transport ??
                  createApiModelTransport(
                    env,
                    Object.values(segment.members).map((member) => member.apiKeyEnv)
                  ),
                { now }
              ).retry(id, {
                signal,
                ...(get(options, "extra-calls") === undefined
                  ? {}
                  : { extraCalls: optionalNumber(options, "extra-calls") }),
                ...(get(options, "extra-output-tokens") === undefined
                  ? {}
                  : { extraAllocatedOutputTokens: optionalNumber(options, "extra-output-tokens") }),
                ...(get(options, "extend-seconds") === undefined
                  ? {}
                  : { extendMs: optionalNumber(options, "extend-seconds")! * 1000 })
              })
            );
          }
          let members = segment.members,
            base: DiscussionConfigPolicy | DiscussionPolicy = continuationBase(segment.protocol.policy, options);
          if (get(options, "config") !== undefined) {
            let config;
            try {
              config = await loadDiscussionConfig(resolve(get(options, "config")!), env);
            } catch {
              throw new DiscussionCommandError("Invalid configuration or configuration version.");
            }
            members = withoutId(config.members);
            base = config.discussion;
          }
          const additions = await copiedSources(list(options, "context"), current.currentSegmentId + 1);
          const input = {
            sessionId: id,
            question: segment.protocol.question,
            members,
            policy: policy(base, options, Object.keys(members)),
            constraints: segment.protocol.constraints,
            sources: [
              ...segment.protocol.sources,
              ...additions,
              ...(get(options, "note") === undefined
                ? []
                : [{ sourceId: `segment-${current.currentSegmentId + 1}:note`, content: get(options, "note")! }])
            ]
          };
          let draft;
          try {
            draft = createDiscussionRun(input, now());
            preflight(openingCalls(draft), env);
          } catch (error) {
            if (error instanceof DiscussionCommandError) throw error;
            throw new DiscussionCommandError("Invalid new segment material or policy.");
          }
          return withSignal(io, (signal) =>
            new DiscussionEngine(
              writer,
              dependencies.transport ??
                createApiModelTransport(
                  env,
                  Object.values(members).map((member) => member.apiKeyEnv)
                ),
              { now }
            ).continue(id, {
              members,
              policy: input.policy,
              sources: additions,
              ...(get(options, "note") === undefined ? {} : { note: get(options, "note") }),
              signal
            })
          );
        });
        result = discussionCommandResult(ended);
      }
    } else {
      const legacy = new FilePeerStore(root);
      const initial = await legacy.load(id);
      if (["show", "view", "export"].includes(command) || (command === "retry" && initial.status === "completed"))
        result = legacyResult(initial);
      else {
        if (policyFlags.some((flag) => get(options, flag) !== undefined) || get(options, "config") !== undefined)
          throw new DiscussionCommandError(
            "Legacy sessions retain their policy. Start a new discussion to set new weights or effort."
          );
        const ended = await legacy.withWriter(id, async (writer) => {
          const current = await writer.load(id),
            empty: MemberRuntime = {
              respond: async () => {
                throw new Error("Recovery cannot dispatch");
              }
            };
          const nowDate = () => new Date(now());
          if (current.status === "active")
            return new PeerSessionDriver(writer, { "member-a": empty, "member-b": empty }, { now: nowDate }).recover(
              id
            );
          const env = await credentials(options, dependencies);
          for (const member of Object.values(current.config.members)) {
            if (!env[member.apiKeyEnv]?.trim()) throw new DiscussionCommandError("Missing member credentials.");
          }
          preflight(
            Object.values(current.config.members).map((member) => ({
              protocol: member.protocol,
              baseUrl: member.baseUrl,
              modelId: member.modelId,
              apiKeyEnv: member.apiKeyEnv,
              outputMode: member.outputMode,
              generationOptions: member.generationOptions,
              maxOutputTokens: current.config.limits.maxOutputTokens,
              messages: []
            })),
            env
          );
          const runtime =
            dependencies.legacyRuntime ??
            createPeerApiRuntime(
              env,
              Object.values(current.config.members).map((member) => member.apiKeyEnv)
            );
          const driver = new PeerSessionDriver(writer, { "member-a": runtime, "member-b": runtime }, { now: nowDate });
          const additions = (await copiedSources(list(options, "context"), current.currentSegmentId + 1)).map(
            (source) => ({ ...source, segmentId: current.currentSegmentId + 1 })
          );
          return withSignal(io, (signal) =>
            command === "retry"
              ? driver.retry(id, {
                  signal,
                  extraCalls: optionalNumber(options, "extra-calls"),
                  extendSeconds: optionalNumber(options, "extend-seconds")
                })
              : driver.continue(id, {
                  signal,
                  note: get(options, "note"),
                  sources: additions,
                  rounds: optionalNumber(options, "rounds")
                })
          );
        });
        result = legacyResult(ended);
      }
    }
    if (command === "view" || command === "export") await artifact(result, command, options, root, io);
    return emit(result, options, io);
  } catch (error) {
    io.error(
      error instanceof DiscussionCommandError
        ? error.message
        : "Cannot complete this command. Check local files/configuration and use show to inspect the saved result; internal diagnostics remain private."
    );
    return { ok: false, code: 1 };
  }
}
