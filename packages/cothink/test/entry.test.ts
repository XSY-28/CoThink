import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it.skipIf(process.platform === "win32")(
  "executable entry keeps --env-file as an application argument, without Node preloading it",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cothink-entry-"));
    try {
      const binary = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
      const result = await exec(binary, ["--version", "--env-file", join(directory, "does-not-exist.env")]);
      expect(result.stdout).toMatch(/CoThink v/);
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
