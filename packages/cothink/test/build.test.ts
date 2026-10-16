import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runCoThink } from "../src/index.js";

const exec = promisify(execFile);
const compiledEntry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

it("routes the compiled build command to its strict local parser", async () => {
  const result = await exec(process.execPath, [compiledEntry, "build", "start", "--unexpected", "--json"]).then(
    (value) => ({ ...value, code: 0 }),
    (error: { stdout: string; stderr: string; code: number }) => error
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(
    /BUILD_ARGUMENT_INVALID|(?:unknown|unexpected).*build.*option|(?:unknown|unexpected).*option.*unexpected/i
  );
  expect(result.stderr).not.toMatch(/unknown command.*build/i);
});

it("passes a missing --env-file to the compiled CLI parser rather than Node startup", async () => {
  const { spawnSmokeProcess } = await import("../../../scripts/smoke-build.mjs");
  const running = spawnSmokeProcess(
    process.execPath,
    [compiledEntry, "build", "start", "--unexpected", "--env-file", "/missing-cothink-smoke-key-file", "--json"],
    { timeoutMs: 5000 }
  );
  const result = await running.done;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("BUILD_ARGUMENT_INVALID");
  expect(result.stderr).not.toContain("not found");
});

it("lists construction as a separate command family in the local help", async () => {
  const logs: string[] = [];
  expect(await runCoThink(["--help"], { log: (line) => logs.push(line), error: () => {} })).toEqual({
    ok: true,
    code: 0
  });
  expect(logs.join("\n")).toMatch(/build (?:start|<)/);
});

// These are fast command-boundary mechanisms. The separate smoke-build.mjs
// gate uses compiled entry, actual loopback HTTP and real disk/Git/Docker.
it("rejects malformed construction arguments before credentials, network or managed state", async () => {
  const logs: string[] = [],
    errors: string[] = [];
  let calls = 0;
  const transport = {
    respond: async () => {
      calls++;
      throw Error("unexpected model invocation");
    }
  };
  for (const argv of [
    ["build", "start", "--unexpected"],
    ["build", "start", "--root"],
    ["build", "retry", "run", "--extra-calls", "1"],
    ["build", "cancel", "../escape"],
    ["build", "export", "run", "--format", "json"],
    ["build", "show", "one", "two"],
    ["build", "show", "run", "--env-file", "/missing-secret-file"],
    ["build", "start", "--image", "node:latest"]
  ]) {
    expect(
      await runCoThink(argv, { log: (s) => logs.push(s), error: (s) => errors.push(s) }, { env: {}, transport })
    ).toEqual({ ok: false, code: 1 });
  }
  expect(calls).toBe(0);
  expect(logs).toEqual([]);
  expect(errors).toHaveLength(8);
  expect(errors.join("\n")).not.toMatch(/Cannot read environment file|unexpected model invocation/);
});

it("bounds an actual owned child and rejects private output before evidence projection", async () => {
  const {
    spawnSmokeProcess,
    projectSmokeOutput,
    smokeFailure,
    boundedSmokeWait,
    assertSmokeConsumerLive,
    smokeLateEdit
  } = await import("../../../scripts/smoke-build.mjs");
  const running = spawnSmokeProcess(
    process.execPath,
    ["-e", 'process.stdout.write("smoke-fake-a"); setInterval(() => {}, 1000)'],
    { timeoutMs: 400 }
  );
  await boundedSmokeWait(new Promise<void>((resolve) => running.child.stdout.once("data", () => resolve())), 2000);
  expect(() => assertSmokeConsumerLive(running.child)).not.toThrow();
  expect(
    smokeLateEdit(
      {
        actionVersion: "build-action-v1",
        requestId: "req",
        input: { files: [{ path: "src/a.ts", contentHash: "sha256:original-request-hash" }] }
      },
      "src/a.ts",
      "valid fixture text"
    ).action.expectedContentHash
  ).toBe("sha256:original-request-hash");
  const result = await running.done;
  expect(() => assertSmokeConsumerLive(running.child)).toThrow("SMOKE_LIVE_CANCEL_CHECKPOINT_MISSED");
  expect(result.timedOut).toBe(true);
  expect(result.signal).toBe("SIGKILL");
  expect(running.child.exitCode !== null || running.child.signalCode !== null).toBe(true);
  expect(result.stdout).toBe("smoke-fake-a");
  const projected = projectSmokeOutput(result.stdout, result.stderr);
  expect(projected).toEqual({ stdoutBytes: 12, stderrBytes: 0, errorCode: "SMOKE_PUBLIC_OUTPUT_REJECTED" });
  const evidence = JSON.stringify({
    output: projected,
    error: smokeFailure(new Error('provider body smoke-fake-a {"nonce":"PRIVATE"}'))
  });
  expect(evidence).not.toContain("smoke-fake-a");
  expect(evidence).not.toContain("PRIVATE");
  expect(evidence).not.toContain("provider body");
  expect(projectSmokeOutput('{"nonce":"new-unknown-authority"}', "").errorCode).toBe("SMOKE_PUBLIC_OUTPUT_REJECTED");
  expect(projectSmokeOutput('{"status":"completed"}', "")).toEqual({ stdout: '{"status":"completed"}', stderr: "" });
});

it("bounds a harness barrier independently and clears a successful child watchdog", async () => {
  const { boundedSmokeWait, spawnSmokeProcess } = await import("../../../scripts/smoke-build.mjs");
  let stopped = 0;
  await expect(
    boundedSmokeWait(new Promise(() => {}), 20, () => {
      stopped++;
    })
  ).rejects.toThrow("SMOKE_BARRIER_TIMEOUT");
  expect(stopped).toBe(1);
  const running = spawnSmokeProcess(process.execPath, ["-e", 'process.stdout.write("{}")'], { timeoutMs: 2000 });
  expect(await running.done).toMatchObject({ code: 0, signal: null, stdout: "{}", timedOut: false });
});

it("observes actual persisted cancellation with watch-before-dispatch and an initial read", async () => {
  const { observeSmokeState } = await import("../../../scripts/smoke-build.mjs");
  const { mkdtemp, writeFile, rename, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "cothink-smoke-control-"));
  try {
    const path = join(directory, "session.json"),
      next = join(directory, "next.json");
    await writeFile(path, '{"status":"active"}');
    const revoked = observeSmokeState(path, (state: { status: string }) => state.status === "cancelled", 2000);
    await writeFile(next, '{"status":"cancelled"}');
    await rename(next, path);
    expect(await revoked).toEqual({ status: "cancelled" });
    expect(await observeSmokeState(path, (state: { status: string }) => state.status === "cancelled", 2000)).toEqual({
      status: "cancelled"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
