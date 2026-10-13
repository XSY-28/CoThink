import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PeerSessionSchema, type PeerSession, type PeerStore } from "@onevcat/argue";

const SESSION_FILE = "session.json";
const WRITER_LOCK = ".writer.lock";
const RECOVERY_LOCK = ".recovery.lock";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type LockRecord = { pid: number; nonce: string };

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid peer session ID");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Peer store path must be a real directory");
}

async function readRegularFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Peer store file must be regular");
    return await file.readFile({ encoding: "utf8" });
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseLock(text: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Unknown peer writer lock owner");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "nonce,pid" ||
    typeof (value as LockRecord).pid !== "number" ||
    !Number.isSafeInteger((value as LockRecord).pid) ||
    (value as LockRecord).pid < 1 ||
    typeof (value as LockRecord).nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test((value as LockRecord).nonce)
  )
    throw new Error("Unknown peer writer lock owner");
  return value as LockRecord;
}

async function readLock(path: string): Promise<LockRecord> {
  return parseLock(await readRegularFile(path));
}

function ownerIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return true;
    return false;
  }
}

async function createLock(path: string, record: LockRecord): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(join(path, ".."));
}

async function releaseLock(path: string, nonce: string): Promise<void> {
  const current = await readLock(path);
  if (current.pid !== process.pid || current.nonce !== nonce) throw new Error("Peer writer lease was lost");
  await unlink(path);
  await syncDirectory(join(path, ".."));
}

async function acquireWriter(directory: string): Promise<LockRecord> {
  const writerPath = join(directory, WRITER_LOCK);
  const record = { pid: process.pid, nonce: randomUUID() };
  try {
    await createLock(writerPath, record);
    return record;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const previous = await readLock(writerPath);
  if (!ownerIsDead(previous.pid)) throw new Error("Peer writer lock is held or owner liveness is unknown");

  // The recovery lock is deliberately not stolen. An abandoned or malformed
  // recovery lock needs inspection: automatic removal would race another reclaimer.
  const recoveryPath = join(directory, RECOVERY_LOCK);
  const recovery = { pid: process.pid, nonce: randomUUID() };
  try {
    await createLock(recoveryPath, recovery);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw new Error("Peer writer recovery is locked; inspect stale recovery lock");
    throw error;
  }
  try {
    const current = await readLock(writerPath);
    if (current.nonce !== previous.nonce || current.pid !== previous.pid || !ownerIsDead(current.pid))
      throw new Error("Peer writer lock changed during recovery");
    await unlink(writerPath);
    await syncDirectory(directory);
    await createLock(writerPath, record);
    return record;
  } finally {
    await releaseLock(recoveryPath, recovery.nonce);
  }
}

async function readSnapshot(directory: string, sessionId: string): Promise<PeerSession> {
  let raw: string;
  try {
    raw = await readRegularFile(join(directory, SESSION_FILE));
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new Error(`Peer session does not exist: ${sessionId}`);
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Corrupt authoritative peer snapshot");
  }
  const parsed = PeerSessionSchema.safeParse(data);
  if (!parsed.success || parsed.data.config.sessionId !== sessionId)
    throw new Error("Corrupt authoritative peer snapshot");
  return parsed.data;
}

async function writeSnapshot(directory: string, state: PeerSession): Promise<void> {
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
    await file.close();
    await rename(temporary, join(directory, SESSION_FILE));
    await syncDirectory(directory);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateSources(next: PeerSession, current?: PeerSession): void {
  const oldSources = current?.sources ?? [];
  if (next.sources.length < oldSources.length) throw new Error("Existing peer sources cannot be removed");
  for (let index = 0; index < oldSources.length; index++) {
    if (!isDeepStrictEqual(oldSources[index], next.sources[index]))
      throw new Error("Existing peer sources cannot be changed or reordered");
  }
  if (new Set(next.sources.map((source) => source.sourceId)).size !== next.sources.length)
    throw new Error("Peer source IDs must be unique");
  if (next.sources.reduce((total, source) => total + source.content.length, 0) > next.config.limits.maxSourceCharacters)
    throw new Error("Peer source character limit exceeded");
  for (const source of next.sources) {
    const hash = `sha256:${createHash("sha256").update(source.content, "utf8").digest("hex")}`;
    if (source.contentHash !== hash || source.lineCount !== source.content.split("\n").length)
      throw new Error("Peer source content metadata does not match the copy");
  }
  const newSources = next.sources.slice(oldSources.length);
  for (const source of newSources) {
    const targetSegment = current ? next.currentSegmentId : 1;
    if (
      source.segmentId !== targetSegment ||
      (current && targetSegment <= current.currentSegmentId) ||
      !next.segments.some((segment) => segment.segmentId === targetSegment)
    )
      throw new Error("New peer sources must belong to a new current segment");
  }
}

/** Disk-backed peer sessions. Only withWriter's callback receives mutation authority. */
export class FilePeerStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async load(sessionId: string): Promise<PeerSession> {
    validateSessionId(sessionId);
    await assertDirectory(this.root);
    const directory = join(this.root, sessionId);
    await assertDirectory(directory);
    return readSnapshot(directory, sessionId);
  }

  async withWriter<T>(sessionId: string, callback: (store: PeerStore) => Promise<T>): Promise<T> {
    validateSessionId(sessionId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectory(this.root);
    const directory = join(this.root, sessionId);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isErrno(error, "EEXIST")) throw error;
    });
    await assertDirectory(directory);
    const lease = await acquireWriter(directory);
    let active = true;
    const ensureLease = async () => {
      if (!active) throw new Error("Peer writer lease has ended");
      const current = await readLock(join(directory, WRITER_LOCK));
      if (current.pid !== lease.pid || current.nonce !== lease.nonce) throw new Error("Peer writer lease was lost");
    };
    let operation = Promise.resolve();
    const serialize = <T>(run: () => Promise<T>): Promise<T> => {
      const result = operation.then(run);
      operation = result.then(
        () => {},
        () => {}
      );
      return result;
    };
    const store: PeerStore = {
      load: (requestedId) =>
        serialize(async () => {
          if (requestedId !== sessionId) throw new Error("Writer lease belongs to another peer session");
          await ensureLease();
          return readSnapshot(directory, sessionId);
        }),
      commit: (expectedRevision, next) =>
        serialize(async () => {
          await ensureLease();
          const validated = PeerSessionSchema.parse(next);
          if (validated.config.sessionId !== sessionId) throw new Error("Peer session identity cannot change");
          if (
            !Number.isInteger(expectedRevision) ||
            expectedRevision < -1 ||
            validated.revision !== expectedRevision + 1
          )
            throw new Error("Peer snapshot revision must advance by one");
          let current: PeerSession | undefined;
          try {
            current = await readSnapshot(directory, sessionId);
          } catch (error) {
            if (!(error instanceof Error && error.message === `Peer session does not exist: ${sessionId}`)) throw error;
          }
          if (expectedRevision === -1) {
            if (current) throw new Error("Peer session already exists");
          } else {
            if (!current || current.revision !== expectedRevision) throw new Error("Peer snapshot revision conflict");
            if (!isDeepStrictEqual(current.config, validated.config))
              throw new Error("Peer session config is immutable");
          }
          validateSources(validated, current);
          await writeSnapshot(directory, validated);
        })
    };
    try {
      return await callback(store);
    } finally {
      await operation;
      active = false;
      await releaseLock(join(directory, WRITER_LOCK), lease.nonce);
    }
  }
}
