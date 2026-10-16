import { test, expect, vi } from "vitest";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { installDiagnostics } from "../../../../tools/agent-sync/diagnostics.mjs";
test("observer joins named Docker cleanup to its actual created ID without logging arguments (process double only)", () => {
  const originalSpawn = cp.spawn,
    originalSync = cp.spawnSync,
    output = new PassThrough(),
    chunks: Buffer[] = [];
  output.on("data", (b: Buffer) => chunks.push(b));
  const fakeId = "a".repeat(64),
    name = "cothink-check-11111111-2222-3333-4444-555555555555";
  const spy = vi.spyOn(cp, "spawnSync").mockReturnValue({
    status: 0,
    stdout: Buffer.from(fakeId + "\n"),
    stderr: Buffer.alloc(0),
    output: [],
    pid: 7,
    signal: null
  });
  try {
    installDiagnostics(output);
    cp.spawnSync("docker", ["create", "--name", name, "fixed-image"]);
    cp.spawnSync("docker", ["rm", "-f", name]);
    const events = Buffer.concat(chunks)
      .toString()
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(events).toContainEqual(
      expect.objectContaining({ event: "container-remove-ended", containerId: fakeId, status: 0 })
    );
    expect(Buffer.concat(chunks).toString()).not.toContain("fixed-image");
  } finally {
    spy.mockRestore();
    cp.spawn = originalSpawn;
    cp.spawnSync = originalSync;
    syncBuiltinESMExports();
    output.destroy();
  }
});
