import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import process from "node:process";
import { Buffer } from "node:buffer";
const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "cothink-pack-"));
let server;
try {
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--workspace", "packages/cothink", "--pack-destination", sandbox],
    { cwd: repo }
  );
  const [packed] = JSON.parse(stdout);
  if (packed.files.some((f) => !/^(?:dist\/cli\.js|package\.json|README\.md|LICENSE)$/.test(f.path)))
    throw Error("Unexpected files in public package");
  await exec("npm", ["init", "-y"], { cwd: sandbox });
  await exec("npm", ["install", "--ignore-scripts", join(sandbox, packed.filename)], {
    cwd: sandbox,
    maxBuffer: 16 * 1024 * 1024
  });
  const executable = join(sandbox, "node_modules/cothink/dist/cli.js");
  const run = async (args) =>
    (await exec(process.execPath, [executable, ...args], { cwd: sandbox, maxBuffer: 16 * 1024 * 1024 })).stdout;
  if (!(await run(["--version"])).includes("CoThink v")) throw Error("Version entry failed");
  if (!(await run(["--help"])).includes("cothink setup")) throw Error("Help entry failed");
  const pkg = JSON.parse(await readFile(join(sandbox, "node_modules/cothink/package.json"), "utf8"));
  if (pkg.dependencies?.["@onevcat/argue"]) throw Error("Standalone package depends on unpublished peer exports");
  try {
    await access(join(sandbox, "node_modules/@onevcat/argue"));
    throw Error("Unexpected upstream library dependency");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await run(["init", "--config", "editable.json"]);
  let calls = 0;
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const context = JSON.parse(body.messages.at(-1).content),
      template = context.responseContract.template;
    calls++;
    if (req.headers.authorization !== `Bearer pack-fake-${body.model}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const payload = {
      ...template,
      conclusion: "Synthetic connection/discussion result",
      ...(context.phase === "opening"
        ? { claims: [{ statement: "Synthetic claim", rationale: "Synthetic reason", assumptions: [], sourceRefs: [] }] }
        : context.phase === "discussion"
          ? { actions: [], readyToReview: true }
          : {
              positions: template.positions.map((p) => ({
                ...p,
                stance: "uncertain",
                rationale: "Synthetic assessment"
              }))
            })
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "pack-test",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 }
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No server address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await writeFile(
    join(sandbox, "config.json"),
    JSON.stringify({
      members: {
        "member-a": { protocol: "openai-compatible", baseUrl, modelId: "a", apiKeyEnv: "PACK_A" },
        "member-b": { protocol: "openai-compatible", baseUrl, modelId: "b", apiKeyEnv: "PACK_B" }
      }
    })
  );
  await writeFile(join(sandbox, "keys.env"), "PACK_A=pack-fake-a\nPACK_B=pack-fake-b\n", { mode: 0o600 });
  const diagnostics = JSON.parse(await run(["test", "--config", "config.json", "--env-file", "keys.env", "--json"]));
  if (!diagnostics.ok || diagnostics.calls !== 4 || calls !== 4) throw Error("Installed diagnostic flow failed");
  await run([
    "start",
    "--question",
    "Synthetic install test",
    "--config",
    "config.json",
    "--env-file",
    "keys.env",
    "--session-id",
    "pack-smoke",
    "--rounds",
    "2",
    "--max-calls",
    "8"
  ]);
  if (calls !== 12) throw Error("Installed paired flow made unexpected calls");
  await run(["show", "pack-smoke"]);
  await run(["export", "pack-smoke", "--format", "json", "--output", "report.json"]);
  await run(["view", "pack-smoke", "--no-open"]);
  const text = await readFile(join(sandbox, "report.json"), "utf8"),
    report = JSON.parse(text);
  if (
    report.status !== "completed" ||
    report.reviewStatus !== "complete" ||
    report.reviews.length !== 2 ||
    text.includes("pack-fake-")
  )
    throw Error("Installed export verification failed");
  if (calls !== 12) throw Error("Read-only commands made model calls");
  console.log(
    "CoThink fresh tarball install: help/version/init, 4-call diagnostics, 8-call paired discussion, show/export/offline view passed; no upstream library dependency or exported keys."
  );
} finally {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(sandbox, { recursive: true, force: true });
}
