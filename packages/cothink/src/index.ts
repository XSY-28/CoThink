import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { MemberId, MemberRuntime, ModelTransport } from "@onevcat/argue";
import metadata from "../package.json" with { type: "json" };
import { runDiscussionCommand } from "../../argue-cli/src/discussion/commands.js";
import { runBuildCommand } from "../../argue-cli/src/build/commands.js";
import { loadDiscussionConfig } from "../../argue-cli/src/discussion/config.js";
import { testPeerConnections } from "../../argue-cli/src/peer/diagnostics.js";
import { DEFAULT_PEER_CONFIG, DEFAULT_PEER_ENV, readPeerEnvironment } from "../../argue-cli/src/peer/local-config.js";
import { setupDiscussionConfig, type PeerPrompt } from "../../argue-cli/src/peer/setup.js";

type Io = Pick<Console, "log" | "error">;
export interface CoThinkOptions {
  env?: Record<string, string | undefined>;
  prompt?: PeerPrompt;
  runtime?: MemberRuntime;
  transport?: ModelTransport;
  now?: () => number;
}
const commands = new Set(["start", "show", "retry", "continue", "export", "view"]);

function help(io: Io) {
  io.log(`CoThink v${metadata.version} — two equal model peers, local versioned discussions.`);
  io.log("Usage: cothink setup | init | test | start | show | retry | continue | export | view");
  io.log(
    "  build start|show|retry|cancel|export  Local construction; use cothink build help for explicit plan approval."
  );
  io.log("  setup [--config FILE] [--env-file FILE] [--no-input]  Configure two members; optional keys are masked.");
  io.log(
    "  init [--config FILE] [--env-file FILE]              Write an editable generic template, without API calls."
  );
  io.log("  test [--config FILE] [--env-file FILE] [--member member-a|member-b] [--json]");
  io.log(
    "       [--timeout-ms N] [--max-output-tokens N]       Up to 4 model requests, no retries; connection and structure only."
  );
  io.log(
    "  start (--question TEXT | --question-file FILE) [--config FILE] [--env-file FILE] [--context FILE] [--effort low|standard|high] [--max-rounds N]"
  );
  io.log("  start/continue: --participation-weight member-a=2 --decision-weight member-b=3 (weights are independent).");
  io.log("  show SESSION_ID | retry SESSION_ID | continue SESSION_ID [--note TEXT] [--effort ...] [--max-rounds N]");
  io.log("  export SESSION_ID --format txt|md|json|html [--output FILE] | view SESSION_ID [--no-open]");
  io.log("  All session commands accept --json: one FinalResult object; discussion stays private.");
  io.log("  Precedence: CLI flags > config > defaults. Read/show/view/export need no keys and make no model calls.");
  io.log(
    "  All session commands accept --root DIR. retry: --extra-calls N / --extra-output-tokens N / --extend-seconds N."
  );
  io.log(
    "  Defaults: .cothink/config.json, .cothink/keys.env, .cothink/sessions. Process environment overrides the key file."
  );
  io.log("  Keys stay local. Agreement records the peers' positions; it is not independent verification.");
}

function parseManagement(args: string[], mode: "setup" | "test") {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowed =
    mode === "setup"
      ? ["config", "env-file", "no-input"]
      : ["config", "env-file", "member", "timeout-ms", "max-output-tokens", "json"];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!.replace(/^--/, "");
    if (!args[i]!.startsWith("--") || !allowed.includes(key)) throw Error(`Unknown ${mode} option: ${args[i]}`);
    if (key === "no-input" || key === "json") {
      flags.add(key);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(`Missing value for --${key}`);
    values.set(key, value);
  }
  return { values, flags };
}
function positive(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Error("Timeout and output limit must be positive integers");
  return n;
}
async function environment(path: string, explicit: boolean, base: Record<string, string | undefined>) {
  if (!explicit) {
    try {
      await access(path);
    } catch {
      return { ...base };
    }
  }
  return readPeerEnvironment(path, base);
}

export async function runCoThink(
  argv: string[],
  io: Io = console,
  dependencies: CoThinkOptions = {}
): Promise<{ ok: boolean; code: number }> {
  const [command = "help", ...rest] = argv;
  try {
    if (["help", "--help", "-h"].includes(command) || rest.includes("--help")) {
      help(io);
      return { ok: true, code: 0 };
    }
    if (["version", "--version", "-v"].includes(command)) {
      io.log(`CoThink v${metadata.version}`);
      return { ok: true, code: 0 };
    }
    const base = dependencies.env ?? process.env;
    if (command === "build")
      return runBuildCommand(rest, io, {
        env: base,
        transport: dependencies.transport,
        now: dependencies.now
      });
    if (["setup", "init", "test", "doctor"].includes(command)) {
      const isSetup = command === "setup" || command === "init";
      const { values, flags } = parseManagement(rest, isSetup ? "setup" : "test");
      const configPath = resolve(values.get("config") ?? DEFAULT_PEER_CONFIG);
      const envPath = resolve(values.get("env-file") ?? DEFAULT_PEER_ENV);
      if (isSetup) {
        // New setup may create this path; read it only when it already exists.
        const env = await environment(envPath, false, base);
        await setupDiscussionConfig({
          configPath,
          envPath,
          env,
          io,
          prompt: dependencies.prompt,
          noInput: command === "init" || flags.has("no-input")
        });
        return { ok: true, code: 0 };
      }
      const member = values.get("member");
      if (member !== undefined && member !== "member-a" && member !== "member-b")
        throw Error("--member must be member-a or member-b");
      const timeoutMs = positive(values.get("timeout-ms"), 30000);
      const maxOutputTokens = positive(values.get("max-output-tokens"), 2048);
      const env = await environment(envPath, values.has("env-file"), base);
      const { members } = await loadDiscussionConfig(configPath, env);
      if (!flags.has("json"))
        io.log(
          `Testing ${member ?? "both members"}: up to ${member ? 2 : 4} API requests; ${timeoutMs}ms and ${maxOutputTokens} output tokens per request; no retries.`
        );
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on("SIGINT", cancel);
      try {
        const report = await testPeerConnections(members, env, {
          memberId: member as MemberId | undefined,
          timeoutMs,
          maxOutputTokens,
          runtime: dependencies.runtime,
          signal: controller.signal
        });
        if (flags.has("json")) io.log(JSON.stringify(report, null, 2));
        else {
          for (const result of report.results)
            for (const check of result.checks)
              io.log(
                `${result.memberId} ${result.modelId} ${check.phase}: ${check.ok ? "OK" : `${check.error?.code ?? "failed"} — ${check.error?.message ?? "Failed"}`}`
              );
          io.log(
            `Calls: ${report.calls}. ${report.ok ? "Connection and structured-output checks passed." : "Checks failed; correct the reported configuration/provider issue before starting a discussion."}`
          );
        }
        return { ok: report.ok, code: report.ok ? 0 : 1 };
      } finally {
        process.off("SIGINT", cancel);
      }
    }
    if (!commands.has(command)) throw Error(`Unknown CoThink command: ${command}. Use cothink --help.`);
    return await runDiscussionCommand([command, ...rest], io, {
      env: base,
      transport: dependencies.transport,
      legacyRuntime: dependencies.runtime,
      now: dependencies.now
    });
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return { ok: false, code: 1 };
  }
}
