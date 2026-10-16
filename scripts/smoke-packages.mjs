import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const libraryDir = join(repoRoot, "packages", "argue");
const cliDir = join(repoRoot, "packages", "argue-cli");
const neutralCoreAssertions = [
  "const core = await import('@onevcat/argue/agent-sync');",
  "if (core.BuildPathSchema.parse('src/value.ts') !== 'src/value.ts') throw new Error('neutral schema unusable');",
  "if (typeof core.createBuildState !== 'function' || typeof core.parseBuildState !== 'function' || typeof core.reserveBuildScope !== 'function') throw new Error('neutral state primitives missing');",
  "if (typeof core.AgentSyncService !== 'function') throw new Error('AgentSyncService export missing');",
  "if (core.BuildDriver !== undefined) throw new Error('neutral entry exposes model driver');"
];

await smokeLibrary();
await smokeCli();

async function smokeLibrary() {
  const tarball = await packPackage(libraryDir);
  const sandbox = await mkdtemp(join(tmpdir(), "argue-pack-lib-"));

  try {
    await run("npm", ["init", "-y"], sandbox);
    await run("npm", ["install", tarball], sandbox);
    await run(
      "node",
      [
        "--input-type=module",
        "-e",
        [
          "const mod = await import('@onevcat/argue');",
          "if (typeof mod.ArgueEngine !== 'function') throw new Error('ArgueEngine export missing');",
          "if (typeof mod.MemorySessionStore !== 'function') throw new Error('MemorySessionStore export missing');",
          ...neutralCoreAssertions
        ].join(" ")
      ],
      sandbox
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(tarball, { force: true });
  }
}

async function smokeCli() {
  const libraryTarball = await packPackage(libraryDir);
  const cliTarball = await packPackage(cliDir);
  const sandbox = await mkdtemp(join(tmpdir(), "argue-pack-cli-"));

  try {
    await run("npm", ["init", "-y"], sandbox);
    await run("npm", ["install", libraryTarball, cliTarball], sandbox);
    await run(
      "node",
      [
        "--input-type=module",
        "-e",
        [
          ...neutralCoreAssertions,
          "const host = await import('@onevcat/argue-cli/agent-sync');",
          "if (typeof host.LocalAgentSync !== 'function' || typeof host.initializeAgentSyncProject !== 'function') throw new Error('neutral local host missing');",
          "for (const name of ['FileBuildStore', 'Workspace', 'DockerVerifier', 'Publisher', 'recoverBuild', 'exportAcceptedVersion']) if (typeof host[name] !== 'function') throw new Error('neutral backend missing: ' + name);"
        ].join(" ")
      ],
      sandbox
    );
    const binPath = join(sandbox, "node_modules", ".bin", "argue");
    const { stdout } = await execFileAsync(binPath, ["--version"], { cwd: sandbox });
    if (!stdout.includes("@onevcat/argue-cli v")) {
      throw new Error(`Unexpected CLI version output: ${stdout.trim()}`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(libraryTarball, { force: true });
    await rm(cliTarball, { force: true });
  }
}

async function packPackage(cwd) {
  const { stdout } = await execFileAsync("npm", ["pack", "--json"], { cwd });
  const parsed = JSON.parse(stdout);
  return join(cwd, parsed[0].filename);
}

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
}
