import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { normalizePeerMembers } from "../../src/peer/config.js";
import { readPeerEnvironment } from "../../src/peer/local-config.js";
import { setupPeerConfig, type PeerPrompt } from "../../src/peer/setup.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-wizard-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function scriptedPrompt(answers: Array<string | Error>, secrets: Array<string | Error>) {
  let closed = false;
  const take = async (queue: Array<string | Error>) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("Unexpected prompt or EOF");
    return next;
  };
  const prompt: PeerPrompt = {
    ask: () => take(answers),
    secret: () => take(secrets),
    close: () => {
      closed = true;
    }
  };
  return { prompt, isClosed: () => closed };
}

function options(prompt?: PeerPrompt, env: Record<string, string | undefined> = {}) {
  const logs: string[] = [];
  return {
    configPath: join(root, "private", "config.json"),
    envPath: join(root, "private", "keys.env"),
    env,
    prompt,
    io: {
      log: (...values: unknown[]) => {
        logs.push(values.join(" "));
      },
      error: (...values: unknown[]) => {
        logs.push(values.join(" "));
      }
    },
    logs
  };
}

const genericAnswers = [
  "openai-compatible",
  "https://openai.example/v1",
  "model-a",
  "CUSTOM_A",
  "prompt_json",
  "anthropic-compatible",
  "https://anthropic.example",
  "model-b",
  "CUSTOM_B"
];
const presetAnswers = ["deepseek", "", "", "", "glm", "", "", ""];

it("writes two independent generic transports and keeps optional keys out of configuration and logs", async () => {
  const fake = scriptedPrompt([...genericAnswers], ["fake-sensitive-a", "fake-sensitive-b"]);
  const opts = options(fake.prompt);
  expect(await setupPeerConfig(opts)).toEqual({ configPath: opts.configPath, envPath: opts.envPath, wroteKeys: true });
  const content = await readFile(opts.configPath, "utf8");
  const members = normalizePeerMembers(JSON.parse(content), {});
  expect(members["member-a"]).toMatchObject({
    protocol: "openai-compatible",
    baseUrl: "https://openai.example/v1",
    modelId: "model-a",
    apiKeyEnv: "CUSTOM_A",
    outputMode: "prompt_json",
    generationOptions: {}
  });
  expect(members["member-b"]).toMatchObject({
    protocol: "anthropic-compatible",
    baseUrl: "https://anthropic.example",
    modelId: "model-b",
    apiKeyEnv: "CUSTOM_B",
    outputMode: "prompt_json",
    generationOptions: {}
  });
  expect(await readPeerEnvironment(opts.envPath, {})).toEqual({
    CUSTOM_A: "fake-sensitive-a",
    CUSTOM_B: "fake-sensitive-b"
  });
  expect(content + opts.logs.join(" ")).not.toContain("fake-sensitive");
  expect((await stat(opts.configPath)).mode & 0o777).toBe(0o600);
  expect(fake.isClosed()).toBe(true);
});

it("accepts both explicit preset defaults and materializes their protected tuning on load", async () => {
  const fake = scriptedPrompt([...presetAnswers], ["", ""]);
  const opts = options(fake.prompt);
  await setupPeerConfig(opts);
  const members = normalizePeerMembers(JSON.parse(await readFile(opts.configPath, "utf8")), {});
  expect(members["member-a"]).toMatchObject({
    modelId: "deepseek-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    generationOptions: { thinking: { type: "disabled" } }
  });
  expect(members["member-b"]).toMatchObject({
    modelId: "glm-5.3-flash",
    apiKeyEnv: "GLM_API_KEY",
    generationOptions: { thinking: { type: "enabled" }, reasoning_effort: "low" }
  });
  await expect(stat(opts.envPath)).rejects.toThrow();
});

it("writes an editable generic template with no input and no key file", async () => {
  const fake = scriptedPrompt([], []);
  const opts = options(fake.prompt);
  expect((await setupPeerConfig({ ...opts, noInput: true })).wroteKeys).toBe(false);
  const members = normalizePeerMembers(JSON.parse(await readFile(opts.configPath, "utf8")), {});
  expect(members["member-a"]).toMatchObject({
    protocol: "openai-compatible",
    baseUrl: "https://example.invalid/v1",
    modelId: "model-id",
    apiKeyEnv: "PEER_A_API_KEY",
    generationOptions: {}
  });
  expect(members["member-b"]).toMatchObject({
    baseUrl: "https://example.invalid/v1",
    modelId: "model-id",
    apiKeyEnv: "PEER_B_API_KEY"
  });
  await expect(stat(opts.envPath)).rejects.toThrow();
});

