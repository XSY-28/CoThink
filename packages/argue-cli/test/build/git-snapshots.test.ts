import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  symlink,
  link,
  rename,
  readdir,
  lstat,
  realpath
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { freezeBuildPlan, hashBuildValue, type BuildPlan } from "@onevcat/argue";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { GitSnapshots } from "../../src/build/git-snapshots.js";

const roots: string[] = [];
const sample = resolve("../../examples/todo-stats");
const planInput = JSON.parse(await readFile(join(sample, "build-plan.json"), "utf8"));
delete planInput.planHash;
const plan = freezeBuildPlan(planInput);
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function setup(selectedPlan: BuildPlan = plan, guard: () => Promise<void> = async () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-git-stage2-")));
  roots.push(root);
  const control = join(root, ".cothink-build");
  const source = join(root, "source");
  await mkdir(control);
  await mkdir(source);
  await writeFile(
    join(control, "project.json"),
    JSON.stringify({
      identityVersion: "build-project-v1",
      projectKey: selectedPlan.projectKey,
      workspaceRoot: root,
      controlDirectory: ".cothink-build"
    })
  );
  for (const entry of plan.manifest) {
    await mkdir(join(source, entry.path, ".."), { recursive: true });
    await writeFile(join(source, entry.path), await readFile(join(sample, entry.path)));
  }
  return { root, source, control, git: new GitSnapshots(control, selectedPlan, guard) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Host-only fault preparation in the test-owned bare repository. No checkout or acceptedVersion is changed.
async function rawGit(control: string, args: string[], input?: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@localhost"
  });
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", join(control, "git"), ...args], {
      env,
      stdio: "pipe"
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveResult(Buffer.concat(out).toString().trim())
        : reject(new Error(Buffer.concat(err).toString()))
    );
    child.stdin.end(input);
  });
}
async function sourceBytes(source: string) {
  return Promise.all(
    plan.manifest.map(async (entry) => [entry.path, await readFile(join(source, entry.path), "utf8")])
  );
}

it("refuses binary/NUL and invalid surrogate content before writing a Git object", async () => {
  const { git } = await setup();
  await git.initialize();
  await expect(async () => git.writeBlob("text\0binary")).rejects.toThrow("BINARY");
  await expect(async () => git.writeBlob("bad\ud800")).rejects.toThrow("UTF8");
});

it("does not silently initialize over an unknown existing repository directory", async () => {
  const { control, git } = await setup();
  await mkdir(join(control, "git"));
  await writeFile(join(control, "git", "unknown"), "foreign state");
  await expect(git.initialize()).rejects.toThrow("UNKNOWN_GIT");
  expect(await readFile(join(control, "git", "unknown"), "utf8")).toBe("foreign state");
});

