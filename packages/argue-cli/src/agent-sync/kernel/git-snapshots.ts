import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SyncPathSchema, freezeSyncValue, hashJson } from "@onevcat/argue/agent-sync/project";
import type { SnapshotProject, StorageIdentity } from "./storage-types.js";

export interface GitSnapshotEdit {
  readonly path: string;
  readonly blobId: string;
  readonly contentHash: string;
}
export interface GitSnapshotsOptions {
  beforeObjectWrite?: () => Promise<void>;
  beforeRefWrite?: () => Promise<void>;
}
export interface GitSnapshotFile {
  readonly text: string | null;
  readonly contentHash: string | null;
  readonly blobId: string | null;
}
interface TreeFile {
  path: string;
  blobId: string;
  contentHash: string;
}
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const contentHash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function textBytes(text: string): Buffer {
  if (typeof text !== "string" || text.includes("\0")) throw new Error("BUILD_BINARY_CONTENT");
  const bytes = Buffer.from(text, "utf8");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== text)
    throw new Error("BUILD_INVALID_UTF8");
  return bytes;
}
function decode(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  textBytes(text);
  return text;
}

/** Immutable objects only. Snapshot refs retain candidates; no ref is an acceptedVersion. */
export class ManifestGitSnapshots {
  private readonly repo: string;
  private readonly plan: SnapshotProject;
  private tail: Promise<unknown> = Promise.resolve();
  private controlIdentity: string | undefined;
  constructor(
    private readonly controlRoot: string,
    plan: SnapshotProject,
    private readonly assertOwner: () => Promise<void>,
    private readonly identity: StorageIdentity,
    private readonly options: GitSnapshotsOptions = {}
  ) {
    this.plan = freezeSyncValue(structuredClone(plan));
    this.identity = Object.freeze({ ...identity });
    const namespace = new Map<string, { path: string; kind: "file" | "directory" }>();
    for (const entry of this.plan.manifest) {
      const segments = entry.path.split("/");
      for (let index = 0; index < segments.length; index++) {
        const path = segments.slice(0, index + 1).join("/");
        const kind = index === segments.length - 1 ? "file" : "directory";
        const previous = namespace.get(path.toLowerCase());
        if (previous && (previous.path !== path || previous.kind !== kind))
          throw new Error("BUILD_PATH_NAMESPACE_CONFLICT");
        namespace.set(path.toLowerCase(), { path, kind });
      }
    }
    this.repo = join(controlRoot, "git");
  }

