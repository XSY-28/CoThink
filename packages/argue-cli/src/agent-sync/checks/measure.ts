import { createHash } from "node:crypto";
import { readFile, lstat, readdir, realpath, mkdir, writeFile, cp } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hashJson } from "@onevcat/argue/agent-sync/project";
import { freezeTrustedCheckConfig, type TrustedCheckConfig } from "./config.js";
export const byteHash = (bytes: string | Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export function checkTime(deadline?: number): void {
  if (deadline !== undefined && performance.now() >= deadline) throw new Error("AGENT_SYNC_CHECK_TIMEOUT");
}
export function remaining(deadline: number): number {
  checkTime(deadline);
  return Math.max(1, Math.floor(deadline - performance.now()));
}
export async function regularBytes(root: string, path: string): Promise<Buffer> {
  const base = await realpath(root),
    target = resolve(base, path);
  if (target === base || !target.startsWith(base + sep) || (await realpath(target)) !== target)
    throw new Error("AGENT_SYNC_TRUSTED_PATH");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("AGENT_SYNC_TRUSTED_PATH");
  return readFile(target);
}
/** Resolve package links into the complete regular-file closure; do not trust lockfiles or mtimes. */
export async function treeManifest(root: string, deadline?: number): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, ancestors: readonly string[]) {
    checkTime(deadline);
    const physical = await realpath(path);
    if (ancestors.includes(physical)) throw new Error("AGENT_SYNC_DEPENDENCY_CYCLE");
    const stat = await lstat(physical);
    if (stat.isDirectory()) {
      for (const name of (await readdir(physical)).sort()) {
        // Vitest/Vite's generated cache is not imported by fixed --configLoader-independent jobs.
        if (name === ".cache" || name === ".vite" || name === ".vite-temp") continue;
        await visit(join(path, name), [...ancestors, physical]);
      }
    } else if (stat.isFile()) result[relative(root, path).split(sep).join("/")] = byteHash(await readFile(physical));
    else throw new Error("AGENT_SYNC_DEPENDENCY_FILE");
  }
  await visit(root, []);
  checkTime(deadline);
  return result;
}
export async function treeHash(root: string, deadline?: number): Promise<string> {
  return hashJson(await treeManifest(root, deadline));
}
export async function measureTrustedConfiguration(input: unknown, trustedRoot: string): Promise<TrustedCheckConfig> {
  const config = freezeTrustedCheckConfig(input);
  const artifacts = await Promise.all(
    config.artifacts.map(async (a) => ({
      ...a,
      expectedHash: byteHash(await regularBytes(trustedRoot, a.relativePath))
    }))
  );
  const dependencies = await Promise.all(
    config.dependencies.map(async (d) => ({ ...d, expectedHash: await treeHash(join(trustedRoot, d.relativePath)) }))
  );
  return freezeTrustedCheckConfig({ ...config, artifacts, dependencies });
}
export async function measureArtifacts(config: TrustedCheckConfig, root: string, deadline?: number) {
  const files: Record<string, string> = {};
  for (const a of config.artifacts) {
    checkTime(deadline);
    const actual = byteHash(await regularBytes(root, a.relativePath));
    if (actual !== a.expectedHash) throw new Error("AGENT_SYNC_TRUSTED_ARTIFACT_CHANGED");
    files[a.id] = actual;
  }
  const dependencies: Record<string, string> = {};
  for (const d of config.dependencies) {
    const actual = await treeHash(join(root, d.relativePath), deadline);
    if (actual !== d.expectedHash) throw new Error("AGENT_SYNC_TRUSTED_DEPENDENCY_CHANGED");
    dependencies[d.id] = actual;
  }
  return { files, dependencies };
}
export async function copyTrusted(
  config: TrustedCheckConfig,
  root: string,
  target: string,
  deadline: number
): Promise<void> {
  for (const a of config.artifacts) {
    checkTime(deadline);
    const bytes = await regularBytes(root, a.relativePath);
    if (byteHash(bytes) !== a.expectedHash) throw new Error("AGENT_SYNC_TRUSTED_ARTIFACT_CHANGED");
    const out = join(target, a.relativePath);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes, { mode: 0o444 });
  }
  for (const d of config.dependencies) {
    checkTime(deadline);
    const source = join(root, d.relativePath),
      out = join(target, d.relativePath);
    await mkdir(dirname(out), { recursive: true });
    await cp(source, out, {
      recursive: true,
      dereference: true,
      filter: (path) => !path.split(sep).some((p) => [".cache", ".vite", ".vite-temp"].includes(p))
    });
  }
  await measureArtifacts(config, target, deadline);
}
