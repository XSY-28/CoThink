import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { normalizePeerMembers, peerProfiles } from "./config.js";
import { writeSetupFiles } from "./local-config.js";

export interface PeerPrompt {
  ask(message: string): Promise<string>;
  secret(message: string): Promise<string>;
  close?(): void;
}

export interface PeerSetupOptions {
  configPath: string;
  envPath: string;
  env: Record<string, string | undefined>;
  io: Pick<Console, "log" | "error">;
  prompt?: PeerPrompt;
  noInput?: boolean;
}

type Profile = keyof typeof peerProfiles;
interface SetupMember {
  profile: Profile;
  baseUrl: string;
  modelId: string;
  apiKeyEnv: string;
  outputMode: "json_object" | "prompt_json";
}

/** A real terminal is required so a pipe can never echo or capture key entry. */
function terminalPrompt(): PeerPrompt {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Interactive setup requires a terminal; use --no-input to create an editable template.");
  let muted = false;
  let closed = false;
  let interrupted = false;
  let rejectPending: ((error: Error) => void) | undefined;
  const output = Object.assign(
    new Writable({
      write(chunk, encoding, callback) {
        if (muted) callback();
        else process.stdout.write(chunk, encoding, callback);
      }
    }),
    { isTTY: true, columns: process.stdout.columns }
  );
  const readline = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  readline.on("SIGINT", () => {
    interrupted = true;
    readline.close();
  });
  readline.on("close", () => {
    const wasMuted = muted;
    muted = false;
    closed = true;
    if (wasMuted) process.stdout.write("\n");
    rejectPending?.(new Error(interrupted ? "Setup cancelled" : "Input closed (EOF); setup cancelled"));
    rejectPending = undefined;
  });
  const question = (message: string, hide: boolean): Promise<string> => {
    if (closed) return Promise.reject(new Error("Input closed; setup cancelled"));
    return new Promise((resolve, reject) => {
      rejectPending = reject;
      if (hide) {
        process.stdout.write(message);
        muted = true;
      }
      readline.question(hide ? "" : message, (answer) => {
        rejectPending = undefined;
        muted = false;
        if (hide) process.stdout.write("\n");
        resolve(answer);
      });
    });
  };
  return {
    ask: (message) => question(message, false),
    secret: (message) => question(message, true),
    close: () => {
      muted = false;
      readline.close();
      output.end();
    }
  };
}

async function withDefault(prompt: PeerPrompt, label: string, fallback?: string): Promise<string> {
  return (await prompt.ask(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback || "";
}

async function collectMember(
  slot: "member-a" | "member-b",
  prompt: PeerPrompt,
  options: PeerSetupOptions,
  keys: Record<string, string>
): Promise<SetupMember> {
  options.io.log(`Configure ${slot}.`);
  const selected = await withDefault(
    prompt,
    "Profile/protocol: 1 openai-compatible, 2 anthropic-compatible, 3 deepseek, 4 glm",
    "openai-compatible"
  );
  const numbered: Record<string, Profile> = {
    "1": "openai-compatible",
    "2": "anthropic-compatible",
    "3": "deepseek",
    "4": "glm"
  };
  const profile = numbered[selected] ?? selected;
  if (!Object.hasOwn(peerProfiles, profile)) throw new Error("Choose a supported profile/protocol.");
  const name = profile as Profile;
  const defaults = peerProfiles[name];
  const baseUrl = await withDefault(prompt, "API endpoint", "baseUrl" in defaults ? defaults.baseUrl : undefined);
  const modelId = await withDefault(prompt, "Model ID", "modelId" in defaults ? defaults.modelId : undefined);
  const apiKeyEnv = await withDefault(
    prompt,
    "API key environment variable",
    "apiKeyEnv" in defaults ? defaults.apiKeyEnv : slot === "member-a" ? "PEER_A_API_KEY" : "PEER_B_API_KEY"
  );
  let outputMode: SetupMember["outputMode"] = defaults.outputMode;
  if (name === "openai-compatible") {
    const choice = await withDefault(prompt, "JSON output mode (json_object or prompt_json)", "json_object");
    if (choice !== "json_object" && choice !== "prompt_json") throw new Error("Choose json_object or prompt_json.");
    outputMode = choice;
  }
  const member: SetupMember = { profile: name, baseUrl, modelId, apiKeyEnv, outputMode };
  // Validate fields before requesting a secret; validate the complete pair again before writing.
  normalizePeerMembers({ members: { "member-a": member, "member-b": member } }, options.env);
  const key = await prompt.secret(`Optional API key for ${apiKeyEnv} (hidden; Enter to skip): `);
  if (key.trim()) {
    if (Object.hasOwn(keys, apiKeyEnv) && keys[apiKeyEnv] !== key)
      throw new Error("Conflicting values entered for the same API key environment variable.");
    keys[apiKeyEnv] = key;
  } else if ((Object.hasOwn(options.env, apiKeyEnv) && options.env[apiKeyEnv]?.trim()) || keys[apiKeyEnv]) {
    options.io.log(`Using the existing ${apiKeyEnv} credential.`);
  } else {
    options.io.log(`Set ${apiKeyEnv} in your environment before running a session.`);
  }
  return member;
}

export async function setupPeerConfig(
  options: PeerSetupOptions
): Promise<{ configPath: string; envPath: string; wroteKeys: boolean }> {
  const keys = Object.create(null) as Record<string, string>;
  let prompt: PeerPrompt | undefined;
  let members: Record<"member-a" | "member-b", SetupMember>;
  try {
    if (options.noInput) {
      const template = (apiKeyEnv: string): SetupMember => ({
        profile: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        modelId: "model-id",
        apiKeyEnv,
        outputMode: "json_object"
      });
      members = { "member-a": template("PEER_A_API_KEY"), "member-b": template("PEER_B_API_KEY") };
    } else {
      prompt = options.prompt ?? terminalPrompt();
      options.io.log("CoThink setup. Keys are optional and saved separately. No API requests are sent.");
      members = {
        "member-a": await collectMember("member-a", prompt, options, keys),
        "member-b": await collectMember("member-b", prompt, options, keys)
      };
    }
    // Finish terminal input before committing the validated files.
    prompt?.close?.();
    prompt = undefined;
    const config = { members };
    normalizePeerMembers(config, options.env);
    await writeSetupFiles(options.configPath, options.envPath, config, keys);
    const wroteKeys = Object.keys(keys).length > 0;
    options.io.log(`Configuration saved: ${options.configPath}`);
    if (wroteKeys) options.io.log(`Private key file saved: ${options.envPath}`);
    if (options.noInput)
      options.io.log(
        "Edit both API endpoints and model IDs, then set PEER_A_API_KEY and PEER_B_API_KEY before testing."
      );
    return { configPath: options.configPath, envPath: options.envPath, wroteKeys };
  } finally {
    prompt?.close?.();
  }
}
