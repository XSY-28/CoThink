import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const SESSION_FILE = "session.json";
const WRITER_LOCK = ".writer.lock";
const RECOVERY_LOCK = ".recovery.lock";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The format owns parsing and domain invariants; the store owns disk and CAS. */
export interface SnapshotCodec<State> {
  readonly formatName: string;
  parse(value: unknown): State;
  sessionId(state: State): string;
  revision(state: State): number;
  validateTransition(next: State, current?: State): void;
}

export interface SnapshotWriter<State> {
  /** Verify the current disk lease without reading or parsing domain state. */
  assertOwner(): Promise<void>;
  load(sessionId: string): Promise<State>;
  commit(expectedRevision: number, state: State): Promise<void>;
}

type LockRecord = { pid: number; nonce: string };

function title(formatName: string): string {
  return formatName.charAt(0).toUpperCase() + formatName.slice(1);
}

function validateSessionId(sessionId: string, formatName: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid ${formatName} session ID`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function assertDirectory(path: string, formatName: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${title(formatName)} store path must be a real directory`);
}

async function readRegularFile(path: string, formatName: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${title(formatName)} store file must be regular`);
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

function parseLock(text: string, formatName: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Unknown ${formatName} writer lock owner`);
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
    throw new Error(`Unknown ${formatName} writer lock owner`);
  return value as LockRecord;
}

async function readLock(path: string, formatName: string): Promise<LockRecord> {
  return parseLock(await readRegularFile(path, formatName), formatName);
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

async function releaseLock(path: string, nonce: string, formatName: string): Promise<void> {
  const current = await readLock(path, formatName);
  if (current.pid !== process.pid || current.nonce !== nonce)
    throw new Error(`${title(formatName)} writer lease was lost`);
  await unlink(path);
  await syncDirectory(join(path, ".."));
}

async function acquireWriter(directory: string, formatName: string): Promise<LockRecord> {
  const writerPath = join(directory, WRITER_LOCK);
  const record = { pid: process.pid, nonce: randomUUID() };
  try {
    await createLock(writerPath, record);
    return record;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const previous = await readLock(writerPath, formatName);
  if (!ownerIsDead(previous.pid))
    throw new Error(`${title(formatName)} writer lock is held or owner liveness is unknown`);

  // The recovery lock is deliberately not stolen. An abandoned or malformed
  // recovery lock needs inspection: automatic removal would race another reclaimer.
  const recoveryPath = join(directory, RECOVERY_LOCK);
  const recovery = { pid: process.pid, nonce: randomUUID() };
  try {
    await createLock(recoveryPath, recovery);
  } catch (error) {
    if (isErrno(error, "EEXIST"))
      throw new Error(`${title(formatName)} writer recovery is locked; inspect stale recovery lock`);
    throw error;
  }
  try {
    const current = await readLock(writerPath, formatName);
    if (current.nonce !== previous.nonce || current.pid !== previous.pid || !ownerIsDead(current.pid))
      throw new Error(`${title(formatName)} writer lock changed during recovery`);
    await unlink(writerPath);
    await syncDirectory(directory);
    await createLock(writerPath, record);
    return record;
  } finally {
    await releaseLock(recoveryPath, recovery.nonce, formatName);
  }
}

async function readSnapshot<State>(directory: string, sessionId: string, codec: SnapshotCodec<State>): Promise<State> {
  const formatName = codec.formatName;
  let raw: string;
  try {
    raw = await readRegularFile(join(directory, SESSION_FILE), formatName);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new Error(`${title(formatName)} session does not exist: ${sessionId}`);
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt authoritative ${formatName} snapshot`);
  }
  let parsed: State;
  try {
    parsed = codec.parse(data);
  } catch (error) {
    // Preserve the format validator's reason (including an unsupported version)
    // instead of making a routed load look like a different format's snapshot.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Corrupt authoritative ${formatName} snapshot: ${reason}`, { cause: error });
  }
  if (codec.sessionId(parsed) !== sessionId) throw new Error(`Corrupt authoritative ${formatName} snapshot`);
  return parsed;
}

async function writeSnapshot<State>(directory: string, state: State): Promise<void> {
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

/** Atomic snapshots and writer leases, independent of any session format. */
export class FileSnapshotStore<State> {
  private readonly root: string;
  private readonly codec: SnapshotCodec<State>;

  constructor(root: string, codec: SnapshotCodec<State>) {
    this.root = root;
    this.codec = codec;
  }

  async load(sessionId: string): Promise<State> {
    const formatName = this.codec.formatName;
    validateSessionId(sessionId, formatName);
    await assertDirectory(this.root, formatName);
    const directory = join(this.root, sessionId);
    await assertDirectory(directory, formatName);
    return readSnapshot(directory, sessionId, this.codec);
  }

  async withWriter<T>(sessionId: string, callback: (store: SnapshotWriter<State>) => Promise<T>): Promise<T> {
    const formatName = this.codec.formatName;
    validateSessionId(sessionId, formatName);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectory(this.root, formatName);
    const directory = join(this.root, sessionId);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isErrno(error, "EEXIST")) throw error;
    });
    await assertDirectory(directory, formatName);
    const lease = await acquireWriter(directory, formatName);
    let active = true;
    const ensureLease = async () => {
      if (!active) throw new Error(`${title(formatName)} writer lease has ended`);
      const current = await readLock(join(directory, WRITER_LOCK), formatName);
      if (current.pid !== lease.pid || current.nonce !== lease.nonce)
        throw new Error(`${title(formatName)} writer lease was lost`);
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
    const store: SnapshotWriter<State> = {
      assertOwner: () => serialize(ensureLease),
      load: (requestedId) =>
        serialize(async () => {
          if (requestedId !== sessionId) throw new Error(`Writer lease belongs to another ${formatName} session`);
          await ensureLease();
          return readSnapshot(directory, sessionId, this.codec);
        }),
      commit: (expectedRevision, next) =>
        serialize(async () => {
          await ensureLease();
          const validated = this.codec.parse(next);
          if (this.codec.sessionId(validated) !== sessionId)
            throw new Error(`${title(formatName)} session identity cannot change`);
          if (
            !Number.isInteger(expectedRevision) ||
            expectedRevision < -1 ||
            this.codec.revision(validated) !== expectedRevision + 1
          )
            throw new Error(`${title(formatName)} snapshot revision must advance by one`);
          let current: State | undefined;
          try {
            current = await readSnapshot(directory, sessionId, this.codec);
          } catch (error) {
            if (
              !(error instanceof Error && error.message === `${title(formatName)} session does not exist: ${sessionId}`)
            )
              throw error;
          }
          if (expectedRevision === -1) {
            if (current) throw new Error(`${title(formatName)} session already exists`);
          } else {
            if (!current || this.codec.revision(current) !== expectedRevision)
              throw new Error(`${title(formatName)} snapshot revision conflict`);
          }
          this.codec.validateTransition(validated, current);
          await writeSnapshot(directory, validated);
        })
    };
    try {
      return await callback(store);
    } finally {
      await operation;
      active = false;
      await releaseLock(join(directory, WRITER_LOCK), lease.nonce, formatName);
    }
  }
}
