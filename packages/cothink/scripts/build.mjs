import { build } from "esbuild";
import { copyFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
await build({
  entryPoints: [resolve(packageDir, "src/cli.ts")],
  outfile: resolve(packageDir, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  alias: {
    "@onevcat/argue/agent-sync/project": resolve(repoDir, "packages/argue/src/agent-sync/project/index.ts"),
    "@onevcat/argue/agent-sync/legacy-v1": resolve(repoDir, "packages/argue/src/agent-sync/legacy-v1/index.ts"),
    "@onevcat/argue/agent-sync": resolve(repoDir, "packages/argue/src/agent-sync/index.ts"),
    "@onevcat/argue": resolve(repoDir, "packages/argue/src/index.ts")
  },
  sourcemap: false
});
await chmod(resolve(packageDir, "dist/cli.js"), 0o755);
await copyFile(resolve(repoDir, "LICENSE"), resolve(packageDir, "LICENSE"));
