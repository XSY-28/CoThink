import { spawn } from "node:child_process";
import { remaining } from "./measure.js";
/** A private process group prevents a timed-out Vitest parent leaving trusted CLI children running. */
export function runHostOracle(
  args: readonly string[],
  home: string,
  deadline: number,
  maxBytes: number
): Promise<{ status: number | null; stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve, reject) => {
    if (maxBytes < 1) {
      reject(new Error("AGENT_SYNC_ORACLE_LIMIT"));
      return;
    }
    const timeout = remaining(deadline);
    const child = spawn(process.execPath, [...args], {
      env: { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let size = 0,
      failed = false;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed = true;
        }
      }
    };
    const timer = setTimeout(() => {
      failed = true;
      kill();
    }, timeout);
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        kill();
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(out, chunk));
    child.stderr.on("data", (chunk) => collect(err, chunk));
    child.on("error", () => {
      failed = true;
      kill();
    });
    child.on("exit", kill);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      kill();
      resolve({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        failed: failed || signal !== null
      });
    });
  });
}
