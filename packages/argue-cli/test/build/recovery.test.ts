import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  lstat,
  readdir,
  symlink,
  link,
  unlink
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBuildState, reserveBuildScope, parseBuildState, hashBuildValue } from "@onevcat/argue";
import { runInput } from "../../../argue/test/build/fixtures.js";
import { FileBuildStore, type FileBuildWriter } from "../../src/build/file-store.js";
import { exportAcceptedVersion, recoverBuild } from "../../src/build/recovery.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cothink-build-recovery-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function trustedHostAcceptance(
  writer: FileBuildWriter,
  taskId: "T-A" | "T-B1",
  text: string,
  corruptHash = false
) {
  const current = await writer.load();
  const path = taskId === "T-A" ? "src/normalize.ts" : "src/report.ts";
  const blob = await writer.git.writeBlob(text);
  const candidate = await writer.git.createSnapshot(current.acceptedVersion, [{ path, ...blob }]);
  // Prepares a known legacy accepted state to exercise export/recovery only. This
  // is deliberately not a Publisher or Docker gate, and proves no isolation.
  await writer.transaction(async (state) => {
    const reserved = reserveBuildScope(
      state,
      {
        taskId,
        workerId: taskId === "T-A" ? "member-a" : "member-b",
        requestId: `reserve-${taskId}`,
        ownerEpoch: state.ownerEpoch
      },
      1000,
      () => ({ attemptId: `attempt-${taskId}`, token: `token-${taskId}` })
    );
    if (reserved.result.kind !== "granted") throw new Error("host fixture not granted");
    const lease = reserved.result.lease;
    const candidateHash = corruptHash ? hashBuildValue("deliberately different files") : candidate.candidateHash;
    const checksHash = hashBuildValue("fixed trusted host fixture check");
    const checkReceiptId = `check-${taskId}`;
    const publication = {
      publishVersion: "build-publish-v1",
      receiptId: `publish-${taskId}`,
      attemptId: lease.attemptId,
      requestId: `finish-${taskId}`,
      checkReceiptId,
      baseVersion: state.acceptedVersion,
      acceptedVersion: candidate.version,
      candidateHash,
      checksHash
    };
    const next = parseBuildState({
      ...reserved.state,
      acceptedVersion: candidate.version,
      acceptedTasks: [...state.acceptedTasks, taskId],
      attempts: reserved.state.attempts.map((a) =>
        a.attemptId === lease.attemptId ? { ...a, status: "completed" } : a
      ),
      coordination: {
        ...reserved.state.coordination,
        taskStates: { ...reserved.state.coordination.taskStates, [taskId]: "completed" },
        locks: reserved.state.coordination.locks.filter((l) => l.attemptId !== lease.attemptId)
      },
      checkReceipts: [
        ...state.checkReceipts,
        {
          checkVersion: "build-check-v1",
          receiptId: checkReceiptId,
          attemptId: lease.attemptId,
          candidateHash,
          checksHash,
          groups: ["common"],
          toolchainHash: hashBuildValue("toolchain"),
          isolationHash: hashBuildValue("host fixture only"),
          exitCode: 0,
          passed: true
        }
      ],
      publishReceipts: [...state.publishReceipts, publication]
    });
    return { state: next, value: undefined };
  });
  return candidate.version;
}
async function trustedHostCheck(writer: FileBuildWriter, accepted: string, corruptHash = false) {
  const blob = await writer.git.writeBlob("checked but unaccepted");
  const candidate = await writer.git.createSnapshot(accepted, [{ path: "src/normalize.ts", ...blob }]);
  const view = await writer.git.readFiles(candidate.version);
  const records = Object.entries(view)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, file]) => ({ path, contentHash: file.contentHash }));
  const sourceHash = corruptHash ? hashBuildValue("wrong recorded source") : hashBuildValue(records);
  await writer.transaction(async (state) => {
    const reserved = reserveBuildScope(
      state,
      { taskId: "T-A", workerId: "member-a", requestId: "reserve-check", ownerEpoch: state.ownerEpoch },
      1000,
      () => ({ attemptId: "attempt-check", token: "token-check" })
    );
    if (reserved.result.kind !== "granted") throw new Error("fixture check lease missing");
    return {
      state: parseBuildState({
        ...reserved.state,
        checkReceipts: [
          {
            checkVersion: "build-check-v1",
            receiptId: "check-only",
            attemptId: "attempt-check",
            candidateHash: candidate.candidateHash,
            checksHash: hashBuildValue("trusted host recorded check"),
            groups: ["common"],
            toolchainHash: hashBuildValue("toolchain"),
            isolationHash: hashBuildValue("trusted fixture only"),
            exitCode: 1,
            passed: false,
            baseVersion: accepted,
            version: candidate.version,
            planHash: state.plan.planHash,
            imageDigest: "fixture.local/validator@sha256:" + "f".repeat(64),
            sourceHashBefore: sourceHash,
            sourceHashAfter: sourceHash
          }
        ]
      }),
      value: undefined
    };
  });
  return candidate.version;
}
async function fixture() {
  const source = join(root, "input");
  const managed = join(root, "managed");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(managed);
  await writeFile(join(source, "SPEC.md"), "spec");
  await writeFile(join(source, "src/normalize.ts"), "v0");
  await writeFile(join(source, "src/report.ts"), "total");
  const input = runInput();
  const store = new FileBuildStore({ workspaceRoot: managed, projectKey: input.projectKey, clock: () => 1000 });
  const initialize = async (writer: FileBuildWriter) => {
    const git = writer.gitFor(input.plan);
    await git.initialize();
    const version = await git.importSource(source);
    await writer.commit(-1, createBuildState({ ...input, acceptedVersion: version }));
    return version;
  };
  const bytes = () => readFile(join(managed, ".cothink-build/state/todo-stats/session.json"));
  return { source, managed, store, initialize, bytes };
}

