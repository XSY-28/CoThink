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
  const sentinel = "INTERNAL_DISCUSSION_SENTINEL";
  const run = async (args) => {
    const result =
      process.platform === "win32"
        ? await exec(process.execPath, ["--", executable, ...args], { cwd: sandbox, maxBuffer: 16 * 1024 * 1024 })
        : await exec(join(sandbox, "node_modules/.bin/cothink"), args, { cwd: sandbox, maxBuffer: 16 * 1024 * 1024 });
    if ([result.stdout, result.stderr].some((text) => text.includes(sentinel) || text.includes("pack-fake-")))
      throw Error("Installed command leaked private content");
    return result.stdout;
  };
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
    const context = JSON.parse(body.messages.at(-1).content);
    calls++;
    if (req.headers.authorization !== `Bearer pack-fake-${body.model}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    let payload;
    if (context.responseContract.byMember) {
      const member = body.model === "a" ? "member-a" : "member-b",
        contract = context.responseContract.byMember[member];
      payload = JSON.parse(JSON.stringify(contract.template));
      if (payload.phase === "opening") {
        payload.claims = [{ statement: sentinel, rationale: sentinel, assumptions: [], sourceRefs: [] }];
        payload.answer.body = "Independent initial position";
        payload.complexity = "simple";
        payload.complexityRationale = sentinel;
      } else if (payload.phase === "discussion") {
        payload.answer.body = "FINAL_PUBLIC_RESULT";
        payload.answer.basisVersionIds = contract.referenceSlots.activeBasisVersionIds;
        payload.readyToReview = true;
      } else
        for (const position of payload.positions) {
          position.stance = "accept";
          position.rationale = sentinel;
        }
      payload.evidenceRequests = [sentinel];
    } else {
      // Keep the explicitly invoked legacy connection diagnostic bounded to four requests.
      const template = context.responseContract.template;
      payload = {
        ...template,
        conclusion: "Synthetic connection check",
        ...(context.phase === "opening"
          ? { claims: [{ statement: sentinel, rationale: sentinel, assumptions: [], sourceRefs: [] }] }
          : {
              positions: template.positions.map((position) => ({
                ...position,
                stance: "uncertain",
                rationale: sentinel
              }))
            })
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "pack-test",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(payload), reasoning_content: sentinel },
            finish_reason: "stop"
          }
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
      configVersion: 2,
      discussion: { effort: "standard" },
      members: {
        "member-a": { protocol: "openai-compatible", baseUrl, modelId: "a", apiKeyEnv: "PACK_A" },
        "member-b": { protocol: "openai-compatible", baseUrl, modelId: "b", apiKeyEnv: "PACK_B" }
      }
    })
  );
  await writeFile(join(sandbox, "keys.env"), "PACK_A=pack-fake-a\nPACK_B=pack-fake-b\n", { mode: 0o600 });
  const diagnostics = JSON.parse(await run(["test", "--config", "config.json", "--env-file", "keys.env", "--json"]));
  if (!diagnostics.ok || diagnostics.calls !== 4 || calls !== 4) throw Error("Installed diagnostic flow failed");
  await writeFile(join(sandbox, "question.txt"), "Synthetic install test");
  const result = JSON.parse(
    await run([
      "start",
      "--question-file",
      "question.txt",
      "--config",
      "config.json",
      "--env-file",
      "keys.env",
      "--session-id",
      "pack-smoke",
      "--effort",
      "low",
      "--max-rounds",
      "1",
      "--participation-weight",
      "member-a=2",
      "--decision-weight",
      "member-b=3",
      "--json"
    ])
  );
  if (calls !== 10 || result.outcome !== "consensus" || result.answer !== "FINAL_PUBLIC_RESULT")
    throw Error("Installed discussion final flow failed");
  const snapshot = JSON.parse(await readFile(join(sandbox, ".cothink/sessions/pack-smoke/session.json"), "utf8"));
  if (
    snapshot.schemaVersion !== 2 ||
    snapshot.segments[0].protocol.policy.effort !== "low" ||
    snapshot.segments[0].protocol.policy.weights["member-a"].participationWeight !== 2
  )
    throw Error("Installed policy freezing failed");
  if (!JSON.stringify(snapshot).includes(sentinel)) throw Error("Internal sentinel fixture was not exercised");
  if (JSON.stringify(snapshot).includes("pack-fake-")) throw Error("Installed snapshot leaked credentials");
  const show = JSON.parse(await run(["show", "pack-smoke", "--json", "--env-file", "missing-keys.env"]));
  if (JSON.stringify(show) !== JSON.stringify(result)) throw Error("Installed read did not return saved final result");
  for (const format of ["txt", "md", "json", "html"]) {
    const exported = JSON.parse(
      await run([
        "export",
        "pack-smoke",
        "--format",
        format,
        "--output",
        `result.${format}`,
        "--json",
        "--env-file",
        "missing-keys.env"
      ])
    );
    if (JSON.stringify(exported) !== JSON.stringify(result)) throw Error("Installed export stdout was not FinalResult");
    const content = await readFile(join(sandbox, `result.${format}`), "utf8");
    if (content.includes(sentinel) || content.includes("pack-fake-") || !content.includes(result.answer))
      throw Error("Installed export leaked discussion or lost answer");
  }
  await run(["view", "pack-smoke", "--no-open", "--env-file", "missing-keys.env"]);
  const html = await readFile(join(sandbox, ".cothink/sessions/pack-smoke/final.html"), "utf8");
  if (html.includes(sentinel) || html.includes("pack-fake-") || /<script\b/i.test(html))
    throw Error("Installed HTML carried private discussion");
  if (calls !== 10) throw Error("Read-only commands made model calls");
  const next = JSON.parse(
    await run([
      "continue",
      "pack-smoke",
      "--note",
      "New installed material",
      "--effort",
      "high",
      "--max-rounds",
      "1",
      "--decision-weight",
      "member-a=4",
      "--env-file",
      "keys.env",
      "--json"
    ])
  );
  if (calls !== 16 || next.segmentId !== 2 || next.outcome !== "consensus")
    throw Error("Installed continuation failed");
  const continued = JSON.parse(await readFile(join(sandbox, ".cothink/sessions/pack-smoke/session.json"), "utf8"));
  if (
    JSON.stringify(continued.segments[0]) !== JSON.stringify(snapshot.segments[0]) ||
    continued.segments[1].protocol.policy.effort !== "high"
  )
    throw Error("Installed continuation rewrote old segment or policy");
  console.log(
    "CoThink fresh tarball install: config v2, legacy bounded diagnostics (4 calls), discussion consensus (6), new segment (6), FinalResult-only reads and all four exports; no upstream library, keys or internal sentinel leaked."
  );
} finally {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(sandbox, { recursive: true, force: true });
}
