import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hashJson } from "@onevcat/argue/agent-sync/project";
import { FileSnapshotStore, type SnapshotCodec } from "../../storage/snapshot-store.js";
import { ManifestGitSnapshots } from "./git-snapshots.js";
import { validateCommittedAssets, validateCommittedMetadata } from "./committed-metadata.js";
import type {
  SnapshotProject,
  ManagedState,
  StorageProtocol,
  ManagedWriter,
  ManagedFileStoreOptions,
  StoredFile
} from "./storage-types.js";

const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const active = (status: string) => ["running", "checking", "publishing"].includes(status);
const errno = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
export function immutable(condition: boolean, field: string): void {
  if (!condition) throw new Error(`Build immutable history changed: ${field}`);
}
export function appendOnly<T>(next: readonly T[], current: readonly T[], field: string): void {
  immutable(next.length >= current.length && current.every((item, i) => same(item, next[i])), field);
}

/** Independent construction codec; the shared store still owns CAS and crash recovery. */
export function createManagedSnapshotCodec<P extends SnapshotProject, S extends ManagedState<P>>(
  projectKey: string,
  protocol: StorageProtocol<P, S>
): SnapshotCodec<S> {
  return {
    formatName: protocol.identity.formatName,
    parse(value) {
      const state = protocol.parseState(value);
      if (state.projectKey !== projectKey) throw new Error("Build project identity mismatch");
      return state;
    },
    sessionId: (state) => state.projectKey,
    revision: (state) => state.revision,
    validateTransition(next, current) {
      if (!current) {
        immutable(next.revision === 0 && next.ownerEpoch === 1, "initial revision/owner epoch");
        return;
      }
      for (const field of ["projectKey", "runId", "plan", "startedAt", "deadlineAt"] as const)
        immutable(same(next[field], current[field]), field);
      immutable(next.coordination.lastNow >= current.coordination.lastNow, "clock");
      immutable(next.coordination.nextSequence >= current.coordination.nextSequence, "queue sequence");
      immutable(next.ownerEpoch === current.ownerEpoch || next.ownerEpoch === current.ownerEpoch + 1, "owner epoch");
      if (next.ownerEpoch !== current.ownerEpoch) {
        immutable(
          next.coordination.requests
            .slice(current.coordination.requests.length)
            .some(
              (r) =>
                r.operation === "epoch" &&
                r.status === "succeeded" &&
                r.result?.kind === "epoch_advanced" &&
                r.result.ownerEpoch === next.ownerEpoch
            ),
          "owner epoch authorization"
        );
        immutable(
          current.attempts
            .filter((a) => active(a.status))
            .every(
              (a) =>
                !active(next.attempts.find((n) => n.attemptId === a.attemptId)?.status ?? "") &&
                next.coordination.taskEpochs[a.taskId]! > a.leaseEpoch!
            ),
          "owner epoch revocation"
        );
      }
      for (const [taskId, epoch] of Object.entries(current.coordination.taskEpochs))
        immutable(next.coordination.taskEpochs[taskId]! >= epoch, "task epoch");
      immutable(next.attempts.length >= current.attempts.length, "attempts");
      for (let i = 0; i < current.attempts.length; i++) {
        const old = current.attempts[i]!;
        const item = next.attempts[i]!;
        for (const key of [
          "attemptId",
          "taskId",
          "workerId",
          "token",
          "ownerEpoch",
          "leaseEpoch",
          "baseVersion",
          "startedAt",
          "deadlineAt"
        ] as const)
          immutable(same(item[key], old[key]), `attempt ${key}`);
        if (old.inputHash !== null) {
          immutable(item.inputHash === old.inputHash && same(item.contentHashes, old.contentHashes), "bound input");
        }
        if (!active(old.status)) immutable(item.status === old.status, "ended attempt");
      }
      protocol.validateExtension(next, current);
      immutable(next.coordination.requests.length >= current.coordination.requests.length, "requests");
      for (let i = 0; i < current.coordination.requests.length; i++) {
        const old = current.coordination.requests[i]!;
        const item = next.coordination.requests[i]!;
        if (old.status !== "pending") immutable(same(item, old), "completed/invalidated request");
        else {
          immutable(
            same(protocol.requestBinding(current, i), protocol.requestBinding(next, i)),
            "pending request binding"
          );
        }
      }
      immutable(
        current.acceptedTasks.every((id) => next.acceptedTasks.includes(id)),
        "accepted tasks"
      );
      appendOnly(next.checkReceipts, current.checkReceipts, "check receipts");
      appendOnly(next.publishReceipts, current.publishReceipts, "publish receipts");
      if (current.workspace) {
        immutable(!!next.workspace, "workspace metadata");
        appendOnly(next.workspace!.toolReceipts, current.workspace.toolReceipts, "tool receipts");
        appendOnly(next.workspace!.candidates, current.workspace.candidates, "sealed candidates");
        for (const staging of current.workspace.staging) {
          const replacement = next.workspace!.staging.find((s) => s.attemptId === staging.attemptId);
          immutable(!!replacement, "persistent staging");
          immutable(replacement!.baseVersion === staging.baseVersion, "staging base version");
          if (!same(replacement, staging))
            immutable(
              active(next.attempts.find((a) => a.attemptId === staging.attemptId)?.status ?? ""),
              "inactive staging"
            );
        }
      }
    }
  };
}

