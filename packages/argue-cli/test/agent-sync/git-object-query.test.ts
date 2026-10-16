import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAgentSyncStore } from "../../src/agent-sync/project/storage.js";
import type { ManifestGitSnapshots } from "../../src/agent-sync/kernel/git-snapshots.js";
import { projectState } from "../../../argue/test/agent-sync/project-fixture.js";

type InternalGit = {
  git(args: string[], input?: string | Buffer, requireRepo?: boolean): Promise<Buffer>;
  assertOwner(): Promise<void>;
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function withGit(action: (git: ManifestGitSnapshots, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-object-query-")));
  roots.push(root);
  const store = new FileAgentSyncStore({ workspaceRoot: root, projectKey: "project" });
  await store.withWriter(async (writer) => {
    const git = writer.gitFor(projectState(1).plan);
    await git.initialize();
    await action(git, root);
  });
}

describe("fresh immutable Git object queries", { timeout: 30000 }, () => {
  test("reads Unicode/newlines with one type-and-payload query per blob, and no cross-operation reuse", async () => {
    await withGit(async (git) => {
      const text = "amount € 中文\nsecond line\n";
      const blob = await git.writeBlob(text);
      const internal = git as unknown as InternalGit;
      const original = internal.git.bind(git);
      const commands: string[][] = [];
      internal.git = async (args, input, requireRepo) => {
        if (args[0] === "cat-file") commands.push(args);
        return original(args, input, requireRepo);
      };
      expect(await git.readBlob(blob.blobId)).toBe(text);
      expect(commands).toEqual([["cat-file", "--batch"]]);
      expect(await git.readBlob(blob.blobId)).toBe(text);
      expect(commands).toHaveLength(2);
    });
  });

  test("keeps actual missing-object and wrong-type refusals", async () => {
    await withGit(async (git, root) => {
      await expect(git.readBlob("f".repeat(40))).rejects.toThrow("BUILD_GIT_FAILED");
      const source = join(root, "input");
      await mkdir(source);
      const version = await git.importSource(source);
      await expect(git.readBlob(version)).rejects.toThrow("BUILD_OBJECT_TYPE");
    });
  });

  test.each(["short", "extra", "id", "hash", "size"])("rejects %s object response before use", async (fault) => {
    await withGit(async (git) => {
      const text = "value\n",
        blob = await git.writeBlob(text);
      let id = blob.blobId,
        payload = Buffer.from(text),
        size = payload.length,
        end = Buffer.from("\n");
      if (fault === "short") payload = payload.subarray(0, 2);
      if (fault === "extra") end = Buffer.from("\nextra");
      if (fault === "id") id = "a".repeat(40);
      if (fault === "hash") payload = Buffer.from("other\n");
      if (fault === "size") size++;
      const response = Buffer.concat([Buffer.from(`${id} blob ${size}\n`), payload, end]);
      const internal = git as unknown as InternalGit;
      const original = internal.git.bind(git);
      internal.git = (args, input, requireRepo) =>
        args[0] === "cat-file" && args[1] === "--batch"
          ? Promise.resolve(response)
          : original(args, input, requireRepo);
      await expect(git.readBlob(blob.blobId)).rejects.toThrow("BUILD_OBJECT_CORRUPT");
    });
  });

  test("checks current owner again before returning a successfully read payload", async () => {
    await withGit(async (git) => {
      const blob = await git.writeBlob("value\n");
      const internal = git as unknown as InternalGit;
      const original = internal.git.bind(git),
        owner = internal.assertOwner.bind(git);
      let revoked = false;
      internal.assertOwner = async () => {
        if (revoked) throw new Error("TEST_OWNER_REVOKED");
        await owner();
      };
      internal.git = async (args, input, requireRepo) => {
        const value = await original(args, input, requireRepo);
        if (args[0] === "cat-file") revoked = true;
        return value;
      };
      await expect(git.readBlob(blob.blobId)).rejects.toThrow("TEST_OWNER_REVOKED");
    });
  });
});
