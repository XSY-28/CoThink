import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const script = resolve(repo, "scripts/smoke-agent-sync.mjs");

test("runtime guard allows compiled neutral entry and rejects existing root before evaluation", async () => {
  const { guardedChild, sanitizedEnvironment } = await import(script);
  const root = await mkdtemp(join(tmpdir(), "agent-sync-guard-test-"));
  try {
    const env = sanitizedEnvironment({
      ...process.env,
      NODE_OPTIONS: "--bad-option",
      OPENAI_API_KEY: "private-sentinel"
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const positive = await guardedChild("positive", root, env);
    expect(positive.code).toBe(0);
    expect(positive.stdout).toContain("NEUTRAL_IMPORT_OK");
    expect(positive.args.indexOf("--")).toBeLessThan(positive.args.indexOf(script));
    const negative = await guardedChild("negative", root, env);
    expect(negative.code).toBe(0);
    expect(negative.stdout).toContain("ROOT_GUARD_REJECTED");
    const trace = await readFile(join(root, "negative-imports.jsonl"), "utf8");
    expect(JSON.parse(trace.trim().split("\n").at(-1)!).decision).toBe("denied");
    expect(trace).not.toContain("@ai-sdk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("bounded child terminates its own process group and caps output", async () => {
  const { runBounded, sanitizedEnvironment } = await import(script);
  const env = sanitizedEnvironment(process.env);
  const timed = await runBounded(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)', '--'], { stdio: 'inherit' }); child.on('spawn', () => console.log('DESCENDANT_STARTED')); setInterval(() => {}, 1000)",
      "--"
    ],
    { env, timeoutMs: 1000 }
  );
  expect(timed.stdout).toContain("DESCENDANT_STARTED");
  expect(timed.timedOut).toBe(true);
  expect(timed.code).not.toBe(0);
  const noisy = await runBounded(
    process.execPath,
    ["--input-type=module", "--eval", "process.stdout.write('x'.repeat(100000))", "--"],
    { env, maxOutputBytes: 1000 }
  );
  expect(noisy.outputExceeded).toBe(true);
  expect(noisy.stdout.length).toBeLessThanOrEqual(1000);
}, 10000);

test("safe diagnostic preserves bounded nested backend causes while redacting capabilities and object dumps", async () => {
  const { safeFailure } = await import(script);
  const secret = "known-private-token";
  const deepest = new Error(
    `BUILD_DOCKER_DATA: ${secret}; nonce=unknown-private-nonce; lease={"token":"other-private-token"}; detail=[{"raw":"private-value"}]`
  );
  const backend = new Error("Build sync candidate is stale, unknown or unbound", { cause: deepest });
  const outer = new Error("Agent sync operation rejected (port_rejected)", { cause: backend });
  const result = safeFailure(outer, [secret]);
  expect(result.causes).toHaveLength(3);
  expect(result.causes[1].message).toBe("Build sync candidate is stale, unknown or unbound");
  const output = JSON.stringify(result);
  for (const privateValue of [secret, "unknown-private-nonce", "other-private-token", "private-value"])
    expect(output).not.toContain(privateValue);
  expect(result.causes[2].message).toContain("BUILD_DOCKER_DATA");
  const assertion = Object.assign(new Error("actual={private: true} expected={private: false}"), {
    name: "AssertionError",
    actual: { token: secret },
    expected: { nonce: "never-serialize" }
  });
  expect(safeFailure(assertion, [secret]).causes[0].message).toBe("Assertion failed; value dumps omitted");
  const circular = new Error("a".repeat(2000));
  Object.assign(circular, { cause: circular });
  expect(safeFailure(circular, []).causes).toHaveLength(1);
  expect(safeFailure(circular, []).causes[0].message.length).toBeLessThanOrEqual(360);
  let chain = new Error("tail");
  for (let index = 0; index < 20; index++) chain = new Error("wrapper", { cause: chain });
  expect(safeFailure(chain, []).causes.length).toBeLessThanOrEqual(6);
});
