import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SnapshotProject, ManagedState, ManagedWriter } from "./storage-types.js";
import { validateCommittedAssets } from "./committed-metadata.js";
import type { GitSnapshotFile } from "./git-snapshots.js";

export interface ExportOptions {
  /** Host-controlled fault boundary. Never supplied by a model action. */
  beforeRename?: () => Promise<void>;
  beforeParentSync?: () => Promise<void>;
}
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
const inside = (path: string, root: string) => {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
function knownAccepted(state: ManagedState<SnapshotProject>, version: string): boolean {
  return state.acceptedVersion === version || state.publishReceipts.some((r) => r.acceptedVersion === version);
}

async function safeParent(
  writer: Pick<ManagedWriter<SnapshotProject, ManagedState<SnapshotProject>>, "controlRoot" | "assertOwner">,
  target: string,
  allowExisting = false
): Promise<string> {
  if (!isAbsolute(target) || resolve(target) !== target || target === dirname(target))
    throw new Error("Build export target must be absolute and canonical");
  if ([".cothink-build", ".agent-sync"].includes(basename(target).toLowerCase()))
    throw new Error("Build export target overlaps a control directory");
  if (inside(target, writer.controlRoot) || inside(writer.controlRoot, target))
    throw new Error("Build export target overlaps the control directory");
  const parent = dirname(target);
  if ((await realpath(parent)) !== parent) throw new Error("Build export parent alias is forbidden");
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    await writer.assertOwner();
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Build export parent must be a real directory");
    if ([".cothink-build", ".agent-sync"].includes(basename(cursor).toLowerCase()))
      throw new Error("Build export target overlaps a control directory");
    try {
      await lstat(join(cursor, ".git"));
      throw new Error("Build export target must not be inside a source Git checkout");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const ancestor = dirname(cursor);
    if (ancestor === cursor) break;
    const exact = basename(cursor);
    const aliases = (await readdir(ancestor)).filter((name) => name.toLowerCase() === exact.toLowerCase());
    if (aliases.length !== 1 || aliases[0] !== exact) throw new Error("Build export parent path alias is forbidden");
  }
  const aliases = (await readdir(parent)).filter((name) => name.toLowerCase() === basename(target).toLowerCase());
  if (aliases.length && (!allowExisting || aliases.length !== 1 || aliases[0] !== basename(target)))
    throw new Error("Build export target already exists or aliases an existing path");
  try {
    const stat = await lstat(target);
    if (!allowExisting) throw new Error("Build export target already exists");
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(target)) !== target)
      throw new Error("Build existing export target must be a real canonical directory");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return identity(await lstat(parent));
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validatePrepared(root: string, expected: Readonly<Record<string, GitSnapshotFile>>): Promise<void> {
  const seen = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if ([".cothink-build", ".agent-sync"].includes(name.toLowerCase()))
        throw new Error("Build export target contains a control directory");
      const path = join(directory, name);
      const relativePath = relative(root, path).split("\\").join("/");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Build export prepared link is forbidden");
      if (stat.isDirectory()) {
        if (!Object.keys(expected).some((p) => p.startsWith(`${relativePath}/`) && expected[p]!.text !== null))
          throw new Error("Build export contains an undeclared directory");
        await walk(path);
      } else {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Build export requires single-link regular files");
        const file = expected[relativePath];
        if (!file || file.text === null) throw new Error("Build export contains an undeclared file");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const actual = await handle.stat();
          if (!actual.isFile() || actual.nlink !== 1 || identity(actual) !== identity(stat))
            throw new Error("Build export prepared file identity changed");
          if (!(await handle.readFile()).equals(Buffer.from(file.text, "utf8")))
            throw new Error("Build export prepared content mismatch");
          await handle.sync();
        } finally {
          await handle.close();
        }
        seen.add(relativePath);
      }
    }
    await syncDirectory(directory);
  };
  await walk(root);
  if (Object.entries(expected).some(([path, file]) => file.text !== null && !seen.has(path)))
    throw new Error("Build export prepared content is incomplete");
}