it("references externally managed credentials without copying them to disk or logs", async () => {
  const fake = scriptedPrompt([...presetAnswers], ["", ""]);
  const opts = options(fake.prompt, { DEEPSEEK_API_KEY: "external-sensitive-a", GLM_API_KEY: "external-sensitive-b" });
  expect((await setupPeerConfig(opts)).wroteKeys).toBe(false);
  await expect(stat(opts.envPath)).rejects.toThrow();
  expect((await readFile(opts.configPath, "utf8")) + opts.logs.join(" ")).not.toContain("external-sensitive");
});

it.each(["Setup cancelled", "Input closed (EOF)"])(
  "closes the prompt and writes nothing on %s after collecting a key",
  async (reason) => {
    const fake = scriptedPrompt(["deepseek", "", "", "", new Error(reason)], ["fake-sensitive-a"]);
    const opts = options(fake.prompt);
    await expect(setupPeerConfig(opts)).rejects.toThrow(reason);
    await expect(stat(opts.configPath)).rejects.toThrow();
    await expect(stat(opts.envPath)).rejects.toThrow();
    expect(fake.isClosed()).toBe(true);
  }
);

it.each([
  ["unsupported", "", "", ""],
  ["deepseek", "file:///invalid", "", ""],
  ["deepseek", "", "", "KEY=bad"],
  ["openai-compatible", "https://example.test/v1", "", "", ""]
])("rejects invalid configuration without writing files", async (...answers) => {
  const fake = scriptedPrompt([...answers, "glm", "", "", ""], ["", ""]);
  const opts = options(fake.prompt);
  await expect(setupPeerConfig(opts)).rejects.toThrow();
  await expect(stat(opts.configPath)).rejects.toThrow();
  await expect(stat(opts.envPath)).rejects.toThrow();
  expect(fake.isClosed()).toBe(true);
});

it("refuses an existing config and leaves existing contents intact", async () => {
  const opts = options(scriptedPrompt([...presetAnswers], ["fake-sensitive-a", ""]).prompt);
  await writeFile(join(root, "existing.json"), "existing");
  opts.configPath = join(root, "existing.json");
  await expect(setupPeerConfig(opts)).rejects.toThrow(/exist/i);
  expect(await readFile(opts.configPath, "utf8")).toBe("existing");
  await expect(stat(opts.envPath)).rejects.toThrow();
});

it("refuses a symlink at the key path and leaves its target intact", async () => {
  const opts = options(scriptedPrompt([...presetAnswers], ["fake-sensitive-a", ""]).prompt);
  const target = join(root, "target.env");
  await writeFile(target, "existing");
  opts.envPath = join(root, "linked.env");
  await symlink(target, opts.envPath);
  await expect(setupPeerConfig(opts)).rejects.toThrow(/exist/i);
  expect(await readFile(target, "utf8")).toBe("existing");
  await expect(stat(opts.configPath)).rejects.toThrow();
});

it("refuses conflicting values for a shared key variable without persisting either", async () => {
  const fake = scriptedPrompt(
    ["deepseek", "", "", "SHARED_KEY", "glm", "", "", "SHARED_KEY"],
    ["fake-sensitive-a", "fake-sensitive-b"]
  );
  const opts = options(fake.prompt);
  await expect(setupPeerConfig(opts)).rejects.toThrow(/conflict|different/i);
  await expect(stat(opts.configPath)).rejects.toThrow();
  await expect(stat(opts.envPath)).rejects.toThrow();
});

it("rejects a key that dotenv cannot represent instead of silently discarding it", async () => {
  const fake = scriptedPrompt(
    ["deepseek", "", "", "__proto__", "glm", "", "", "constructor"],
    ["fake-special-a", "fake-special-b"]
  );
  const opts = options(fake.prompt);
  await expect(setupPeerConfig(opts)).rejects.toThrow(/represented safely/);
  await expect(stat(opts.configPath)).rejects.toThrow();
  await expect(stat(opts.envPath)).rejects.toThrow();
});

it("allows externally managed credentials whose names are Object prototype properties", async () => {
  const fake = scriptedPrompt(["deepseek", "", "", "__proto__", "glm", "", "", "constructor"], ["", ""]);
  const opts = options(
    fake.prompt,
    Object.fromEntries([
      ["__proto__", "fake-special-a"],
      ["constructor", "fake-special-b"]
    ])
  );
  expect((await setupPeerConfig(opts)).wroteKeys).toBe(false);
  expect(await readFile(opts.configPath, "utf8")).not.toContain("fake-special");
  await expect(stat(opts.envPath)).rejects.toThrow();
});
