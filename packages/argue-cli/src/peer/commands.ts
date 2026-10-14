import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  buildPeerReport,
  createPeerSession,
  buildMemberRequest,
  PeerSessionDriver,
  type ContextSourceInput,
  type PeerSession,
  type PeerStore
} from "@onevcat/argue";
import { loadPeerMembers } from "./config.js";
import { FilePeerStore } from "./file-store.js";
import { renderPeerHtml, renderPeerMarkdown, usageCoverage } from "./render.js";
import { createPeerApiRuntime, validatePeerApiRequest } from "../runtime/peer-api.js";

type Io = Pick<typeof console, "log" | "error">;
type Result = { ok: boolean; code: number };
type Options = { positionals: string[]; values: Map<string, string[]>; flags: Set<string> };
const validOptions: Record<string, string[]> = {
  start: [
    "root",
    "config",
    "question",
    "goal",
    "constraint",
    "context",
    "session-id",
    "rounds",
    "max-calls",
    "max-output-tokens"
  ],
  show: ["root"],
  retry: ["root", "extra-calls", "extend-seconds"],
  continue: ["root", "note", "context", "rounds"],
  export: ["root", "format", "output"],
  view: ["root", "output", "no-open"]
};

function parse(subcommand: string, args: string[]): Options {
  const allowed = validOptions[subcommand];
  if (!allowed) throw new Error("Use peer start|show|retry|continue|export|view");
  const options: Options = { positionals: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      options.positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!allowed.includes(key)) throw new Error(`Unknown peer option: ${token}`);
    if (key === "no-open") {
      options.flags.add(key);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options.values.set(key, [...(options.values.get(key) ?? []), value]);
  }
  if (options.positionals.length !== (subcommand === "start" ? 0 : 1))
    throw new Error(
      subcommand === "start" ? "start takes no session id; use --session-id" : `${subcommand} requires one session id`
    );
  return options;
}
const get = (options: Options, key: string) => options.values.get(key)?.at(-1);
const list = (options: Options, key: string) => options.values.get(key) ?? [];
function positive(value: string | undefined, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}
function nonnegative(value: string | undefined, name: string): number {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a nonnegative integer`);
  return n;
}
async function sources(paths: string[], segmentId: number): Promise<ContextSourceInput[]> {
  return Promise.all(
    paths.map(async (path, index) => {
      if (![".md", ".txt"].includes(extname(path).toLowerCase()))
        throw new Error(`Context must be .md or .txt: ${path}`);
      return {
        sourceId: `segment-${segmentId}:source-${index + 1}`,
        name: path.split(/[\\/]/).at(-1),
        content: await readFile(path, "utf8"),
        segmentId
      };
    })
  );
}
function observer(io: Io, initial: PeerSession) {
  let previous = initial;
  return (next: PeerSession) => {
    if (next.currentSegmentId !== previous.currentSegmentId) {
      const segment = next.segments.find((item) => item.segmentId === next.currentSegmentId);
      if (segment)
        io.log(
          `Segment ${segment.segmentId} started: rounds ${segment.minDiscussionRounds}..${segment.maxDiscussionRounds}, calls ${segment.maxCalls}, output tokens/call ${next.config.limits.maxOutputTokens}, deadline ${segment.deadline}`
        );
    }
    for (const job of next.jobs) {
      if (job.status === "sealed" && previous.jobs.find((x) => x.jobId === job.jobId)?.status !== "sealed")
        io.log(`${job.memberId} returned; waiting for peer. Sealed reply is not public yet.`);
    }
    for (const round of next.rounds.slice(previous.rounds.length)) {
      io.log(`Committed segment ${round.segmentId} ${round.phase} ${round.roundIndex}:`);
      for (const reply of round.replies) io.log(`  ${reply.memberId}: ${JSON.stringify(reply.payload)}`);
    }
    previous = next;
  };
}
async function drive(
  io: Io,
  initial: PeerSession,
  store: PeerStore,
  mode: "run" | "recover" | "retry" | "continue",
  options: Options,
  env: Record<string, string | undefined> = process.env
): Promise<PeerSession> {
  const controller = new AbortController();
  const onInterrupt = () => {
    io.error("Interrupt requested; saving pause and draining in-flight calls…");
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  try {
    const runtime = createPeerApiRuntime(
      env,
      Object.values(initial.config.members).map((member) => member.apiKeyEnv)
    );
    const driver = new PeerSessionDriver(
      store,
      { "member-a": runtime, "member-b": runtime },
      { onCommitted: observer(io, initial) }
    );
    if (mode === "run") return await driver.run(initial.config.sessionId, controller.signal);
    if (mode === "recover") return await driver.recover(initial.config.sessionId);
    if (mode === "retry")
      return await driver.retry(initial.config.sessionId, {
        extraCalls: nonnegative(get(options, "extra-calls"), "--extra-calls"),
        extendSeconds: nonnegative(get(options, "extend-seconds"), "--extend-seconds"),
        signal: controller.signal
      });
    const newSegmentId = initial.currentSegmentId + 1;
    return await driver.continue(initial.config.sessionId, {
      ...(get(options, "note") ? { note: get(options, "note") } : {}),
      sources: await sources(list(options, "context"), newSegmentId),
      rounds: positive(get(options, "rounds"), "--rounds", 1),
      signal: controller.signal
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

function printState(state: PeerSession, io: Io) {
  const result = buildPeerReport(state);
  io.log(
    `Peer session ${state.config.sessionId}: ${state.status}, segment ${state.currentSegmentId}, review ${result.reviewStatus}`
  );
  io.log(`Question: ${state.config.question}`);
  io.log(`Rounds committed: ${state.rounds.length}; attempts: ${state.attempts.length}; ${usageCoverage(result)}`);
  if (state.pauseReason) io.log(`Pause: ${state.pauseReason.code} — ${state.pauseReason.message}`);
  for (const memberId of ["member-a", "member-b"] as const) {
    const latest = result.conclusions.find((x) => x.memberId === memberId);
    io.log(`${memberId}: ${latest?.conclusion ?? "No committed conclusion"}`);
  }
  for (const claim of result.claims) io.log(`${claim.label}: ${claim.version.versionId} ${claim.version.statement}`);
  if (result.unrespondedMessages.length)
    io.log(`Unresponded messages: ${result.unrespondedMessages.map((x) => x.messageId).join(", ")}`);
  const uncommitted = state.attempts.filter(
    (attempt) =>
      !(
        attempt.status === "valid" &&
        attempt.acceptance === "accepted" &&
        state.rounds.some((round) => round.replies.some((reply) => reply.jobId === attempt.jobId))
      )
  );
  for (const attempt of uncommitted)
    io.log(`Uncommitted diagnostic: ${attempt.memberId} ${attempt.status} ${attempt.error?.code ?? ""}`);
}
function defaultRoot(options: Options): string {
  return resolve(get(options, "root") ?? ".argue-peer");
}
/** Share the legacy argument grammar with the CoThink format gate. */
export function peerSessionTarget(args: string[]): { root: string; sessionId: string } | undefined {
  const [command = "", ...rest] = args;
  const options = parse(command, rest);
  return command === "start" ? undefined : { root: defaultRoot(options), sessionId: options.positionals[0]! };
}
function openLocal(path: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function runPeerCommand(
  args: string[],
  io: Io,
  dependencies: { env?: Record<string, string | undefined> } = {}
): Promise<Result> {
  const [subcommand = "", ...rest] = args;
  try {
    const options = parse(subcommand, rest);
    const fileStore = new FilePeerStore(defaultRoot(options));
    if (subcommand === "start") {
      const question = get(options, "question")?.trim();
      if (!question) throw new Error("peer start requires --question");
      const configPath = get(options, "config");
      if (!configPath) throw new Error("peer start requires --config");
      const members = await loadPeerMembers(resolve(configPath), dependencies.env);
      const rounds = positive(get(options, "rounds"), "--rounds", 3);
      if (rounds < 2 || rounds > 3) throw new Error("Initial --rounds must be 2 or 3");
      const limits = {
        minDiscussionRounds: Math.min(2, rounds),
        maxDiscussionRounds: rounds,
        maxCalls: positive(get(options, "max-calls"), "--max-calls", 12),
        maxOutputTokens: positive(get(options, "max-output-tokens"), "--max-output-tokens", 4096)
      };
      const sessionId = get(options, "session-id") ?? randomUUID();
      const state = createPeerSession(
        {
          sessionId,
          schemaVersion: 1,
          question,
          goal: get(options, "goal") ?? "",
          constraints: list(options, "constraint"),
          sourceCommit: "local-unreleased-0.6.1",
          createdAt: new Date().toISOString(),
          members: Object.values(members),
          limits
        },
        await sources(list(options, "context"), 1)
      );
      // Configuration/credentials are local errors: reject the pair before
      // recording intents or giving one member a chance to dispatch.
      for (const memberId of ["member-a", "member-b"] as const) {
        const request = buildMemberRequest(state, memberId);
        if (!(dependencies.env ?? process.env)[request.apiKeyEnv]?.trim())
          throw new Error(`Environment variable ${request.apiKeyEnv} is not set`);
        validatePeerApiRequest(request);
      }
      io.log(`Session: ${sessionId}`);
      io.log(`Members: member-a ${members["member-a"].modelId}; member-b ${members["member-b"].modelId}`);
      io.log(`Sources: ${state.sources.map((x) => `${x.sourceId} (${x.lineCount} lines)`).join(", ") || "none"}`);
      io.log(
        `Limits: rounds ${limits.minDiscussionRounds}..${limits.maxDiscussionRounds}, calls ${limits.maxCalls}, output tokens/call ${limits.maxOutputTokens}, segment ${state.config.limits.segmentTimeoutMs}ms`
      );
      const ended = await fileStore.withWriter(sessionId, async (writer) => {
        await writer.commit(-1, state);
        return drive(io, state, writer, "run", options, dependencies.env);
      });
      printState(ended, io);
      return { ok: ended.status === "completed", code: ended.status === "completed" ? 0 : 2 };
    }
    const sessionId = options.positionals[0]!;
    if (subcommand === "show") {
      printState(await fileStore.load(sessionId), io);
      return { ok: true, code: 0 };
    }
    if (subcommand === "retry" || subcommand === "continue") {
      const ended = await fileStore.withWriter(sessionId, async (writer) => {
        const initial = await writer.load(sessionId);
        if (subcommand === "retry" && initial.status === "active") {
          const recovered = await drive(io, initial, writer, "recover", options, dependencies.env);
          io.log(
            `Recovered interrupted session ${sessionId} without model calls. Run peer retry ${sessionId} again to resume.`
          );
          if (get(options, "extra-calls") !== undefined || get(options, "extend-seconds") !== undefined)
            io.log(
              "Budget extensions were not applied during recovery; repeat --extra-calls/--extend-seconds on the next retry if needed."
            );
          return recovered;
        }
        return drive(io, initial, writer, subcommand, options, dependencies.env);
      });
      printState(ended, io);
      return { ok: ended.status === "completed", code: ended.status === "completed" ? 0 : 2 };
    }
    const report = buildPeerReport(await fileStore.load(sessionId));
    const format = subcommand === "view" ? "html" : get(options, "format");
    if (!format || !["md", "json", "html"].includes(format)) throw new Error("--format must be md, json or html");
    const output = resolve(get(options, "output") ?? join(defaultRoot(options), sessionId, `report.${format}`));
    const content =
      format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : format === "md"
          ? renderPeerMarkdown(report)
          : renderPeerHtml(report);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content, { mode: 0o600 });
    io.log(output);
    if (subcommand === "view" && !options.flags.has("no-open")) openLocal(output);
    return { ok: true, code: 0 };
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return { ok: false, code: 1 };
  }
}
