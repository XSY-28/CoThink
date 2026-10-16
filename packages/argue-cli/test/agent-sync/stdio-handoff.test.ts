import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHandoff } from "../../../../tools/agent-sync/handoff.mjs";
const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
test.each(["before\n", "\ufeffbefore\n"])(
  "artifact formatter binds original bytes %j and rejects drift (not verification evidence)",
  async (before) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agent-sync-handoff-unit-"))),
      sourceRoot = join(root, "source"),
      exportDirectory = join(root, "accepted");
    try {
      await mkdir(sourceRoot);
      await mkdir(exportDirectory);
      await writeFile(join(sourceRoot, "file.ts"), before);
      await writeFile(join(exportDirectory, "file.ts"), "after\n");
      const options = {
        sourceRoot,
        exportDirectory,
        project: { projectKey: "unit", manifest: [{ path: "file.ts", contentHash: hash(before) }] },
        baselineVersion: "1".repeat(40),
        diff: {
          fromVersion: "1".repeat(40),
          toVersion: "2".repeat(40),
          files: [{ path: "file.ts", beforeHash: hash(before), afterHash: hash("after\n") }]
        },
        validation: { fixtureOnly: true },
        target: join(root, "handoff")
      };
      const report = await createHandoff(options);
      expect(await readFile(report.patchFile, "utf8")).toContain("-" + before + "+after\n");
      expect(report.guard.directOverwrite).toBe(false);
      await writeFile(join(sourceRoot, "file.ts"), "changed original\n");
      await expect(createHandoff({ ...options, target: join(root, "drift") })).rejects.toMatchObject({
        code: "handoff_source_changed"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
