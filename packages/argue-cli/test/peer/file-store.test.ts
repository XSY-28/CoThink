import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPeerSession, type ContextSourceInput, type PeerSession } from "@onevcat/argue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePeerStore } from "../../src/peer/file-store.js";

// Subprocesses exercise the built adapter: native Node cannot resolve the .js
// imports in the TypeScript source graph. Build before running these tests.
const sourceModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../dist/peer/file-store.js")).href;
const driverModule = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../../../argue/src/peer/driver.ts")
).href;
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
let root: string;

function session(sessionId = "session-1", sources: ContextSourceInput[] = []): PeerSession {
  return createPeerSession(
    {
      sessionId,
      schemaVersion: 1,
      question: "Should we adopt the proposal?",
      sourceCommit: "abc123",
      createdAt: "2026-10-13T00:00:00.000Z",
      members: {
        "member-a": {
          protocol: "openai-compatible",
          baseUrl: "https://example.test/v1",
          modelId: "model-a",
          apiKeyEnv: "TEST_A_KEY",
          outputMode: "json_object",
          generationOptions: {}
        },
        "member-b": {
          protocol: "openai-compatible",
          baseUrl: "https://example.test/v1",
          modelId: "model-b",
          apiKeyEnv: "TEST_B_KEY",
          outputMode: "json_object",
          generationOptions: {}
        }
      }
    },
    sources
  );
}

function continuedWithSource(initial: PeerSession): PeerSession {
  return {
    ...initial,
    revision: initial.revision + 1,
    currentSegmentId: 2,
    segments: [
      { ...initial.segments[0]!, status: "completed" },
      { ...initial.segments[0]!, segmentId: 2, phase: "discussion", roundIndex: 1, status: "active" }
    ],
    sources: [
      ...initial.sources,
      {
        sourceId: "src-3",
        content: "abc",
        contentHash: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        lineCount: 1,
        segmentId: 2
      }
    ]
  };
}

async function create(store: FilePeerStore, state = session()) {
  await store.withWriter(state.config.sessionId, async (writer) => writer.commit(-1, state));
}

function childScript(body: string) {
  return `import { FilePeerStore } from ${JSON.stringify(sourceModule)};\nconst store = new FilePeerStore(${JSON.stringify(root)});\n${body}`;
}

function runChild(body: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(body)], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

