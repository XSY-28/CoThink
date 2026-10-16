import { TextDecoder } from "node:util";
import process from "node:process";
import { readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SyncPathSchema } from "@onevcat/argue/agent-sync/project";
import { wireError } from "./protocol.mjs";
const exec = promisify(execFile),
  hash = (text) => (text === null ? null : "sha256:" + createHash("sha256").update(text, "utf8").digest("hex"));
async function textAt(root, path) {
  SyncPathSchema.parse(path);
  const file = join(root, path);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(file)) !== resolve(file))
      throw wireError("handoff_source_changed");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
/** Readonly Git guard. It never applies, branches, stages or commits. */
export async function repositoryGuard({ root, expectedHead, home }) {
  const env = {
    PATH: process.env.PATH,
    HOME: home ?? root,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0"
  };
  const run = async (args) =>
    (
      await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
        cwd: root,
        env,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024
      })
    ).stdout.trim();
  try {
    const head = await run(["rev-parse", "--verify", "HEAD"]);
    if (head !== expectedHead) return { directOverwrite: false, code: "base_moved", expectedHead, currentHead: head };
    const dirty = (await run(["status", "--porcelain=v1", "--untracked-files=normal"])).length > 0;
    return {
      directOverwrite: false,
      code: dirty ? "local_changes" : "manual_review_required",
      expectedHead,
      currentHead: head,
      dirty
    };
  } catch {
    return { directOverwrite: false, code: "repository_unverified" };
  }
}
function hunk(path, before, after) {
  const lines = (text) =>
    text === null || text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const old = lines(before),
    fresh = lines(after),
    body = [];
  body.push(
    `--- ${before === null ? "/dev/null" : "a/" + path}`,
    `+++ ${after === null ? "/dev/null" : "b/" + path}`,
    `@@ -${old.length ? 1 : 0},${old.length} +${fresh.length ? 1 : 0},${fresh.length} @@`
  );
  for (const line of old) body.push("-" + line);
  if (before !== null && before !== "" && !before.endsWith("\n")) body.push("\\ No newline at end of file");
  for (const line of fresh) body.push("+" + line);
  if (after !== null && after !== "" && !after.endsWith("\n")) body.push("\\ No newline at end of file");
  return body.join("\n") + "\n";
}
/** Trusted caller artifact formatting only; verification/publication are exclusively existing service operations. */
export async function createHandoff({
  sourceRoot,
  exportDirectory,
  project,
  baselineVersion,
  diff,
  validation,
  target,
  repository
}) {
  if (diff.fromVersion !== baselineVersion) throw wireError("handoff_base_mismatch");
  const files = [],
    changes = new Map(diff.files.map((f) => [f.path, f]));
  for (const item of project.manifest) {
    const before = await textAt(sourceRoot, item.path),
      after = await textAt(exportDirectory, item.path),
      change = changes.get(item.path);
    if (hash(before) !== item.contentHash) throw wireError("handoff_source_changed");
    if (change ? hash(before) !== change.beforeHash || hash(after) !== change.afterHash : hash(before) !== hash(after))
      throw wireError("handoff_export_mismatch");
    files.push({ path: item.path, before, after, changed: !!change });
  }
  if (files.filter((f) => f.changed).length !== changes.size) throw wireError("handoff_export_mismatch");
  const guard = repository ? await repositoryGuard(repository) : { directOverwrite: false, code: "unbound_repository" };
  await mkdir(target, { mode: 0o700 });
  const baselineDirectory = join(target, "baseline");
  await mkdir(baselineDirectory);
  for (const file of files)
    if (file.before !== null) {
      const path = join(baselineDirectory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.before, { flag: "wx", mode: 0o600 });
    }
  const patchFile = join(target, "changes.patch"),
    validationFile = join(target, "validation.json");
  await writeFile(
    patchFile,
    files
      .filter((f) => f.changed)
      .map((f) => hunk(f.path, f.before, f.after))
      .join("\n"),
    { flag: "wx", mode: 0o600 }
  );
  await writeFile(validationFile, JSON.stringify(validation, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const report = {
    handoffVersion: "agent-sync-handoff-v1",
    projectKey: project.projectKey,
    baselineVersion,
    acceptedVersion: diff.toVersion,
    baselineDirectory,
    exportDirectory,
    patchFile,
    validationFile,
    files: diff.files,
    guard,
    recheckPath:
      "Review latest source HEAD/local changes; explicitly prepare a new managed baseline, validate and accept again. Existing receipts do not authorize a changed baseline."
  };
  await writeFile(join(target, "handoff.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return report;
}
