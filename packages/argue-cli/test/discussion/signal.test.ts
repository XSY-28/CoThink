import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiscussionEngine, currentDiscussionSegment, remainingBudget } from "@onevcat/argue";
import { afterEach, expect, it } from "vitest";
import { FileDiscussionStore } from "../../src/discussion/file-store.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "signal-fixture.mjs");
let root: string | undefined;
let child: ChildProcess | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  child = undefined;
});

it("handles real SIGINT during two nonsettling calls, persists cancellation and recovers without calls", async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-discussion-signal-"));
  child = spawn(process.execPath, [fixture, root], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child!.once("error", reject);
    child!.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Signal fixture did not dispatch: ${stderr}`)), 10000);
    void exited.then(
      () => {
        clearTimeout(timeout);
        reject(new Error(`Signal fixture exited before READY: ${stderr}`));
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
    child!.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const store = new FileDiscussionStore(root);
  const before = await store.load("signal-test");
  const initialSegment = currentDiscussionSegment(before);
  expect(initialSegment.ledger.attempts).toHaveLength(2);
  expect(initialSegment.ledger.attempts.every((attempt) => attempt.status === "pending")).toBe(true);
  const charged = remainingBudget(initialSegment.ledger, 0);

  expect(child.kill("SIGINT")).toBe(true);
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(stderr).toBe("");
  expect(stdout).toContain('DONE:{"calls":2,"aborted":2,"status":"paused"}');
  const saved = await store.load("signal-test");
  const segment = currentDiscussionSegment(saved);
  expect(saved.status).toBe("paused");
  expect(segment.pauseReason?.code).toBe("cancelled");
  expect(segment.ledger.attempts).toHaveLength(2);
  expect(segment.ledger.attempts.every((attempt) => attempt.status === "cancelled")).toBe(true);
  expect(remainingBudget(segment.ledger, 0)).toEqual(charged);
  expect(segment.protocol.committedBatches).toHaveLength(0);
  expect(segment.seals).toHaveLength(0);
  expect(segment.finalResult).toBeUndefined();
  expect(segment.stopReason).toBeUndefined();
  expect(saved.events.filter((event) => event.type === "settled")).toHaveLength(2);
  expect(saved.events.some((event) => event.type === "finalized")).toBe(false);

  let calls = 0;
  await store.withWriter("signal-test", async (writer) => {
    const engine = new DiscussionEngine(
      writer,
      {
        respond: async () => {
          calls++;
          throw new Error("Recovery must not dispatch");
        }
      },
      { now: () => 1 }
    );
    expect(await engine.run("signal-test")).toEqual(saved);
    expect(await engine.run("signal-test")).toEqual(saved);
  });
  expect(calls).toBe(0);
  expect(await store.load("signal-test")).toEqual(saved);
}, 15000);
