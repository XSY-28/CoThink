import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DiscussionEngine,
  createDiscussionRun,
  appendDiscussionRunEvent,
  currentDiscussionSegment,
  type DiscussionRun,
  type DiscussionRunStore,
  type ModelCall,
  type ModelReply
} from "@onevcat/argue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDiscussionStore } from "../../src/discussion/file-store.js";

const directory = dirname(fileURLToPath(import.meta.url));
const fixture = join(directory, "crash-fixture.mjs");
const storeModule = pathToFileURL(join(directory, "../../dist/discussion/file-store.js")).href;
const config = {
  protocol: "openai-compatible",
  baseUrl: "https://offline.invalid/v1",
  modelId: "scripted",
  apiKeyEnv: "UNUSED_TEST_KEY",
  outputMode: "json_object" as const,
  generationOptions: {}
};
let root: string;
let children: ChildProcess[] = [];
const initial = () =>
  createDiscussionRun(
    {
      sessionId: "session-1",
      question: "Which proposal?",
      memberIds: ["a", "b"],
      members: { a: config, b: config },
      policy: { effort: "standard" }
    },
    0
  );
async function create(store: FileDiscussionStore, run = initial()) {
  await store.withWriter(run.sessionId, async (writer) => writer.commit(-1, run));
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}
async function crash(boundary: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fixture, root, boundary], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stderr = "",
    stdout = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Crash boundary timed out: ${boundary}: ${stderr}`)), 15000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before ${boundary}: ${stderr}`));
    });
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(`BOUNDARY:${boundary}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return child;
}
function scripted(call: ModelCall): ModelReply {
  const member = /Your identity: (.+?)\. Output quota:/.exec(call.messages[0]!.content)![1]!;
  const snapshot = JSON.parse(call.messages.find((message) => message.role === "user")!.content);
  const slots = snapshot.responseContract.byMember[member];
  const turn = structuredClone(slots.template);
  if (turn.phase === "opening") {
    turn.claims[0].statement = "Use the local proposal";
    turn.claims[0].rationale = "Independent supporting evidence";
    turn.answer.body = "An independent initial answer";
    turn.complexity = "simple";
    turn.complexityRationale = "One exchange can assess the proposal";
  } else if (turn.phase === "discussion") {
    turn.answer.body = "Use the local proposal after checking both viewpoints";
    turn.answer.basisVersionIds = slots.referenceSlots.activeBasisVersionIds;
    turn.readyToReview = true;
  } else
    for (const position of turn.positions) {
      position.stance = "accept";
      position.rationale = "Reviewed exact frozen version";
    }
  return {
    modelId: call.modelId,
    protocol: call.protocol,
    generationOptions: call.generationOptions,
    usage: {},
    finishReason: "stop",
    rawContent: JSON.stringify(turn),
    payload: turn
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-discussion-store-"));
});
afterEach(async () => {
  await Promise.all(children.map(kill));
  children = [];
  await rm(root, { recursive: true, force: true });
});

describe("FileDiscussionStore disk integrity and writers", () => {
  it("writes private atomic snapshots and permits exactly one concurrent CAS update", async () => {
    const store = new FileDiscussionStore(root),
      run = initial();
    await create(store, run);
    expect(JSON.parse(await readFile(join(root, "session-1", "session.json"), "utf8"))).toEqual(run);
    expect((await stat(join(root, "session-1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "session-1", "session.json"))).mode & 0o777).toBe(0o600);
    const reserved = appendDiscussionRunEvent(run, { type: "reserve_review", atMs: 0, reservationId: "r" });
    const paused = appendDiscussionRunEvent(run, { type: "paused", atMs: 0, code: "manual", message: "Stopped" });
    await store.withWriter("session-1", async (writer) => {
      const writes = await Promise.allSettled([writer.commit(0, reserved), writer.commit(0, paused)]);
      expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
    expect((await store.load("session-1")).revision).toBe(1);
    expect(await readdir(join(root, "session-1"))).toEqual(["session.json"]);
  });
  it("rejects event-prefix rewrite, initial configuration changes and escaped leases", async () => {
    const store = new FileDiscussionStore(root),
      run = initial();
    await create(store, run);
    const saved = appendDiscussionRunEvent(run, { type: "reserve_review", atMs: 0, reservationId: "r" });
    const rewritten = appendDiscussionRunEvent(
      appendDiscussionRunEvent(run, { type: "reserve_review", atMs: 0, reservationId: "changed" }),
      { type: "paused", atMs: 0, code: "x", message: "x" }
    );
    let escaped: DiscussionRunStore;
    await store.withWriter("session-1", async (writer) => {
      escaped = writer;
      await writer.commit(0, saved);
      await expect(writer.commit(1, rewritten)).rejects.toThrow(/append/);
      const changed = structuredClone(saved) as unknown as { initial: { members: { a: { modelId: string } } } };
      changed.initial.members.a.modelId = "changed";
      await expect(writer.commit(1, changed as unknown as DiscussionRun)).rejects.toThrow();
    });
    const paused = appendDiscussionRunEvent(saved, { type: "paused", atMs: 0, code: "x", message: "x" });
    await expect(escaped!.commit(1, paused)).rejects.toThrow(/lease/);
    expect(await store.load("session-1")).toEqual(saved);
  });
  it("ignores partial temp writes and rejects corrupt, unsupported or symlink snapshots without calls", async () => {
    const store = new FileDiscussionStore(root),
      run = initial();
    await create(store, run);
    const file = join(root, "session-1", "session.json");
    await writeFile(join(root, "session-1", ".session-partial.tmp"), "{bad");
    expect(await store.load("session-1")).toEqual(run);
    let calls = 0;
    for (const content of [
      "{bad",
      JSON.stringify({ ...run, runtimeVersion: "unsupported" }),
      JSON.stringify({ ...run, status: "completed" })
    ]) {
      await writeFile(file, content);
      await store.withWriter("session-1", async (writer) => {
        const engine = new DiscussionEngine(
          writer,
          {
            respond: async () => {
              calls++;
              throw new Error("No dispatch");
            }
          },
          { now: () => 0 }
        );
        await expect(engine.run("session-1")).rejects.toThrow(/Corrupt/);
      });
    }
    expect(calls).toBe(0);
    await unlink(file);
    await writeFile(join(root, "outside.json"), JSON.stringify(run));
    await symlink(join(root, "outside.json"), file);
    await expect(store.load("session-1")).rejects.toThrow();
    await expect(store.withWriter("../outside", async () => {})).rejects.toThrow();
  });
  it("rejects another process writer while live and reclaims the killed owner", async () => {
    const child = await crash("created"),
      store = new FileDiscussionStore(root);
    const contender = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { FileDiscussionStore } from ${JSON.stringify(storeModule)}; await new FileDiscussionStore(${JSON.stringify(root)}).withWriter("crash-test", async () => {});`
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    children.push(contender);
    let stderr = "";
    contender.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      contender.once("error", reject);
      contender.once("exit", resolve);
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/lock|writer|lease/i);
    await kill(child);
    await store.withWriter("crash-test", async (writer) => {
      const run = await writer.load("crash-test");
      await writer.commit(run.revision, appendDiscussionRunEvent(run, { type: "recovered", atMs: 1 }));
    });
    expect((await store.load("crash-test")).status).toBe("paused");
  });
});