describe("trusted host fixture recovery/export; no Docker publication evidence", { timeout: 120000 }, () => {
  test("retained unaccepted candidate cannot be exported or become formal authority", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      const accepted = await h.initialize(writer);
      const blob = await writer.git.writeBlob("unaccepted candidate");
      const candidate = await writer.git.createSnapshot(accepted, [{ path: "src/normalize.ts", ...blob }]);
      const before = await h.bytes();
      const target = join(root, "export");
      await expect(exportAcceptedVersion(writer, { version: candidate.version, target })).rejects.toThrow(/accepted/i);
      expect((await writer.load()).acceptedVersion).toBe(accepted);
      expect(await h.bytes()).toEqual(before);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  test("failure after complete preparation and before rename leaves formal bytes and target untouched", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      const accepted = await h.initialize(writer);
      const before = await h.bytes();
      const target = join(root, "export");
      await expect(
        exportAcceptedVersion(
          writer,
          { target },
          {
            beforeRename: async () => {
              throw new Error("host export interrupted");
            }
          }
        )
      ).rejects.toThrow("host export interrupted");
      expect((await writer.load()).acceptedVersion).toBe(accepted);
      expect(await h.bytes()).toEqual(before);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).filter((name) => name.startsWith(".cothink-export-"))).toEqual([]);
    });
  });
  test("full accepted snapshot is exported at one rename, and source/control bytes remain unchanged", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      const accepted = await h.initialize(writer);
      const before = await h.bytes();
      const target = join(root, "export");
      const result = await exportAcceptedVersion(
        writer,
        { target },
        {
          beforeRename: async () => {
            await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
            const temp = (await readdir(root)).find((name) => name.startsWith(".cothink-export-"))!;
            expect(await readFile(join(root, temp, "SPEC.md"), "utf8")).toBe("spec");
            expect(await readFile(join(root, temp, "src/normalize.ts"), "utf8")).toBe("v0");
            expect(await readFile(join(root, temp, "src/report.ts"), "utf8")).toBe("total");
          }
        }
      );
      expect(result).toEqual({ status: "exported", version: accepted, directory: target });
      expect(await readFile(join(target, "SPEC.md"), "utf8")).toBe("spec");
      expect(await readFile(join(target, "src/normalize.ts"), "utf8")).toBe("v0");
      expect(await readFile(join(target, "src/report.ts"), "utf8")).toBe("total");
      expect(await readFile(join(h.source, "src/normalize.ts"), "utf8")).toBe("v0");
      expect(await h.bytes()).toEqual(before);
    });
  });
  test("unsafe aliases, links, hardlinks, control directories, checkout paths and existing targets are refused", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      await h.initialize(writer);
      const occupied = join(root, "occupied");
      const empty = join(root, "empty");
      const linked = join(root, "linked");
      const linkedParent = join(root, "parent-link");
      const hardlinked = join(root, "hardlinked");
      const checkout = join(root, "daily-checkout");
      await writeFile(occupied, "do not overwrite");
      await mkdir(empty);
      await symlink(occupied, linked);
      await symlink(h.source, linkedParent);
      await link(occupied, hardlinked);
      await mkdir(checkout);
      await writeFile(join(checkout, ".git"), "fixture checkout marker");
      const before = await h.bytes();
      for (const target of [
        "relative",
        join(root, "missing-parent/export"),
        root + "/input/../export",
        linked,
        join(linkedParent, "export"),
        hardlinked,
        join(writer.controlRoot, "export"),
        join(checkout, "export"),
        occupied,
        empty,
        join(root, "OCCUPIED")
      ]) {
        await expect(exportAcceptedVersion(writer, { target })).rejects.toThrow();
        expect(await h.bytes()).toEqual(before);
      }
      expect(await readFile(occupied, "utf8")).toBe("do not overwrite");
      expect(await readdir(empty)).toEqual([]);
      expect((await readdir(root)).filter((name) => name.startsWith(".cothink-export-"))).toEqual([]);
    });
  });
  test("target created during preparation is preserved and our own partial temporary directory is cleaned", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      await h.initialize(writer);
      const before = await h.bytes();
      const target = join(root, "export");
      await expect(
        exportAcceptedVersion(
          writer,
          { target },
          {
            beforeRename: async () => {
              await mkdir(target);
              await writeFile(join(target, "other.txt"), "other owner");
            }
          }
        )
      ).rejects.toThrow(/exists|aliases/i);
      expect(await readFile(join(target, "other.txt"), "utf8")).toBe("other owner");
      expect(await h.bytes()).toEqual(before);
      expect((await readdir(root)).filter((name) => name.startsWith(".cothink-export-"))).toEqual([]);
    });
  });
  test("recovery after writer reacquisition preserves accepted state, revokes leases, and calls no model", async () => {
    const h = await fixture();
    let accepted = "";
    await h.store.withWriter(async (writer) => {
      accepted = await h.initialize(writer);
      await writer.transaction(async (current) => {
        const reserved = reserveBuildScope(
          current,
          { taskId: "T-A", workerId: "member-a", requestId: "reserve-a", ownerEpoch: 1 },
          1000,
          () => ({ attemptId: "attempt-a", token: "token-a" })
        );
        expect(reserved.result.kind).toBe("granted");
        return { state: reserved.state, value: undefined };
      });
    });
    await h.store.withWriter(async (writer) => {
      const before = await h.bytes();
      const result = await recoverBuild(writer);
      expect(result).toEqual({
        status: "recovered",
        acceptedVersion: accepted,
        acceptedTasks: [],
        publishReceipts: [],
        modelCalls: 0
      });
      const state = await writer.load();
      expect(state.ownerEpoch).toBe(2);
      expect(state.coordination.locks).toEqual([]);
      expect(state.attempts[0]!.status).toBe("paused");
      expect(state.calls).toEqual([]);
      expect(await h.bytes()).toEqual(before);
    });
  });
  test("missing accepted object fails closed and retained refs never replace it", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      const accepted = await h.initialize(writer);
      const blob = await writer.git.writeBlob("orphan retained snapshot");
      await writer.git.createSnapshot(accepted, [{ path: "src/normalize.ts", ...blob }]);
      const before = await h.bytes();
      await unlink(join(writer.controlRoot, "git/objects", accepted.slice(0, 2), accepted.slice(2)));
      await expect(recoverBuild(writer)).rejects.toThrow();
      expect(await h.bytes()).toEqual(before);
    });
  });
  test("historical accepted versions are exportable; later retained candidates are not", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      await h.initialize(writer);
      const first = await trustedHostAcceptance(writer, "T-A", "accepted normalizer");
      const second = await trustedHostAcceptance(writer, "T-B1", "accepted report");
      const before = await h.bytes();
      await exportAcceptedVersion(writer, { version: first, target: join(root, "first") });
      await exportAcceptedVersion(writer, { target: join(root, "latest") });
      expect(await readFile(join(root, "first/src/normalize.ts"), "utf8")).toBe("accepted normalizer");
      expect(await readFile(join(root, "first/src/report.ts"), "utf8")).toBe("total");
      expect(await readFile(join(root, "latest/src/report.ts"), "utf8")).toBe("accepted report");
      const recovered = await recoverBuild(writer);
      expect(recovered.acceptedVersion).toBe(second);
      expect(recovered.acceptedTasks).toEqual(["T-A", "T-B1"]);
      expect(recovered.publishReceipts).toHaveLength(2);
      expect(recovered.modelCalls).toBe(0);
      expect(await h.bytes()).toEqual(before);
    });
  });
  test("recovery rejects a published candidate hash that matches its check but not actual immutable files", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      await h.initialize(writer);
      await trustedHostAcceptance(writer, "T-A", "published normalizer", true);
      const before = await h.bytes();
      await expect(recoverBuild(writer)).rejects.toThrow(/candidate.*hash/i);
      expect(await h.bytes()).toEqual(before);
    });
  });
  test("tampered prepared export is refused instead of claiming the immutable version", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      await h.initialize(writer);
      const before = await h.bytes();
      const target = join(root, "export");
      await expect(
        exportAcceptedVersion(
          writer,
          { target },
          {
            beforeRename: async () => {
              const temp = (await readdir(root)).find((name) => name.startsWith(".cothink-export-"))!;
              await writeFile(join(root, temp, "src/normalize.ts"), "tampered preparation");
            }
          }
        )
      ).rejects.toThrow(/export.*content|content.*mismatch/i);
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await h.bytes()).toEqual(before);
    });
  });
  test.each(["missing-object", "wrong-source-hash"])(
    "recovery validates actual version assets of an unaccepted recorded check: %s",
    async (fault) => {
      const h = await fixture();
      await h.store.withWriter(async (writer) => {
        const accepted = await h.initialize(writer);
        const checked = await trustedHostCheck(writer, accepted, fault === "wrong-source-hash");
        const before = await h.bytes();
        if (fault === "missing-object")
          await unlink(join(writer.controlRoot, "git/objects", checked.slice(0, 2), checked.slice(2)));
        await expect(recoverBuild(writer)).rejects.toThrow();
        expect(await h.bytes()).toEqual(before);
      });
    }
  );
  test("writer ownership changed after preparation prevents export and leaves accepted bytes untouched", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      await h.initialize(writer);
      const before = await h.bytes();
      const lock = join(writer.controlRoot, "state/todo-stats/.writer.lock");
      const lockBytes = await readFile(lock);
      const target = join(root, "export");
      try {
        await expect(
          exportAcceptedVersion(
            writer,
            { target },
            {
              beforeRename: async () => {
                await writeFile(
                  lock,
                  JSON.stringify({ pid: process.pid, nonce: "00000000-0000-0000-0000-000000000000" })
                );
              }
            }
          )
        ).rejects.toThrow(/ownership|lock|lease/i);
        await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await h.bytes()).toEqual(before);
        expect((await readdir(root)).filter((name) => name.startsWith(".cothink-export-"))).toEqual([]);
      } finally {
        await writeFile(lock, lockBytes);
      }
    });
  });
  test("a post-rename sync failure can retry the same exact snapshot target without overwriting or changing formal state", async () => {
    const h = await fixture();
    await h.store.withWriter(async (writer) => {
      const accepted = await h.initialize(writer);
      const before = await h.bytes();
      const target = join(root, "export");
      await expect(
        exportAcceptedVersion(
          writer,
          { target },
          {
            beforeParentSync: async () => {
              expect(await readFile(join(target, "src/normalize.ts"), "utf8")).toBe("v0");
              throw new Error("parent sync interrupted after rename");
            }
          }
        )
      ).rejects.toThrow("parent sync interrupted after rename");
      expect(await h.bytes()).toEqual(before);
      const originalIdentity = await lstat(target);
      expect(await exportAcceptedVersion(writer, { version: accepted, target })).toEqual({
        status: "exported",
        version: accepted,
        directory: target
      });
      const retriedIdentity = await lstat(target);
      expect([retriedIdentity.dev, retriedIdentity.ino]).toEqual([originalIdentity.dev, originalIdentity.ino]);
      expect(await readFile(join(target, "src/normalize.ts"), "utf8")).toBe("v0");
      expect(await h.bytes()).toEqual(before);
      expect((await writer.load()).calls).toEqual([]);
      await writeFile(join(target, "src/normalize.ts"), "externally changed target");
      await expect(exportAcceptedVersion(writer, { version: accepted, target })).rejects.toThrow(/content.*mismatch/i);
      expect(await readFile(join(target, "src/normalize.ts"), "utf8")).toBe("externally changed target");
      expect(await h.bytes()).toEqual(before);
    });
  });
});
