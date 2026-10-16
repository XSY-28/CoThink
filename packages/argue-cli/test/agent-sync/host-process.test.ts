import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { runHostOracle } from "../../src/agent-sync/checks/host-process.js";
it("kills a real oracle process group including its child at the one monotonic deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-sync-process-"));
  const path = join(root, "oracle.mjs");
  try {
    await writeFile(
      path,
      `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(child.pid));setInterval(()=>{},1000);`
    );
    const start = performance.now(),
      result = await runHostOracle([path], root, start + 300, 1024);
    expect(result.failed).toBe(true);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(performance.now() - start).toBeGreaterThanOrEqual(290);
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    // macOS may briefly retain a killed child until its adopted parent reaps it.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