  initialize(): Promise<void> {
    return this.serial(async () => {
      await this.guard(false);
      try {
        await lstat(this.repo);
        await this.validateRepo();
        return;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await this.guard(false);
      try {
        await lstat(join(this.controlRoot, "git-identity.json"));
      } catch (error) {
        if (!missing(error)) throw error;
        await this.createRepository();
        return;
      }
      throw new Error("BUILD_GIT_MISSING");
    });
  }

  private async createRepository(): Promise<void> {
    await this.assertOwner();
    await mkdir(this.repo);
    await this.git(["init", "--bare", "--object-format=sha1", this.repo], undefined, false);
    await this.guard(false);
    const stat = await lstat(this.repo);
    await this.syncInitialRepository(this.repo);
    await this.syncDirectory(this.controlRoot);
    await this.durableFile(
      join(this.controlRoot, "git-identity.json"),
      JSON.stringify({
        version: this.identity.gitIdentityVersion,
        dev: stat.dev,
        ino: stat.ino,
        projectKey: this.plan.projectKey,
        configHash: contentHash(decode(await this.regularFile(join(this.repo, "config"))))
      }),
      true
    );
    await this.validateRepo();
  }

  importSource(sourceRoot: string): Promise<string> {
    return this.serial(async () => {
      await this.guard();
      await this.safeDirectory(sourceRoot);
      const files: TreeFile[] = [];
      for (const entry of this.plan.manifest) {
        const path = this.path(entry.path);
        let bytes: Buffer;
        try {
          bytes = await this.sourceFile(sourceRoot, path);
        } catch (error) {
          if (missing(error) && entry.contentHash === null && entry.access === "writable") continue;
          throw error;
        }
        if (entry.contentHash === null) throw new Error("BUILD_UNEXPECTED_SOURCE_FILE");
        const text = decode(bytes);
        if (contentHash(text) !== entry.contentHash) throw new Error("BUILD_SOURCE_HASH_MISMATCH");
        const blob = await this.putBlob(text);
        files.push({ path, ...blob });
      }
      return (await this.commit(files)).version;
    });
  }

  async writeBlob(text: string): Promise<{ blobId: string; contentHash: string }> {
    const bytes = textBytes(text);
    return this.serial(() => this.putBlob(decode(bytes)));
  }
  readBlob(blobId: string): Promise<string> {
    return this.serial(async () => decode(await this.object(blobId, "blob")));
  }
  readFiles(version: string): Promise<Readonly<Record<string, GitSnapshotFile>>> {
    return this.serial(async () => {
      const files = await this.snapshot(version);
      const byPath = new Map(files.map((file) => [file.path, file]));
      return freezeSyncValue(
        Object.fromEntries(
          this.plan.manifest.map(({ path }) => {
            const file = byPath.get(path);
            return [
              path,
              file
                ? { text: file.text, contentHash: file.contentHash, blobId: file.blobId }
                : { text: null, contentHash: null, blobId: null }
            ];
          })
        )
      );
    });
  }
  async readFile(
    version: string,
    path: string
  ): Promise<{ text: string | null; contentHash: string | null; blobId: string | null }> {
    const exact = this.path(path);
    return this.serial(async () => {
      const files = await this.snapshot(version);
      const file = files.find((entry) => entry.path === exact);
      return file
        ? { text: file.text, contentHash: file.contentHash, blobId: file.blobId }
        : { text: null, contentHash: null, blobId: null };
    });
  }
  assertSnapshot(version: string): Promise<void> {
    return this.serial(async () => {
      await this.snapshot(version);
    });
  }
  createSnapshot(
    baseVersion: string,
    edits: readonly GitSnapshotEdit[]
  ): Promise<{ version: string; candidateHash: string }> {
    const frozen = edits.map((edit) => ({ ...edit }));
    return this.serial(async () => {
      const files = await this.snapshot(baseVersion);
      const seen = new Set<string>();
      for (const edit of frozen) {
        this.path(edit.path);
        if (seen.has(edit.path)) throw new Error("BUILD_DUPLICATE_EDIT");
        seen.add(edit.path);
        if (this.plan.manifest.find((entry) => entry.path === edit.path)?.access !== "writable")
          throw new Error("BUILD_READ_ONLY_PATH");
        const text = decode(await this.object(edit.blobId, "blob"));
        if (contentHash(text) !== edit.contentHash) throw new Error("BUILD_BLOB_HASH_MISMATCH");
        const previous = files.findIndex((file) => file.path === edit.path);
        if (previous >= 0) files.splice(previous, 1);
        files.push({ ...edit, text });
      }
      const result = await this.commit(files, baseVersion);
      // Includes every declared path; absent new files are explicitly null. The base is part of the commitment.
      const candidateHash = hashJson({
        baseVersion,
        files: [...this.plan.manifest]
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .map((entry) => ({
            path: entry.path,
            contentHash: files.find((file) => file.path === entry.path)?.contentHash ?? null
          }))
      });
      return { ...result, candidateHash };
    });
  }

  private path(path: string): string {
    if (!SyncPathSchema.safeParse(path).success || !this.plan.manifest.some((entry) => entry.path === path))
      throw new Error("BUILD_UNKNOWN_PATH");
    return path;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private async safeDirectory(path: string): Promise<void> {
    if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
      throw new Error("BUILD_DIRECTORY_ALIAS");
    let cursor = path;
    while (true) {
      await this.assertOwner();
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("BUILD_DIRECTORY_LINK");
      const parent = dirname(cursor);
      if (cursor === parent) break;
      cursor = parent;
    }
  }
  private async guard(requireRepo = true): Promise<void> {
    await this.assertOwner();
    if (basename(this.controlRoot) !== this.identity.controlDirectory) throw new Error("BUILD_CONTROL_DIRECTORY");
    await this.safeDirectory(this.controlRoot);
    for (const name of await readdir(dirname(this.controlRoot))) {
      if ([".cothink-build", ".agent-sync"].includes(name.toLowerCase()) && name !== this.identity.controlDirectory)
        throw new Error("Managed control authority conflict or path alias");
    }
    const stat = await lstat(this.controlRoot);
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.controlIdentity && identity !== this.controlIdentity) throw new Error("BUILD_CONTROL_REPLACED");
    this.controlIdentity = identity;
    const marker = JSON.parse(decode(await this.regularFile(join(this.controlRoot, "project.json"))));
    if (
      marker.identityVersion !== this.identity.projectIdentityVersion ||
      marker.projectKey !== this.plan.projectKey ||
      marker.workspaceRoot !== dirname(this.controlRoot) ||
      marker.controlDirectory !== this.identity.controlDirectory ||
      Object.keys(marker).length !== 4
    )
      throw new Error("BUILD_PROJECT_IDENTITY");
    if (requireRepo) await this.validateRepo();
  }
  private async validateRepo(): Promise<void> {
    await this.assertOwner();
    const stat = await lstat(this.repo);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("BUILD_GIT_LINK");
    let marker;
    try {
      marker = JSON.parse(decode(await this.regularFile(join(this.controlRoot, "git-identity.json"))));
    } catch {
      throw new Error("BUILD_UNKNOWN_GIT_REPOSITORY");
    }
    if (
      marker.version !== this.identity.gitIdentityVersion ||
      marker.projectKey !== this.plan.projectKey ||
      marker.dev !== stat.dev ||
      marker.ino !== stat.ino
    )
      throw new Error("BUILD_GIT_REPLACED");
    if (marker.configHash !== contentHash(decode(await this.regularFile(join(this.repo, "config")))))
      throw new Error("BUILD_GIT_CONFIG_CHANGED");
    for (const forbidden of [
      join(this.repo, "objects", "info", "alternates"),
      join(this.repo, "objects", "info", "http-alternates")
    ]) {
      await this.assertOwner();
      try {
        await lstat(forbidden);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      throw new Error("BUILD_GIT_ALTERNATES");
    }
    const walk = async (directory: string): Promise<void> => {
      await this.assertOwner();
      const names = await readdir(directory);
      // Keep every live-owner and entry check, but overlap independent sibling I/O.
      // Each batch must finish before Git can observe the validated repository.
      for (let offset = 0; offset < names.length; offset += 4) {
        const checked = await Promise.allSettled(
          names.slice(offset, offset + 4).map(async (name) => {
            await this.assertOwner();
            const path = join(directory, name);
            const child = await lstat(path);
            if (child.isSymbolicLink() || (!child.isDirectory() && (!child.isFile() || child.nlink !== 1)))
              throw new Error("BUILD_GIT_UNSAFE_FILE");
            if (child.isDirectory()) await walk(path);
          })
        );
        for (const result of checked) if (result.status === "rejected") throw result.reason;
      }
    };
    await walk(this.repo);
  }
  private async regularFile(path: string): Promise<Buffer> {
    await this.assertOwner();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.assertOwner();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("BUILD_UNSAFE_FILE");
      await this.assertOwner();
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  private async sourceFile(root: string, path: string): Promise<Buffer> {
    let cursor = root;
    for (const [index, part] of path.split("/").entries()) {
      await this.guard();
      const names = await readdir(cursor);
      const aliases = names.filter((name) => name.toLowerCase() === part.toLowerCase());
      if (aliases.length !== 1 || aliases[0] !== part) {
        if (aliases.length === 0) throw Object.assign(new Error("BUILD_SOURCE_MISSING"), { code: "ENOENT" });
        throw new Error("BUILD_PATH_ALIAS");
      }
      cursor = join(cursor, part);
      await this.assertOwner();
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("BUILD_SOURCE_LINK");
      if (index < path.split("/").length - 1 && !stat.isDirectory()) throw new Error("BUILD_SOURCE_DIRECTORY");
    }
    return this.regularFile(cursor);
  }
  private async putBlob(text: string): Promise<{ blobId: string; contentHash: string }> {
    const bytes = textBytes(text);
    await this.options.beforeObjectWrite?.();
    const blobId = (await this.git(["hash-object", "-w", "--stdin"], bytes)).toString().trim();
    await this.syncObject(blobId);
    await this.object(blobId, "blob");
    return { blobId, contentHash: contentHash(text) };
  }
  private async object(id: string, type: "blob" | "tree" | "commit"): Promise<Buffer> {
    if (!objectId.test(id)) throw new Error("BUILD_INVALID_OBJECT_ID");
    // One fresh guarded read returns type and payload together. No object or
    // authorization is cached across operations; recheck the live owner before use.
    const frame = await this.git(["cat-file", "--batch"], `${id}\n`);
    await this.assertOwner();
    const end = frame.indexOf(10);
    const header = end < 0 ? "" : frame.subarray(0, end).toString("ascii");
    if (header === `${id} missing`) throw new Error("BUILD_GIT_FAILED: missing object");
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-z]+) (\d+)$/.exec(header);
    if (!match || match[1] !== id) throw new Error("BUILD_OBJECT_CORRUPT");
    if (match[2] !== type) throw new Error("BUILD_OBJECT_TYPE");
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || frame.length !== end + 1 + size + 1 || frame.at(-1) !== 10)
      throw new Error("BUILD_OBJECT_CORRUPT");
    const bytes = frame.subarray(end + 1, end + 1 + size);
    const actual = createHash(id.length === 40 ? "sha1" : "sha256")
      .update(`${type} ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (actual !== id) throw new Error("BUILD_OBJECT_CORRUPT");
    return bytes;
  }
  private async snapshot(version: string): Promise<(TreeFile & { text: string })[]> {
    const commit = (await this.object(version, "commit")).toString("utf8");
    const tree = /^tree ([a-f0-9]{40}|[a-f0-9]{64})\n/.exec(commit)?.[1];
    if (!tree) throw new Error("BUILD_COMMIT_TREE");
    const files: (TreeFile & { text: string })[] = [];
    const visit = async (treeId: string, prefix: string): Promise<void> => {
      const bytes = await this.object(treeId, "tree");
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const nul = bytes.indexOf(0, space + 1);
        const idBytes = treeId.length === 40 ? 20 : 32;
        if (space < offset || nul < space || nul + 1 + idBytes > bytes.length) throw new Error("BUILD_CORRUPT_TREE");
        const mode = bytes.subarray(offset, space).toString("ascii");
        const name = decode(bytes.subarray(space + 1, nul));
        const id = bytes.subarray(nul + 1, nul + 1 + idBytes).toString("hex");
        offset = nul + 1 + idBytes;
        if (!name || name.includes("/")) throw new Error("BUILD_UNSAFE_TREE_ENTRY");
        const path = `${prefix}${name}`;
        if (mode === "40000") {
          if (!this.plan.manifest.some((entry) => entry.path.startsWith(`${path}/`)))
            throw new Error("BUILD_UNKNOWN_PATH");
          await visit(id, `${path}/`);
          continue;
        }
        if (mode !== "100644") throw new Error("BUILD_UNSAFE_TREE_ENTRY");
        this.path(path);
        const text = decode(await this.object(id, "blob"));
        const hash = contentHash(text);
        const entry = this.plan.manifest.find((item) => item.path === path)!;
        if (files.some((file) => file.path === path)) throw new Error("BUILD_DUPLICATE_TREE_PATH");
        if (entry.access === "read-only" && entry.contentHash !== hash) throw new Error("BUILD_FIXED_FILE_CHANGED");
        files.push({ path, blobId: id, contentHash: hash, text });
      }
    };
    await visit(tree, "");
    for (const entry of this.plan.manifest)
      if (entry.contentHash !== null && !files.some((file) => file.path === entry.path))
        throw new Error("BUILD_SNAPSHOT_FILE_MISSING");
    return files;
  }
  private async commit(files: readonly TreeFile[], base?: string): Promise<{ version: string }> {
    const treeAt = async (prefix: string): Promise<string> => {
      const children = new Map<string, string>();
      for (const file of files.filter((file) => file.path.startsWith(prefix))) {
        const suffix = file.path.slice(prefix.length);
        const slash = suffix.indexOf("/");
        if (slash < 0) children.set(suffix, `100644 blob ${file.blobId}\t${suffix}\0`);
        else children.set(suffix.slice(0, slash), "");
      }
      for (const [name, value] of children)
        if (!value) children.set(name, `040000 tree ${await treeAt(`${prefix}${name}/`)}\t${name}\0`);
      await this.options.beforeObjectWrite?.();
      const tree = (
        await this.git(
          ["mktree", "-z"],
          [...children]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([, line]) => line)
            .join("")
        )
      )
        .toString()
        .trim();
      await this.syncObject(tree);
      return tree;
    };
    const tree = await treeAt("");
    await this.options.beforeObjectWrite?.();
    const version = (await this.git(["commit-tree", tree, ...(base ? ["-p", base] : [])], this.identity.commitMessage))
      .toString()
      .trim();
    await this.syncObject(version);
    await this.snapshot(version);
    await this.options.beforeRefWrite?.();
    const ref = `refs/${this.identity.refNamespace}/snapshots/${version}`;
    await this.git(["update-ref", ref, version]);
    await this.syncFile(join(this.repo, ref));
    await this.syncDirectory(join(this.repo, "refs", this.identity.refNamespace));
    await this.syncDirectory(join(this.repo, "refs"));
    await this.syncDirectory(this.repo);
    return { version };
  }
  private async syncInitialRepository(directory: string): Promise<void> {
    await this.assertOwner();
    for (const name of await readdir(directory)) {
      await this.assertOwner();
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("BUILD_GIT_UNSAFE_FILE");
      if (stat.isDirectory()) await this.syncInitialRepository(path);
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("BUILD_GIT_UNSAFE_FILE");
        await this.syncFile(path);
      }
    }
    await this.syncDirectory(directory);
  }
  private async syncObject(id: string): Promise<void> {
    await this.guard();
    await this.syncFile(join(this.repo, "objects", id.slice(0, 2), id.slice(2)));
    await this.syncDirectory(join(this.repo, "objects"));
  }
  private async syncFile(path: string): Promise<void> {
    await this.assertOwner();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.assertOwner();
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(dirname(path));
  }
  private async syncDirectory(path: string): Promise<void> {
    await this.assertOwner();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.assertOwner();
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async durableFile(path: string, text: string, exclusive = false): Promise<void> {
    await this.assertOwner();
    const handle = await open(path, exclusive ? "wx" : "w", 0o600);
    try {
      await this.assertOwner();
      await handle.writeFile(text);
      await this.assertOwner();
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory(dirname(path));
  }
  private async git(args: string[], input?: string | Buffer, requireRepo = true): Promise<Buffer> {
    await this.guard(requireRepo);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: this.identity.authorName,
      GIT_AUTHOR_EMAIL: this.identity.authorEmail,
      GIT_COMMITTER_NAME: this.identity.authorName,
      GIT_COMMITTER_EMAIL: this.identity.authorEmail,
      GIT_AUTHOR_DATE: this.identity.commitDate,
      GIT_COMMITTER_DATE: this.identity.commitDate
    });
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "core.fsync=loose-object,reference", "--git-dir", this.repo, ...args],
        { env, stdio: "pipe", cwd: this.controlRoot }
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolveResult(Buffer.concat(out))
          : reject(new Error(`BUILD_GIT_FAILED: ${Buffer.concat(err).toString()}`))
      );
      child.stdin.end(input);
    });
  }
}
