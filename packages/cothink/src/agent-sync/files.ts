import { constants, appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { lstat, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export async function readJson(path: string): Promise<unknown> {
  if ((await realpath(path)) !== resolve(path)) throw Error("SYNC_PATH_ALIAS");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw Error("SYNC_FILE_INVALID");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
export async function saveJson(path: string, value: unknown) {
  const next = path + "." + randomUUID();
  await writeFile(next, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(next, path);
}
export function recordEvent(root: string, event: Record<string, unknown>) {
  const fd = openSync(
    join(root, "events.jsonl"),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    appendFileSync(fd, JSON.stringify({ ...event, at: Date.now() }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Only explicit recovery may remove a demonstrably dead local caller's lock. */
export async function lockCaller(root: string, recover: boolean, operation: string): Promise<() => Promise<void>> {
  const path = join(root, "caller.lock");
  // Serialize stale-lock inspection: two recoveries must not unlink a newly acquired lock.
  const guardPath = join(root, "recovery.lock");
  const guard = recover
    ? await open(guardPath, "wx", 0o600).catch(() => {
        throw Error("SYNC_CALLER_BUSY");
      })
    : undefined;
  let lock;
  try {
    if (recover && (await exists(path))) {
      const old = (await readJson(path)) as { pid?: number };
      if (!Number.isSafeInteger(old.pid) || old.pid! < 1) throw Error("SYNC_CALLER_BUSY");
      try {
        process.kill(old.pid!, 0);
        throw Error("SYNC_CALLER_BUSY");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await unlink(path);
    }
    lock = await open(path, "wx", 0o600).catch(() => {
      throw Error("SYNC_CALLER_BUSY");
    });
    await lock.writeFile(JSON.stringify({ pid: process.pid, operation }));
  } finally {
    if (guard) {
      await guard.close();
      await unlink(guardPath);
    }
  }
  return async () => {
    await lock.close();
    await unlink(path);
  };
}