async function startHoldingChild(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      childScript(
        `await store.withWriter("session-1", async (writer) => { const old = await writer.load("session-1"); await writer.commit(0, { ...old, revision: 1 }); process.stdout.write("LOCKED\\n"); setInterval(() => {}, 1000); await new Promise(() => {}); });`
      )
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (data: Buffer) =>
      data.toString().includes("LOCKED") ? resolve() : reject(new Error("child did not lock"))
    );
    child.once("exit", () => reject(new Error(`child exited before lock: ${stderr}`)));
  });
  return child;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "argue-peer-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FilePeerStore", () => {
  it("creates a private authoritative snapshot and advances only with a matching revision", async () => {
    const store = new FilePeerStore(root);
    const initial = session();
    await create(store, initial);
    const disk = await readFile(join(root, "session-1", "session.json"), "utf8");
    expect(JSON.parse(disk)).toEqual(initial);
    expect(await store.load("session-1")).toEqual(initial);
    expect((await stat(join(root, "session-1"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "session-1", "session.json"))).mode & 0o777).toBe(0o600);
    await store.withWriter("session-1", async (writer) => {
      const next = { ...initial, revision: 1, status: "paused" as const };
      await writer.commit(0, next);
      await expect(writer.commit(0, { ...next, revision: 1 })).rejects.toThrow();
    });
    expect((await store.load("session-1")).revision).toBe(1);
    expect((await readdir(join(root, "session-1"))).sort()).toEqual(["session.json"]);
  });

  it("refuses mutation without a writer lease and rejects changed provider identity", async () => {
    const store = new FilePeerStore(root);
    const initial = session();
    await create(store, initial);
    let escapedWriter: Parameters<Parameters<FilePeerStore["withWriter"]>[1]>[0] | undefined;
    await store.withWriter("session-1", async (writer) => {
      escapedWriter = writer;
      const changed = structuredClone(initial);
      changed.revision = 1;
      changed.config.members["member-a"].modelId = "swapped";
      await expect(writer.commit(0, changed)).rejects.toThrow();
    });
    await expect(escapedWriter!.commit(0, { ...initial, revision: 1 })).rejects.toThrow(/lease/);
    expect(await store.load("session-1")).toEqual(initial);
  });

  it("allows only one same-revision commit even when calls overlap inside a lease", async () => {
    const store = new FilePeerStore(root);
    const initial = session();
    await create(store, initial);
    await store.withWriter("session-1", async (writer) => {
      const results = await Promise.allSettled([
        writer.commit(0, { ...initial, revision: 1, status: "paused" }),
        writer.commit(0, { ...initial, revision: 1, status: "completed" })
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
    expect((await store.load("session-1")).revision).toBe(1);
  });

  it("appends verified evidence for a newly created segment without altering old sources", async () => {
    const store = new FilePeerStore(root);
    const initial = session("session-1", [
      { sourceId: "src-1", content: "Original", segmentId: 1 },
      { sourceId: "src-2", content: "More", segmentId: 1 }
    ]);
    await create(store, initial);
    const continued = continuedWithSource(initial);
    await store.withWriter("session-1", async (writer) => writer.commit(0, continued));
    expect((await store.load("session-1")).sources).toEqual(continued.sources);
  });

  it("rejects source edits, removal, reorder, reused IDs, bad metadata, and wrong segment", async () => {
    const store = new FilePeerStore(root);
    const initial = session("session-1", [
      { sourceId: "src-1", content: "Original", segmentId: 1 },
      { sourceId: "src-2", content: "More", segmentId: 1 }
    ]);
    await create(store, initial);
    const continued = continuedWithSource(initial);
    const altered = [
      { ...continued, sources: [{ ...continued.sources[0]!, content: "edited" }, ...continued.sources.slice(1)] },
      { ...continued, sources: continued.sources.slice(1) },
      { ...continued, sources: [continued.sources[1]!, continued.sources[0]!, continued.sources[2]!] },
      { ...continued, sources: [...initial.sources, { ...continued.sources[2]!, sourceId: "src-1" }] },
      { ...continued, sources: [...initial.sources, { ...continued.sources[2]!, contentHash: "sha256:wrong" }] },
      { ...continued, sources: [...initial.sources, { ...continued.sources[2]!, lineCount: 2 }] },
      { ...continued, sources: [...initial.sources, { ...continued.sources[2]!, segmentId: 1 }] }
    ];
    const oversizedContent = "a".repeat(20_000);
    const oversized = {
      ...continued,
      sources: [
        ...initial.sources,
        {
          ...continued.sources[2]!,
          content: oversizedContent,
          contentHash: `sha256:${createHash("sha256").update(oversizedContent).digest("hex")}`
        }
      ]
    };
    await store.withWriter("session-1", async (writer) => {
      for (const candidate of altered) await expect(writer.commit(0, candidate)).rejects.toThrow();
      await expect(writer.commit(0, oversized)).rejects.toThrow(/limit/);
    });
    expect(await store.load("session-1")).toEqual(initial);
  });

  it("rejects traversal IDs and a symlink session directory", async () => {
    const store = new FilePeerStore(root);
    await expect(store.load("../outside")).rejects.toThrow();
    await expect(store.withWriter("a/b", async () => {})).rejects.toThrow();
    await symlink(tmpdir(), join(root, "linked"));
    await expect(store.withWriter("linked", async () => {})).rejects.toThrow();
  });

  it("ignores a partial temporary write but fails closed on a corrupt authoritative snapshot", async () => {
    const store = new FilePeerStore(root);
    const initial = session();
    await create(store, initial);
    await writeFile(join(root, "session-1", ".session-ghost.tmp"), "{bad");
    expect(await store.load("session-1")).toEqual(initial);
    await writeFile(join(root, "session-1", "session.json"), "{bad");
    await expect(store.load("session-1")).rejects.toThrow();
  });

  it("rejects schema-invalid and symlinked authoritative snapshots", async () => {
    const store = new FilePeerStore(root);
    const initial = session();
    await create(store, initial);
    const snapshotPath = join(root, "session-1", "session.json");
    await writeFile(snapshotPath, JSON.stringify({ ...initial, unexpected: true }));
    await expect(store.load("session-1")).rejects.toThrow(/Corrupt/);
    await unlink(snapshotPath);
    const otherPath = join(root, "other.json");
    await writeFile(otherPath, JSON.stringify(initial));
    await symlink(otherPath, snapshotPath);
    await expect(store.load("session-1")).rejects.toThrow();
  });

  it("refuses a second process while the owner is alive and recovers a killed owner's lease", async () => {
    const store = new FilePeerStore(root);
    await create(store);
    const child = await startHoldingChild();
    try {
      expect((await store.load("session-1")).revision).toBe(1);
      const contender = await runChild(`await store.withWriter("session-1", async () => {});`);
      expect(contender.code).not.toBe(0);
      expect(contender.stderr).toMatch(/lock|lease|writer/i);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    await store.withWriter("session-1", async (writer) => {
      const loaded = await writer.load("session-1");
      await writer.commit(1, { ...loaded, revision: 2 });
    });
    expect((await store.load("session-1")).revision).toBe(2);
  });

  it("fails closed for an unreadable lock owner and preserves the snapshot", async () => {
    const store = new FilePeerStore(root);
    await create(store);
    await writeFile(join(root, "session-1", ".writer.lock"), "{bad");
    await expect(store.withWriter("session-1", async () => {})).rejects.toThrow();
    expect((await store.load("session-1")).revision).toBe(0);
  });

  it("recovers killed driver intents as unknown without automatic re-dispatch", async () => {
    const store = new FilePeerStore(root);
    const initial = session();
    await create(store, initial);
    const childFile = join(root, "run-driver.ts");
    await writeFile(
      childFile,
      `
import { FilePeerStore } from ${JSON.stringify(sourceModule)};
import { PeerSessionDriver } from ${JSON.stringify(driverModule)};
const store = new FilePeerStore(${JSON.stringify(root)});
await store.withWriter("session-1", async (writer) => {
  const hanging = { respond: async () => new Promise(() => {}) };
  const driver = new PeerSessionDriver(writer, { "member-a": hanging, "member-b": hanging }, {
    now: () => new Date("2026-10-13T00:00:01.000Z"),
    onCommitted: (state) => { if (state.attempts.length === 2) process.stdout.write("INTENTS\\n"); }
  });
  await driver.run("session-1");
});
`
    );
    const child = spawn(
      join(repositoryRoot, "node_modules/.bin/vite-node"),
      ["--script", "-c", join(repositoryRoot, "packages/argue-cli/vitest.config.ts"), childFile],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
          if (chunk.includes("INTENTS")) resolve();
        });
        child.once("exit", () => reject(new Error(`driver exited before intent: ${stderr}`)));
      });
      const persisted = await store.load("session-1");
      expect(persisted.attempts).toHaveLength(2);
      expect(persisted.attempts.every((attempt) => attempt.status === "running")).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    let calls = 0;
    await store.withWriter("session-1", async (writer) => {
      const { PeerSessionDriver } = await import("@onevcat/argue");
      const runtime = {
        respond: async () => {
          calls++;
          throw new Error("must not dispatch");
        }
      };
      const driver = new PeerSessionDriver(
        writer,
        { "member-a": runtime, "member-b": runtime },
        {
          now: () => new Date("2026-10-13T00:00:02.000Z")
        }
      );
      const recovered = await driver.run("session-1");
      expect(recovered.status).toBe("paused");
      expect(recovered.attempts.every((attempt) => attempt.status === "unknown")).toBe(true);
    });
    expect(calls).toBe(0);
    expect((await store.load("session-1")).attempts.every((attempt) => attempt.acceptance === "invalidated")).toBe(
      true
    );
  });
});
