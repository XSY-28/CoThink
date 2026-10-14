import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSnapshotStore, type SnapshotCodec, type SnapshotWriter } from "../../src/storage/snapshot-store.js";

const sourceModule = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/storage/snapshot-store.ts")
).href;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-snapshot-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function storageContract<State>(
  codec: SnapshotCodec<State>,
  initial: State,
  advance: (state: State) => State,
  changedIdentity: State,
  changedImmutable: State
) {
  describe(`FileSnapshotStore with ${codec.formatName} codec`, () => {
    const sessionId = "stored-session";
    const create = async (store: FileSnapshotStore<State>) => {
      await store.withWriter(sessionId, async (writer) => writer.commit(-1, initial));
    };

    it("persists a private snapshot and permits only one overlapping CAS update", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      expect(JSON.parse(await readFile(join(root, sessionId, "session.json"), "utf8"))).toEqual(initial);
      expect((await stat(join(root, sessionId))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, sessionId, "session.json"))).mode & 0o777).toBe(0o600);
      await store.withWriter(sessionId, async (writer) => {
        const result = await Promise.allSettled([
          writer.commit(0, advance(initial)),
          writer.commit(0, advance(initial))
        ]);
        expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
      });
      expect(codec.revision(await store.load(sessionId))).toBe(1);
      expect(await readdir(join(root, sessionId))).toEqual(["session.json"]);
    });

    it("rejects invalid state, identity, revision and domain transition without replacing the snapshot", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      await store.withWriter(sessionId, async (writer) => {
        await expect(writer.commit(0, {} as State)).rejects.toThrow();
        await expect(writer.commit(0, changedIdentity)).rejects.toThrow(/identity/);
        await expect(writer.commit(0, initial)).rejects.toThrow(/advance by one/);
        await expect(writer.commit(0, changedImmutable)).rejects.toThrow(/immutable/);
        await expect(writer.commit(-1, initial)).rejects.toThrow(/already exists/);
        await expect(writer.load("another-session")).rejects.toThrow(/another/);
      });
      expect(await store.load(sessionId)).toEqual(initial);
    });

    it("rejects a live contender and denies an escaped writer after its lease ends", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      let escaped: SnapshotWriter<State> | undefined;
      await store.withWriter(sessionId, async (writer) => {
        escaped = writer;
        await expect(new FileSnapshotStore(root, codec).withWriter(sessionId, async () => {})).rejects.toThrow(/held/);
      });
      await expect(escaped!.load(sessionId)).rejects.toThrow(/lease has ended/);
      await expect(escaped!.commit(0, advance(initial))).rejects.toThrow(/lease has ended/);
      expect(await store.load(sessionId)).toEqual(initial);
    });

    it("refuses malformed lock ownership without changing the authoritative snapshot", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      const lockPath = join(root, sessionId, ".writer.lock");
      await writeFile(lockPath, "{unknown");
      await expect(store.withWriter(sessionId, async () => {})).rejects.toThrow(/Unknown/);
      expect(await readFile(lockPath, "utf8")).toBe("{unknown");
      expect(await store.load(sessionId)).toEqual(initial);
    });

    it("denies writes when the disk lease nonce changes during a callback", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      const lockPath = join(root, sessionId, ".writer.lock");
      await store.withWriter(sessionId, async (writer) => {
        const ownedLock = await readFile(lockPath, "utf8");
        const changedLock = JSON.stringify({ pid: process.pid, nonce: "00000000-0000-0000-0000-000000000000" });
        try {
          await writeFile(lockPath, changedLock);
          await expect(writer.load(sessionId)).rejects.toThrow(/lease was lost/);
          await expect(writer.commit(0, advance(initial))).rejects.toThrow(/lease was lost/);
          expect(await store.load(sessionId)).toEqual(initial);
        } finally {
          await writeFile(lockPath, ownedLock);
        }
      });
    });

    it("fails closed on authoritative corruption and identity mismatch, ignoring incomplete temporary writes", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      await writeFile(join(root, sessionId, ".session-partial.tmp"), "{partial");
      expect(await store.load(sessionId)).toEqual(initial);
      for (const bad of ["{invalid", JSON.stringify({ invalid: true }), JSON.stringify(changedIdentity)]) {
        await writeFile(join(root, sessionId, "session.json"), bad);
        await expect(store.load(sessionId)).rejects.toThrow(/Corrupt/);
        await expect(store.withWriter(sessionId, async (writer) => writer.commit(0, advance(initial)))).rejects.toThrow(
          /Corrupt/
        );
        expect(await readFile(join(root, sessionId, "session.json"), "utf8")).toBe(bad);
      }
    });

    it("recovers a killed process lease from disk and resumes through the supplied codec", async () => {
      const store = new FileSnapshotStore(root, codec);
      await create(store);
      // The child holds the real disk lease; the parent remains responsible for
      // the format validator when it loads and commits after the crash.
      const script = `
import { FileSnapshotStore } from ${JSON.stringify(sourceModule)};
const codec = { formatName: "crash-fixture", parse: value => value, sessionId: () => "stored-session", revision: () => 0, validateTransition: () => {} };
await new FileSnapshotStore(${JSON.stringify(root)}, codec).withWriter("stored-session", async () => {
  process.stdout.write("LOCKED\\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});`;
      const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.stdout!.once("data", (data: Buffer) =>
            data.toString().includes("LOCKED") ? resolve() : reject(new Error("child did not lock"))
          );
          child.once("exit", () => reject(new Error(`child exited before lock: ${stderr}`)));
        });
        await expect(store.withWriter(sessionId, async () => {})).rejects.toThrow(/held/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
      // A recovery lock left by another reclaimer is never automatically stolen.
      const recoveryPath = join(root, sessionId, ".recovery.lock");
      await writeFile(recoveryPath, "inspect this stale recovery lock");
      await expect(store.withWriter(sessionId, async () => {})).rejects.toThrow(/recovery is locked/);
      expect(await readFile(recoveryPath, "utf8")).toBe("inspect this stale recovery lock");
      expect(await store.load(sessionId)).toEqual(initial);
      await unlink(recoveryPath);
      await store.withWriter(sessionId, async (writer) => {
        expect(await writer.load(sessionId)).toEqual(initial);
        await writer.commit(0, advance(initial));
      });
      expect(await store.load(sessionId)).toEqual(advance(initial));
      expect(await readdir(join(root, sessionId))).toEqual(["session.json"]);
    });
  });
}

const firstSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string(),
    revision: z.number().int().nonnegative(),
    policy: z.string(),
    body: z.string()
  })
  .strict();
type First = z.infer<typeof firstSchema>;
const first: First = {
  schemaVersion: 1,
  sessionId: "stored-session",
  revision: 0,
  policy: "frozen",
  body: "First format"
};
storageContract<First>(
  {
    formatName: "first",
    parse: (value) => firstSchema.parse(value),
    sessionId: (state) => state.sessionId,
    revision: (state) => state.revision,
    validateTransition: (next, current) => {
      if (current && next.policy !== current.policy) throw new Error("First policy is immutable");
    }
  },
  first,
  (state) => ({ ...state, revision: state.revision + 1 }),
  { ...first, sessionId: "changed", revision: 1 },
  { ...first, policy: "changed", revision: 1 }
);

const secondSchema = z
  .object({
    format: z.literal("second-v2"),
    identity: z.object({ id: z.string(), scope: z.string() }).strict(),
    version: z.number().int().nonnegative(),
    value: z.string()
  })
  .strict();
type Second = z.infer<typeof secondSchema>;
const second: Second = {
  format: "second-v2",
  identity: { id: "stored-session", scope: "frozen" },
  version: 0,
  value: "Second format"
};
storageContract<Second>(
  {
    formatName: "second",
    parse: (value) => secondSchema.parse(value),
    sessionId: (state) => state.identity.id,
    revision: (state) => state.version,
    validateTransition: (next, current) => {
      if (current && next.identity.scope !== current.identity.scope) throw new Error("Second scope is immutable");
    }
  },
  second,
  (state) => ({ ...state, version: state.version + 1 }),
  { ...second, identity: { ...second.identity, id: "changed" }, version: 1 },
  { ...second, identity: { ...second.identity, scope: "changed" }, version: 1 }
);