/** One project identity, one shared writer lease and one authoritative atomic snapshot. */
export class ManagedFileStore<P extends SnapshotProject, S extends ManagedState<P>> {
  readonly projectKey: string;
  readonly controlRoot: string;
  private readonly workspaceRoot: string;
  private readonly clock: () => number;
  private readonly snapshots: FileSnapshotStore<S>;
  private initializedRoot: string | undefined;

  constructor(
    private readonly options: ManagedFileStoreOptions,
    private readonly protocol: StorageProtocol<P, S>
  ) {
    this.protocol = Object.freeze({ ...protocol, identity: Object.freeze({ ...protocol.identity }) });
    this.options = Object.freeze({ ...options });
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.projectKey))
      throw new Error("Invalid build project identity");
    if (
      (options.controlDirectory ?? this.protocol.identity.controlDirectory) !== this.protocol.identity.controlDirectory
    )
      throw new Error("Build control directory is fixed");
    if (!isAbsolute(options.workspaceRoot) || resolve(options.workspaceRoot) !== options.workspaceRoot)
      throw new Error("Build workspace path must be absolute and canonical");
    this.projectKey = options.projectKey;
    this.workspaceRoot = options.workspaceRoot;
    this.controlRoot = join(this.workspaceRoot, this.protocol.identity.controlDirectory);
    this.clock = options.clock ?? Date.now;
    this.snapshots = new FileSnapshotStore(
      join(this.controlRoot, "state"),
      createManagedSnapshotCodec(this.projectKey, this.protocol)
    );
  }

  private identity(root: string) {
    return {
      identityVersion: this.protocol.identity.projectIdentityVersion,
      projectKey: this.projectKey,
      workspaceRoot: root,
      controlDirectory: this.protocol.identity.controlDirectory
    };
  }
  private async assertDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Build path must be a real directory");
  }
  private async regularFile(path: string): Promise<string> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error("Build metadata must be a single-link regular file");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino)
        throw new Error("Build metadata must be the same single-link regular file");
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }
  private async assertRoot(): Promise<string> {
    await this.assertDirectory(this.workspaceRoot);
    const root = await realpath(this.workspaceRoot);
    if (this.initializedRoot && root !== this.initializedRoot) throw new Error("Build workspace identity changed");
    if (root !== this.workspaceRoot) throw new Error("Build workspace path alias is forbidden");
    for (let path = root; ; path = dirname(path)) {
      try {
        await lstat(join(path, ".git"));
        throw new Error("Build workspace must not be a source Git checkout");
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
      }
      if (path === dirname(path)) break;
    }
    for (const name of await readdir(root)) {
      if (
        [".cothink-build", ".agent-sync"].includes(name.toLowerCase()) &&
        name !== this.protocol.identity.controlDirectory
      )
        throw new Error("Managed control authority conflict or path alias");
    }
    this.initializedRoot = root;
    return root;
  }
  private async prepare(): Promise<void> {
    const root = await this.assertRoot();
    await mkdir(this.controlRoot, { mode: 0o700 }).catch((error) => {
      if (!errno(error, "EEXIST")) throw error;
    });
    await this.assertDirectory(this.controlRoot);
    const marker = join(this.controlRoot, "project.json");
    try {
      const contents = await this.regularFile(marker);
      if (!same(JSON.parse(contents), this.identity(root)))
        throw new Error("Build workspace project identity mismatch");
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
      if ((await readdir(this.controlRoot)).length)
        throw new Error("Build control directory lacks a trustworthy project identity");
      const file = await open(
        marker,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await file.writeFile(JSON.stringify(this.identity(root)));
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(this.controlRoot, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    await this.guardLayout();
  }
  private async guardLayout(): Promise<void> {
    const root = await this.assertRoot();
    await this.assertDirectory(this.controlRoot);
    const marker = JSON.parse(await this.regularFile(join(this.controlRoot, "project.json")));
    if (!same(marker, this.identity(root))) throw new Error("Build workspace project identity mismatch");
    for (const path of [join(this.controlRoot, "state"), join(this.controlRoot, "state", this.projectKey)]) {
      try {
        await this.assertDirectory(path);
        if (path.endsWith(`/${this.projectKey}`)) {
          for (const entry of await readdir(path)) await this.regularFile(join(path, entry));
        }
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
      }
    }
  }
  private assertBinding(state: S): void {
    if (
      (this.options.expectedPlanHash !== undefined && state.plan.planHash !== this.options.expectedPlanHash) ||
      (this.options.expectedRunId !== undefined && state.runId !== this.options.expectedRunId)
    )
      throw new Error("Managed expected plan/run identity mismatch");
  }
  private async validateAssets(state: S, git: ManifestGitSnapshots): Promise<void> {
    this.assertBinding(state);
    if (this.protocol.validateCommittedOnAccess) validateCommittedMetadata(state);
    // One complete immutable version view per validation operation. Never reused across IO actions.
    const views = new Map<string, Promise<Awaited<ReturnType<ManifestGitSnapshots["readFiles"]>>>>();
    const view = (version: string) => {
      let pending = views.get(version);
      if (!pending) {
        pending = git.readFiles(version);
        views.set(version, pending);
      }
      return pending;
    };
    await view(state.acceptedVersion);
    for (const attempt of state.attempts) {
      const frozen = await view(attempt.baseVersion);
      if (attempt.inputHash !== null) {
        if (
          attempt.inputHash !==
          hashJson({
            planHash: state.plan.planHash,
            attemptId: attempt.attemptId,
            baseVersion: attempt.baseVersion,
            contentHashes: attempt.contentHashes
          })
        )
          throw new Error("Build frozen input hash mismatch");
        for (const [path, expectedHash] of Object.entries(attempt.contentHashes)) {
          const file = frozen[path];
          if ((file?.contentHash ?? null) !== expectedHash) throw new Error("Build frozen content hash mismatch");
        }
      }
    }
    const verifiedBlobs = new Map<string, { text: string; contentHash: string }>();
    const overlays = [
      ...(state.workspace?.staging ?? []),
      ...(state.workspace?.toolReceipts ?? []).flatMap((receipt) =>
        receipt.result.kind === "edited" ? [{ attemptId: receipt.attemptId, ...receipt.result }] : []
      )
    ];
    for (const staging of overlays) {
      for (const file of staging.files) {
        if (verifiedBlobs.has(file.blobId)) {
          if (verifiedBlobs.get(file.blobId)!.contentHash !== file.contentHash)
            throw new Error("Build staging content hash mismatch");
          continue;
        }
        const text = await git.readBlob(file.blobId);
        const actual = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
        if (file.contentHash !== actual) throw new Error("Build staging content hash mismatch");
        verifiedBlobs.set(file.blobId, { text, contentHash: actual });
      }
    }
    // Reconstruct each private overlay in receipt order; self-consistent hashes alone are not read evidence.
    const history = new Map<string, readonly StoredFile[]>();
    for (const receipt of state.workspace?.toolReceipts ?? []) {
      const before = history.get(receipt.attemptId) ?? [];
      const result = receipt.result;
      const base = await view(result.baseVersion);
      const fileAt = (path: string) => {
        const staged = before.find((file) => file.path === path);
        return staged ? verifiedBlobs.get(staged.blobId)! : base[path]!;
      };
      if (result.kind === "inspected") {
        const expected = fileAt(result.path);
        if (result.text !== expected.text || result.contentHash !== expected.contentHash)
          throw new Error("Build historical inspect content mismatch");
      } else if (result.kind === "edited") {
        if (receipt.request.operation !== "edit") throw new Error("Build historical edit request mismatch");
        const next = new Map(before.map((file) => [file.path, file]));
        for (const edit of receipt.request.edits) {
          if (edit.expectedContentHash !== fileAt(edit.path).contentHash)
            throw new Error("Build historical edit precondition mismatch");
          const file = result.files.find((file) => file.path === edit.path)!;
          if (verifiedBlobs.get(file.blobId)!.text !== edit.text)
            throw new Error("Build historical edit content mismatch");
          next.set(edit.path, file);
        }
        const expected = [...next.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        if (!same(expected, result.files)) throw new Error("Build historical edit adds or drops unrequested files");
        history.set(receipt.attemptId, expected);
      } else if (result.kind === "sealed") {
        if (
          result.overlayHash !==
          hashJson({ attemptId: receipt.attemptId, baseVersion: result.baseVersion, files: before })
        )
          throw new Error("Build historical seal overlay mismatch");
      }
    }
    for (const staging of state.workspace?.staging ?? []) {
      if (!same(staging.files, history.get(staging.attemptId) ?? []))
        throw new Error("Build current staging differs from historical edits");
    }
    for (const attemptId of history.keys()) {
      if (!state.workspace?.staging.some((staging) => staging.attemptId === attemptId))
        throw new Error("Build historical edits have missing current staging");
    }
    for (const candidate of state.workspace?.candidates ?? []) {
      const prepared = await view(candidate.version);
      const base = await view(candidate.baseVersion);
      const overlay = overlays.find(
        (item) => item.attemptId === candidate.attemptId && item.overlayHash === candidate.overlayHash
      );
      const emptyHash = hashJson({
        attemptId: candidate.attemptId,
        baseVersion: candidate.baseVersion,
        files: []
      });
      if (!overlay && candidate.overlayHash !== emptyHash) throw new Error("Build candidate overlay is unknown");
      const changes = overlay?.files ?? [];
      const files = [...state.plan.manifest]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => ({ path: file.path, contentHash: prepared[file.path]?.contentHash ?? null }));
      for (const file of files) {
        const staged = changes.find((change) => change.path === file.path);
        const expected = staged?.contentHash ?? base[file.path]?.contentHash ?? null;
        if (file.contentHash !== expected) throw new Error("Build candidate exceeds private staging scope");
      }
      if (candidate.candidateHash !== hashJson({ baseVersion: candidate.baseVersion, files }))
        throw new Error("Build candidate content hash mismatch");
    }
    if (this.protocol.validateCommittedOnAccess)
      await validateCommittedAssets(git, state, { allowLegacyChecks: false });
  }
  async load(): Promise<S> {
    await this.guardLayout();
    const state = await this.snapshots.load(this.projectKey);
    await this.validateAssets(
      state,
      new ManifestGitSnapshots(this.controlRoot, state.plan, () => this.guardLayout(), this.protocol.identity)
    );
    return state;
  }
  async withWriter<T>(callback: (writer: ManagedWriter<P, S>) => Promise<T>): Promise<T> {
    await this.prepare();
    return this.snapshots.withWriter(this.projectKey, async (raw) => {
      let activeLease = true;
      let boundPlan: P | undefined;
      let git: ManifestGitSnapshots | undefined;
      let operation = Promise.resolve();
      const assertOwner = async () => {
        if (!activeLease) throw new Error("Build writer lease has ended");
        await this.guardLayout();
        // Git guards need live ownership, not a full domain-state parse per
        // directory/object. Full state and asset validation remains at read/write.
        await raw.assertOwner();
      };
      const gitFor = (input: P) => {
        const plan = this.protocol.parseProject(input);
        if (plan.projectKey !== this.projectKey || (boundPlan && boundPlan.planHash !== plan.planHash))
          throw new Error("Build writer plan identity mismatch");
        boundPlan = plan;
        git ??= new ManifestGitSnapshots(this.controlRoot, plan, assertOwner, this.protocol.identity);
        return git;
      };
      const read = async () => {
        await assertOwner();
        const state = await raw.load(this.projectKey);
        await this.validateAssets(state, gitFor(state.plan));
        return state;
      };
      const write = async (expectedRevision: number, state: S, beforeCommit?: (latest: S) => void | Promise<void>) => {
        await assertOwner();
        const validated = this.protocol.parseState(state);
        await this.validateAssets(validated, gitFor(validated.plan));
        if (beforeCommit) {
          const latest = await raw.load(this.projectKey);
          await beforeCommit(latest);
        }
        await raw.commit(expectedRevision, validated);
      };
      const serialize = <Value>(fn: () => Promise<Value>): Promise<Value> => {
        if (!activeLease) return Promise.reject(new Error("Build writer lease has ended"));
        const result = operation.then(fn);
        operation = result.then(
          () => {},
          () => {}
        );
        return result;
      };
      const writer: ManagedWriter<P, S> = {
        projectKey: this.projectKey,
        controlRoot: this.controlRoot,
        get git() {
          if (!git) throw new Error("Build writer plan is not initialized");
          return git;
        },
        gitFor,
        assertOwner,
        load: () => serialize(read),
        commit: (revision, state) => serialize(() => write(revision, state)),
        transaction: (fn) =>
          serialize(async () => {
            const current = await read();
            const result = await fn(current);
            if (result.state) await write(current.revision, result.state, result.beforeCommit);
            return result.value;
          })
      };
      try {
        let current: S | undefined;
        try {
          current = await raw.load(this.projectKey);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              error.message ===
                `${this.protocol.identity.formatName.charAt(0).toUpperCase() + this.protocol.identity.formatName.slice(1)} session does not exist: ${this.projectKey}`
            )
          )
            throw error;
        }
        if (current) {
          await this.validateAssets(current, gitFor(current.plan));
          const transition = this.protocol.advanceOwner(current, `owner-${randomUUID()}`, this.clock());
          if (transition.result.kind !== "epoch_advanced") throw new Error("Build owner epoch could not advance");
          await write(current.revision, transition.state);
        }
        return await callback(writer);
      } finally {
        await operation;
        activeLease = false;
      }
    });
  }
}