/** Export a complete immutable accepted snapshot; never changes coordination metadata. */
export async function exportManagedVersion<P extends SnapshotProject, S extends ManagedState<P>>(
  writer: ManagedWriter<P, S>,
  input: { version?: string; target: string },
  options: ExportOptions = {},
  allowLegacyChecks = false
): Promise<{ status: "exported"; version: string; directory: string }> {
  input = Object.freeze({ ...input });
  options = Object.freeze({ ...options });
  const state = await writer.load();
  const version = input.version ?? state.acceptedVersion;
  if (!knownAccepted(state, version)) throw new Error("Build export version is not an accepted version");
  await validateCommittedAssets(writer.git, state, { allowLegacyChecks });
  const target = input.target;
  const parent = dirname(target);
  const parentIdentity = await safeParent(writer, target, true);
  const files = await writer.git.readFiles(version);
  let existingIdentity: string | undefined;
  try {
    existingIdentity = identity(await lstat(target));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (existingIdentity !== undefined) {
    // A previous rename may have succeeded before its parent sync or process exit.
    // Read and sync exactly the requested accepted snapshot; never replace it.
    return writer.transaction(async (latest) => {
      if (!knownAccepted(latest, version)) throw new Error("Build export version is no longer known accepted");
      await validateCommittedAssets(writer.git, latest, { allowLegacyChecks });
      await writer.assertOwner();
      if (
        (await safeParent(writer, target, true)) !== parentIdentity ||
        identity(await lstat(target)) !== existingIdentity
      )
        throw new Error("Build existing export identity changed");
      await validatePrepared(target, files);
      await writer.assertOwner();
      if (
        (await safeParent(writer, target, true)) !== parentIdentity ||
        identity(await lstat(target)) !== existingIdentity
      )
        throw new Error("Build existing export identity changed");
      await syncDirectory(parent);
      return { value: { status: "exported" as const, version, directory: target } };
    });
  }
  const temporary = await mkdtemp(join(parent, ".cothink-export-"));
  const temporaryIdentity = identity(await lstat(temporary));
  let visible = false;
  try {
    const directories = new Set<string>([temporary]);
    for (const { path } of state.plan.manifest) {
      const file = files[path]!;
      if (file.text === null) continue;
      await writer.assertOwner();
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      for (let directory = dirname(destination); inside(directory, temporary); directory = dirname(directory)) {
        directories.add(directory);
        if (directory === temporary) break;
      }
      const handle = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(file.text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory);
    await options.beforeRename?.();
    // Re-enter the existing writer queue after preparation. The current state is loaded
    // and its durable assets are revalidated by FileBuildWriter, without committing it.
    await writer.transaction(async (latest) => {
      if (!knownAccepted(latest, version)) throw new Error("Build export version is no longer known accepted");
      await validateCommittedAssets(writer.git, latest, { allowLegacyChecks });
      await writer.assertOwner();
      if ((await safeParent(writer, target)) !== parentIdentity)
        throw new Error("Build export parent identity changed");
      if (identity(await lstat(temporary)) !== temporaryIdentity)
        throw new Error("Build export temporary directory identity changed");
      await validatePrepared(temporary, files);
      await writer.assertOwner();
      await rename(temporary, target);
      visible = true;
      await options.beforeParentSync?.();
      await syncDirectory(parent);
      return { value: undefined };
    });
    return { status: "exported", version, directory: target };
  } catch (error) {
    if (!visible) {
      // Do not remove a replacement directory or anything reached through a changed parent.
      try {
        if (
          (await realpath(parent)) === parent &&
          identity(await lstat(parent)) === parentIdentity &&
          identity(await lstat(temporary)) === temporaryIdentity &&
          !(await lstat(temporary)).isSymbolicLink()
        )
          await rm(temporary, { recursive: true });
      } catch (cleanupError) {
        if (!missing(cleanupError))
          throw new AggregateError([error, cleanupError], "Build export failed and its temporary cleanup failed");
      }
    }
    throw error;
  }
}

/** Zero-call recovery uses the already acquired writer; owner epoch recovery is owned by FileBuildStore. */
export async function recoverManaged<P extends SnapshotProject, S extends ManagedState<P>>(
  writer: ManagedWriter<P, S>,
  allowLegacyChecks = false
): Promise<{
  status: "recovered";
  acceptedVersion: string;
  acceptedTasks: S["acceptedTasks"];
  publishReceipts: S["publishReceipts"];
}> {
  return writer.transaction(async (state) => {
    await validateCommittedAssets(writer.git, state, { allowLegacyChecks });
    await writer.assertOwner();
    return {
      value: {
        status: "recovered" as const,
        acceptedVersion: state.acceptedVersion,
        acceptedTasks: state.acceptedTasks,
        publishReceipts: state.publishReceipts
      }
    };
  });
}