it("imports exactly the 11 manifest files, preserves source bytes, and reads fixed old versions", async () => {
  const { source, control, git } = await setup();
  const before = await sourceBytes(source);
  await writeFile(join(source, "not-imported.txt"), "private input");
  await git.initialize();
  const baseline = await git.importSource(source);
  expect((await rawGit(control, ["ls-tree", "-r", "--name-only", baseline])).split("\n")).toHaveLength(11);
  const old = await git.readFile(baseline, "src/normalize.ts");
  const a = await git.writeBlob("host-prepared task A candidate\n");
  const b = await git.writeBlob("host-prepared task B1 candidate\n");
  const candidateA = await git.createSnapshot(baseline, [{ path: "src/normalize.ts", ...a }]);
  const candidateB = await git.createSnapshot(baseline, [{ path: "src/report.ts", ...b }]);
  expect(await git.readFile(baseline, "src/normalize.ts")).toEqual(old);
  expect((await git.readFile(candidateA.version, "src/normalize.ts")).text).toBe("host-prepared task A candidate\n");
  expect((await git.readFile(candidateA.version, "src/report.ts")).contentHash).toBe(
    plan.manifest.find((file) => file.path === "src/report.ts")!.contentHash
  );
  expect((await git.readFile(candidateB.version, "src/normalize.ts")).contentHash).toBe(old.contentHash);
  expect((await git.readFile(candidateB.version, "src/report.ts")).text).toBe("host-prepared task B1 candidate\n");
  const files = await Promise.all(
    [...plan.manifest]
      .sort((x, y) => (x.path < y.path ? -1 : 1))
      .map(async (entry) => ({
        path: entry.path,
        contentHash: (await git.readFile(candidateA.version, entry.path)).contentHash
      }))
  );
  expect(candidateA.candidateHash).toBe(hashBuildValue({ baseVersion: baseline, files }));
  expect(await git.createSnapshot(baseline, [{ path: "src/normalize.ts", ...a }])).toEqual(candidateA);
  expect(await sourceBytes(source)).toEqual(before);
  expect(await rawGit(control, ["symbolic-ref", "HEAD"])).toBe("refs/heads/master");
  expect(await rawGit(control, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("");
  const restarted = new GitSnapshots(control, plan, async () => {});
  await restarted.initialize();
  await restarted.assertSnapshot(candidateA.version);
}, 30_000);

it.each([
  "/src/normalize.ts",
  "../src/normalize.ts",
  "src/../normalize.ts",
  "src/Normalize.ts",
  "src//normalize.ts",
  "unknown.ts"
])("rejects exact-path violation %s before reading content", async (path) => {
  const { source, git } = await setup();
  await git.initialize();
  const version = await git.importSource(source);
  await expect(async () => git.readFile(version, path)).rejects.toThrow("UNKNOWN_PATH");
});

it.each(["SPEC.md", "package.json", "tsconfig.json", "fixtures/legacy.json", "src/cli.ts"])(
  "rejects candidate edit to frozen %s",
  async (path) => {
    const { source, git } = await setup();
    await git.initialize();
    const version = await git.importSource(source);
    const blob = await git.writeBlob("attempted replacement\n");
    await expect(git.createSnapshot(version, [{ path, ...blob }])).rejects.toThrow("READ_ONLY");
    expect((await git.readFile(version, path)).contentHash).toBe(
      plan.manifest.find((entry) => entry.path === path)!.contentHash
    );
  }
);

it("rejects duplicate edits, wrong object type and incorrect blob content hash", async () => {
  const { source, git } = await setup();
  await git.initialize();
  const version = await git.importSource(source);
  const blob = await git.writeBlob("candidate\n");
  const edit = { path: "src/report.ts", ...blob };
  await expect(git.createSnapshot(version, [edit, edit])).rejects.toThrow("DUPLICATE");
  await expect(git.createSnapshot(version, [{ ...edit, contentHash: hash("different") }])).rejects.toThrow(
    "HASH_MISMATCH"
  );
  await expect(git.readBlob(version)).rejects.toThrow("OBJECT_TYPE");
  await expect(git.readBlob("0".repeat(40))).rejects.toThrow();
  await expect(git.assertSnapshot("HEAD")).rejects.toThrow("INVALID_OBJECT");
});

it.each(["symlink-file", "symlink-dir", "hardlink", "case-alias", "binary", "hash-mismatch", "missing"])(
  "rejects unsafe source %s and leaves input intact",
  async (kind) => {
    const { root, source, git } = await setup();
    const path = join(source, "src/normalize.ts");
    if (kind === "symlink-file") {
      await rename(path, join(root, "target"));
      await symlink(join(root, "target"), path);
    }
    if (kind === "symlink-dir") {
      await rename(join(source, "src"), join(root, "outside-src"));
      await symlink(join(root, "outside-src"), join(source, "src"));
    }
    if (kind === "hardlink") await link(path, join(root, "second-link"));
    if (kind === "case-alias") await rename(path, join(source, "src/Normalize.ts"));
    if (kind === "binary") await writeFile(path, Buffer.from([0xff, 0x00]));
    if (kind === "hash-mismatch") await writeFile(path, "changed source");
    if (kind === "missing") await rm(path);
    await git.initialize();
    await expect(git.importSource(source)).rejects.toThrow();
    if (kind === "symlink-file") expect((await lstat(path)).isSymbolicLink()).toBe(true);
    if (kind === "binary") expect(await readFile(path)).toEqual(Buffer.from([0xff, 0x00]));
  }
);

it("supports declared absent writable new files without accepting unexpected initial content", async () => {
  const input = structuredClone(planInput);
  input.manifest.push({ path: "src/new.ts", access: "writable", contentHash: null });
  const newPlan = freezeBuildPlan(input);
  const { source, git } = await setup(newPlan);
  await git.initialize();
  const version = await git.importSource(source);
  expect(await git.readFile(version, "src/new.ts")).toEqual({ text: null, contentHash: null, blobId: null });
  const blob = await git.writeBlob("new file\n");
  const candidate = await git.createSnapshot(version, [{ path: "src/new.ts", ...blob }]);
  expect((await git.readFile(candidate.version, "src/new.ts")).text).toBe("new file\n");
  await writeFile(join(source, "src/new.ts"), "unexpected");
  await expect(git.importSource(source)).rejects.toThrow("UNEXPECTED_SOURCE_FILE");
});

it("validates snapshot modes, undeclared entries and frozen hashes even for host-created objects", async () => {
  const { control, git } = await setup();
  await git.initialize();
  const blob = await git.writeBlob("malicious\n");
  for (const record of [
    `120000 blob ${blob.blobId}\tSPEC.md\0`,
    `100755 blob ${blob.blobId}\tSPEC.md\0`,
    `100644 blob ${blob.blobId}\tunknown.txt\0`,
    `100644 blob ${blob.blobId}\tSPEC.md\0`
  ]) {
    const tree = await rawGit(control, ["mktree", "-z"], record);
    const version = await rawGit(control, ["commit-tree", tree], "host-prepared invalid object\n");
    await expect(git.assertSnapshot(version)).rejects.toThrow();
  }
});

it("rejects marker mismatch, alternate controls, links and repository replacement", async () => {
  const { root, control, git } = await setup();
  await git.initialize();
  const other = join(root, "alternate-control");
  await mkdir(other);
  await expect(new GitSnapshots(other, plan, async () => {}).initialize()).rejects.toThrow("CONTROL_DIRECTORY");
  await rename(join(control, "git"), join(root, "original-git"));
  await mkdir(join(control, "git"));
  await expect(git.initialize()).rejects.toThrow("REPLACED");
  await rm(join(control, "git"), { recursive: true });
  await symlink(join(root, "original-git"), join(control, "git"));
  await expect(git.writeBlob("blocked")).rejects.toThrow("GIT_LINK");
  const marker = JSON.parse(await readFile(join(control, "project.json"), "utf8"));
  marker.projectKey = "other";
  await writeFile(join(control, "project.json"), JSON.stringify(marker));
  await expect(git.initialize()).rejects.toThrow("PROJECT_IDENTITY");
});

it("rechecks owner for all actions and strips Git environment redirection", async () => {
  let valid = true;
  let checks = 0;
  const { root, git } = await setup(plan, async () => {
    checks++;
    if (!valid) throw new Error("OWNER_REVOKED");
  });
  await git.initialize();
  const foreign = join(root, "foreign-objects");
  await mkdir(foreign);
  const previous = process.env.GIT_OBJECT_DIRECTORY;
  process.env.GIT_OBJECT_DIRECTORY = foreign;
  try {
    await git.writeBlob("correctly managed\n");
  } finally {
    if (previous === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
    else process.env.GIT_OBJECT_DIRECTORY = previous;
  }
  expect(await readdir(foreign)).toEqual([]);
  expect(checks).toBeGreaterThan(10);
  valid = false;
  await expect(git.writeBlob("denied")).rejects.toThrow("OWNER_REVOKED");
  await expect(git.readBlob("0".repeat(40))).rejects.toThrow("OWNER_REVOKED");
});

it("fails closed on corrupted objects and missing candidate objects", async () => {
  const { source, control, git } = await setup();
  await git.initialize();
  const version = await git.importSource(source);
  const file = await git.readFile(version, "src/report.ts");
  const objectPath = join(control, "git", "objects", file.blobId!.slice(0, 2), file.blobId!.slice(2));
  await rm(objectPath);
  await writeFile(objectPath, "corrupt object");
  await expect(git.readBlob(file.blobId!)).rejects.toThrow();
  await expect(git.assertSnapshot(version)).rejects.toThrow();
});

it("does not report a durable candidate when object/ref preparation is interrupted", async () => {
  const { source, control, git } = await setup();
  await git.initialize();
  const version = await git.importSource(source);
  const blob = await git.writeBlob("candidate\n");
  const interrupted = new GitSnapshots(control, plan, async () => {}, {
    beforeRefWrite: async () => {
      throw new Error("REF_INTERRUPTED");
    }
  });
  await expect(interrupted.createSnapshot(version, [{ path: "src/report.ts", ...blob }])).rejects.toThrow(
    "REF_INTERRUPTED"
  );
  const objectInterrupted = new GitSnapshots(control, plan, async () => {}, {
    beforeObjectWrite: async () => {
      throw new Error("OBJECT_INTERRUPTED");
    }
  });
  await expect(objectInterrupted.writeBlob("never written")).rejects.toThrow("OBJECT_INTERRUPTED");
  await git.assertSnapshot(version);
  const refs = await rawGit(control, ["for-each-ref", "--format=%(objectname)", "refs/cothink/snapshots"]);
  expect(refs.split("\n")).toEqual([version]);
  const successful = await git.createSnapshot(version, [{ path: "src/report.ts", ...blob }]);
  await new GitSnapshots(control, plan, async () => {}).assertSnapshot(successful.version);
});

it("rejects modified local Git configuration and alternate object directories", async () => {
  const { control, git } = await setup();
  await git.initialize();
  const config = await readFile(join(control, "git/config"));
  await writeFile(join(control, "git/config"), "[core]\n bare = true\n[include]\n path = /dev/null\n");
  await expect(git.writeBlob("blocked config")).rejects.toThrow("CONFIG_CHANGED");
  await writeFile(join(control, "git/config"), config);
  await writeFile(join(control, "git/objects/info/alternates"), "/private/tmp/foreign-objects\n");
  await expect(git.writeBlob("blocked alternates")).rejects.toThrow("ALTERNATES");
});

it("checks actual blob hashes even when corrupt loose objects contain valid compressed data", async () => {
  const { control, git } = await setup();
  await git.initialize();
  const blob = await git.writeBlob("original\n");
  const path = join(control, "git/objects", blob.blobId.slice(0, 2), blob.blobId.slice(2));
  await rm(path);
  const replacement = Buffer.from("different\n");
  await writeFile(path, deflateSync(Buffer.concat([Buffer.from(`blob ${replacement.length}\0`), replacement])));
  await expect(git.readBlob(blob.blobId)).rejects.toThrow("OBJECT_CORRUPT");
});

it("validates all edits before candidate ref creation and rechecks revocation at ref retention", async () => {
  let active = true;
  const owner = async () => {
    if (!active) throw new Error("OWNER_REVOKED");
  };
  const { source, control, git } = await setup(plan, owner);
  await git.initialize();
  const baseline = await git.importSource(source);
  const blob = await git.writeBlob("candidate\n");
  await expect(
    git.createSnapshot(baseline, [
      { path: "src/normalize.ts", ...blob },
      { path: "src/report.ts", ...blob, contentHash: hash("wrong") }
    ])
  ).rejects.toThrow("HASH_MISMATCH");
  expect(
    (await rawGit(control, ["for-each-ref", "--format=%(objectname)", "refs/cothink/snapshots"])).split("\n")
  ).toEqual([baseline]);
  const revoked = new GitSnapshots(control, plan, owner, {
    beforeRefWrite: async () => {
      active = false;
    }
  });
  await expect(revoked.createSnapshot(baseline, [{ path: "src/normalize.ts", ...blob }])).rejects.toThrow(
    "OWNER_REVOKED"
  );
  active = true;
  await git.assertSnapshot(baseline);
  expect(
    (await rawGit(control, ["for-each-ref", "--format=%(objectname)", "refs/cothink/snapshots"])).split("\n")
  ).toEqual([baseline]);
}, 15_000);

it("preserves UTF-8 Unicode and BOM bytes in immutable blobs", async () => {
  const { git } = await setup();
  await git.initialize();
  const text = "\uFEFF待办 😀 e\u0301\n";
  const blob = await git.writeBlob(text);
  expect(blob.contentHash).toBe(hash(text));
  expect(await git.readBlob(blob.blobId)).toBe(text);
});

it("refuses to recreate a missing repository while its durable identity survives", async () => {
  const { control, git } = await setup();
  await git.initialize();
  await rm(join(control, "git"), { recursive: true });
  await expect(git.initialize()).rejects.toThrow("GIT_MISSING");
  await expect(lstat(join(control, "git"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["src", "SRC/new.ts"])(
  "rejects file/directory and component alias conflicts %s before disk actions",
  (path) => {
    const input = structuredClone(planInput);
    input.manifest.push({ path, access: "writable", contentHash: null });
    const conflicting = freezeBuildPlan(input);
    expect(() => new GitSnapshots("/private/tmp/.cothink-build", conflicting, async () => {})).toThrow(
      "NAMESPACE_CONFLICT"
    );
  }
);

it("returns a deeply immutable full version view and rechecks corruption on each action", async () => {
  const input = structuredClone(planInput);
  input.manifest.push({ path: "src/new.ts", access: "writable", contentHash: null });
  input.manifest.push({ path: "__proto__", access: "writable", contentHash: null });
  const selected = freezeBuildPlan(input);
  const { source, control, git } = await setup(selected);
  await git.initialize();
  const baseline = await git.importSource(source);
  const view = await git.readFiles(baseline);
  expect(Object.keys(view)).toHaveLength(13);
  expect(view["src/new.ts"]).toEqual({ text: null, contentHash: null, blobId: null });
  expect(Object.hasOwn(view, "__proto__")).toBe(true);
  expect(view["__proto__"]).toEqual({ text: null, contentHash: null, blobId: null });
  expect(view["src/report.ts"]).toEqual(await git.readFile(baseline, "src/report.ts"));
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view["src/report.ts"])).toBe(true);
  expect(() => {
    (view as Record<string, unknown>)["src/report.ts"] = "changed";
  }).toThrow();
  const blobId = view["src/report.ts"]!.blobId!;
  await rm(join(control, "git/objects", blobId.slice(0, 2), blobId.slice(2)));
  await expect(git.readFiles(baseline)).rejects.toThrow();
  expect(view["src/report.ts"]!.text).toBe(await readFile(join(source, "src/report.ts"), "utf8"));
});
