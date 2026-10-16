import { stderr } from "node:process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = dirname(fileURLToPath(import.meta.url));
// Preserve dynamic bootstrap ordering. Bundling could hoist neutral imports ahead of env cleanup.
const result = await build({
  absWorkingDir: root,
  entryPoints: ["stdio.mjs", "server.mjs", "protocol.mjs", "diagnostics.mjs"],
  outdir: join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: false,
  platform: "node",
  target: "node22",
  format: "esm",
  metafile: true,
  logLevel: "silent"
});
const inputs = {};
for (const name of Object.keys(result.metafile.inputs))
  inputs[name] = createHash("sha256")
    .update(await readFile(join(root, name)))
    .digest("hex");
await writeFile(
  join(root, "dist/build-identity.json"),
  JSON.stringify({ inputs, metafile: result.metafile }, null, 2) + "\n"
);
stderr.write("AgentSync explicit stdio entry compiled\n");