describe("SIGKILL boundaries of real discussion execution", () => {
  it.each(["created", "prepared", "dispatch", "sealed", "commit_batch", "finalized"])(
    "recovers %s without automatic calls, duplicate commits or rewritten results",
    async (boundary) => {
      const child = await crash(boundary),
        store = new FileDiscussionStore(root);
      const before = await store.load("crash-test"),
        segmentBefore = currentDiscussionSegment(before);
      await kill(child);
      let calls = 0;
      const retryCalls: ModelCall[] = [];
      let recovered!: DiscussionRun;
      await store.withWriter("crash-test", async (writer) => {
        const engine = new DiscussionEngine(
          writer,
          {
            respond: async (call) => {
              calls++;
              retryCalls.push(structuredClone(call));
              return scripted(call);
            }
          },
          { now: () => 1 }
        );
        recovered = await engine.run("crash-test");
        expect(calls).toBe(0);
        const repeated = await engine.run("crash-test");
        expect(repeated).toEqual(recovered);
        expect(calls).toBe(0);
        if (boundary === "finalized") {
          expect(recovered).toEqual(before);
          expect(await engine.retry("crash-test")).toEqual(before);
          expect(calls).toBe(0);
        } else {
          const segment = currentDiscussionSegment(recovered);
          expect(recovered.status).toBe("paused");
          expect(segment.ledger.attempts.filter((attempt) => attempt.status === "pending")).toHaveLength(0);
          expect(segment.ledger.attempts.length).toBe(segmentBefore.ledger.attempts.length);
          expect(segment.seals).toEqual(segmentBefore.seals);
          expect(segment.jobs).toEqual(segmentBefore.jobs);
          for (const attempt of segmentBefore.ledger.attempts.filter((item) => item.status === "pending")) {
            expect(segment.ledger.attempts.find((item) => item.attemptId === attempt.attemptId)!.status).toBe(
              "unknown"
            );
          }
          const finished = await engine.retry("crash-test");
          expect(finished.events.slice(0, recovered.events.length)).toEqual(recovered.events);
          expect(currentDiscussionSegment(finished).protocol.committedBatches.map((batch) => batch.phase)).toEqual([
            "opening",
            "discussion",
            "review"
          ]);
          expect(finished.status).toBe("completed");
          expect(currentDiscussionSegment(finished).finalResult!.outcome).toBe("consensus");
          if (boundary === "sealed") {
            expect(calls).toBe(5);
            expect(retryCalls[0]).toEqual(
              segmentBefore.jobs.find((job) => !segmentBefore.seals.some((seal) => seal.jobId === job.jobId))!.call
            );
            expect(currentDiscussionSegment(finished).ledger.attempts).toHaveLength(7);
          }
          if (boundary === "prepared" || boundary === "dispatch") {
            expect(calls).toBe(6);
            expect(retryCalls.slice(0, 2)).toEqual(segmentBefore.jobs.map((job) => job.call));
            expect(currentDiscussionSegment(finished).ledger.attempts).toHaveLength(8);
          }
          if (boundary === "commit_batch") {
            expect(calls).toBe(4);
            expect(currentDiscussionSegment(finished).ledger.attempts).toHaveLength(6);
          }
          if (boundary === "created") expect(calls).toBe(6);
        }
      });
      const disk = await store.load("crash-test");
      expect(disk.status).toBe("completed");
      if (boundary === "finalized") expect(disk).toEqual(before);
    },
    30000
  );
});
