import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPeerEnvironment, writeSetupFiles } from "../../src/peer/local-config.js";

let root: string;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  root = await mkdtemp(join(tmpdir(), "cothink-setup-"));
});

it("never deletes replacement credentials when config creation loses a filesystem race", async () => {
  const configPath = join(root, "config.json"),
    envPath = join(root, "keys.env");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    if (String(args[0]) === configPath) {
      await actual.unlink(envPath);
      await actual.writeFile(envPath, "OTHER=retained-by-other-process\n", { mode: 0o600 });
      throw Object.assign(new Error("Simulated configuration collision"), { code: "EEXIST" });
    }
    return actual.writeFile(...args);
  });
  await expect(writeSetupFiles(configPath, envPath, config, { PEER_A_API_KEY: "fake-a" })).rejects.toThrow();
  expect(await readFile(envPath, "utf8")).toBe("OTHER=retained-by-other-process\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const config = {
  members: {
    "member-a": {
      protocol: "openai-compatible",
      baseUrl: "https://example.test/v1",
      modelId: "a",
      apiKeyEnv: "PEER_A_API_KEY"
    },
    "member-b": {
      protocol: "anthropic-compatible",
      baseUrl: "https://example.test/v1",
      modelId: "b",
      apiKeyEnv: "PEER_B_API_KEY"
    }
  }
};

it("writes private configuration and separate round-trippable keys without exposing them in config", async () => {
  const dir = join(root, "private"),
    path = join(dir, "config.json"),
    envPath = join(dir, "keys.env");
  const keys = { PEER_A_API_KEY: "fake-a'\" # back\\slash", PEER_B_API_KEY: "fake-b" };
  await writeSetupFiles(path, envPath, config, keys);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
  expect(await readFile(path, "utf8")).not.toContain("fake-");
  expect(await readPeerEnvironment(envPath, {})).toEqual(keys);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(envPath)).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

it("does not overwrite an existing config or create an orphan key file", async () => {
  const path = join(root, "config.json"),
    envPath = join(root, "keys.env");
  await writeFile(path, "existing");
  await expect(writeSetupFiles(path, envPath, config, { PEER_A_API_KEY: "fake-a" })).rejects.toThrow(/exist/i);
  expect(await readFile(path, "utf8")).toBe("existing");
  await expect(stat(envPath)).rejects.toThrow();
});

it("does not overwrite existing keys, including symlinks", async () => {
  const target = join(root, "target"),
    envPath = join(root, "keys.env"),
    path = join(root, "config.json");
  await writeFile(target, "untouched");
  await symlink(target, envPath);
  await expect(writeSetupFiles(path, envPath, config, { PEER_A_API_KEY: "fake-a" })).rejects.toThrow(/exist/i);
  expect(await readFile(target, "utf8")).toBe("untouched");
  await expect(stat(path)).rejects.toThrow();
});

it("loads keys without mutating process environment and lets existing environment take precedence", async () => {
  const envPath = join(root, "keys.env");
  await writeFile(envPath, "PEER_A_API_KEY='fake-file'\nPEER_B_API_KEY=fake-b\n");
  const base = { PEER_A_API_KEY: "fake-process" };
  expect(await readPeerEnvironment(envPath, base)).toEqual({
    PEER_A_API_KEY: "fake-process",
    PEER_B_API_KEY: "fake-b"
  });
  expect(base).toEqual({ PEER_A_API_KEY: "fake-process" });
  expect(process.env.PEER_B_API_KEY).toBeUndefined();
});

it("rejects multiline secrets without including their value in the error", async () => {
  const value = "sensitive-fake\nSECOND=bad";
  let caught: unknown;
  try {
    await writeSetupFiles(join(root, "config.json"), join(root, "keys.env"), config, { PEER_A_API_KEY: value });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain("sensitive-fake");
  await expect(stat(join(root, "config.json"))).rejects.toThrow();
});

it("can save a config with externally managed credentials without making a key file", async () => {
  const path = join(root, "config.json"),
    envPath = join(root, "keys.env");
  await writeSetupFiles(path, envPath, config, {});
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
  await expect(stat(envPath)).rejects.toThrow();
});
