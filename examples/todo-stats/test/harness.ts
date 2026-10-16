import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { NormalizedTask } from "../src/types.js";

const compiled = process.env.BUILD_SAMPLE_COMPILED_ROOT;
if (!compiled) throw new Error("HOST_CHECK_REQUIRED: run scripts/check-build-sample.mjs");
export const normalizeTasks = (await import(pathToFileURL(resolve(compiled, "src/normalize.js")).href))
  .normalizeTasks as (input: unknown) => NormalizedTask[];
export const renderReport = (await import(pathToFileURL(resolve(compiled, "src/report.js")).href)).renderReport as (
  tasks: NormalizedTask[]
) => string;
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
}
export function cli(input: string) {
  const result = spawnSync(process.execPath, [resolve(compiled!, "src/cli.js")], {
    input,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
/** Deterministic byte boundaries, without timing assumptions or real shell commands. */
export function cliChunks(input: string, splitByte: number) {
  const bytes = Buffer.from(input);
  const chunks = [
    bytes.subarray(0, splitByte),
    bytes.subarray(splitByte, splitByte + 1),
    bytes.subarray(splitByte + 1)
  ];
  const shim = `import { Readable } from "node:stream";
    const chunks = JSON.parse(process.argv[1]).map((chunk) => Buffer.from(chunk));
    Object.defineProperty(process, "stdin", { value: Readable.from(chunks, { objectMode: true }) });
    await import(process.argv[2]);`;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      shim,
      JSON.stringify(chunks.map((chunk) => [...chunk])),
      pathToFileURL(resolve(compiled!, "src/cli.js")).href
    ],
    { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
export function report(tasks: NormalizedTask[]): string {
  return `total: ${tasks.length}\npending: ${tasks.filter((task) => task.state === "pending").length}\ndone: ${tasks.filter((task) => task.state === "done").length}\ncancelled: ${tasks.filter((task) => task.state === "cancelled").length}\n`;
}
export const oldTask = { id: 10, title: "保留 内部 文字", done: false };
