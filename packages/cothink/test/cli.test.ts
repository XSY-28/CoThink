import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { runCoThink } from "../src/index.js";
import type { MemberRuntime } from "@onevcat/argue";
import { createServer, type Server } from "node:http";
let root: string;
let server: Server | undefined;
let logs: string[], errors: string[];
const io = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-cli-"));
  logs = [];
  errors = [];
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

it("runs peer-only start, show and export with key-file credentials over real loopback HTTP", async () => {
  const calls: Array<{ model: string; auth: string | undefined }> = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ model: body.model, auth: req.headers.authorization });
    const context = JSON.parse(body.messages[1].content),
      template = context.responseContract.template;
    const payload = {
      ...template,
      conclusion: "Synthetic independent position",
      ...(context.phase === "opening"
        ? {
            claims: [
              { statement: "Synthetic hypothesis", rationale: "Synthetic reason", assumptions: [], sourceRefs: [] }
            ]
          }
        : context.phase === "discussion"
          ? { actions: [], readyToReview: true }
          : {
              positions: template.positions.map((p: { versionId: string }) => ({
                ...p,
                stance: "uncertain",
                rationale: "Synthetic review"
              }))
            })
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "local",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 }
      })
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`,
    config = join(root, "config.json"),
    envFile = join(root, "keys.env"),
    sessions = join(root, "sessions");
  await writeFile(
    config,
    JSON.stringify({
      members: {
        "member-a": { protocol: "openai-compatible", baseUrl, modelId: "a", apiKeyEnv: "A" },
        "member-b": { protocol: "openai-compatible", baseUrl, modelId: "b", apiKeyEnv: "B" }
      }
    })
  );
  await writeFile(envFile, "A=fake-a\nB=fake-b\n");
  expect(
    (
      await runCoThink(
        [
          "start",
          "--question",
          "Synthetic test?",
          "--config",
          config,
          "--env-file",
          envFile,
          "--root",
          sessions,
          "--session-id",
          "installed-flow",
          "--rounds",
          "2",
          "--max-calls",
          "8"
        ],
        io,
        { env: {} }
      )
    ).ok
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(calls).toHaveLength(8);
  expect(calls.every((c) => c.auth === `Bearer fake-${c.model}`)).toBe(true);
  expect((await runCoThink(["show", "installed-flow", "--root", sessions], io)).ok).toBe(true);
  const output = join(root, "report.json");
  expect(
    (await runCoThink(["export", "installed-flow", "--root", sessions, "--format", "json", "--output", output], io)).ok
  ).toBe(true);
  const report = JSON.parse(await readFile(output, "utf8"));
  expect(report).toMatchObject({ status: "completed", reviewStatus: "complete" });
  expect(report.reviews).toHaveLength(2);
  expect(await readFile(output, "utf8")).not.toContain("fake-a");
  expect(calls).toHaveLength(8);
});

it("exposes CoThink peer-only help/version without old representative execution", async () => {
  expect((await runCoThink(["--help"], io)).ok).toBe(true);
  expect(logs.join("\n")).toContain("CoThink");
  expect(logs.join("\n")).toContain("setup");
  expect(logs.join("\n")).not.toContain("representative");
  logs = [];
  expect((await runCoThink(["--version"], io)).ok).toBe(true);
  expect(logs.join("\n")).toMatch(/CoThink v0\.6\.1/);
  expect((await runCoThink(["run", "--action", "anything"], io)).ok).toBe(false);
});

it("initializes a generic editable configuration without prompts, keys or network requests", async () => {
  const config = join(root, "config.json"),
    envFile = join(root, "keys.env");
  expect((await runCoThink(["init", "--config", config, "--env-file", envFile], io, { env: {} })).ok).toBe(true);
  const parsed = JSON.parse(await readFile(config, "utf8"));
  expect(parsed.members["member-a"].profile).toBe("openai-compatible");
  expect(parsed.members["member-b"].profile).toBe("openai-compatible");
  expect((await runCoThink(["init", "--config", config, "--env-file", envFile], io)).ok).toBe(false);
  expect(errors.join("\n")).toMatch(/exist/i);
});

it("loads external key files for bounded diagnostics and returns machine-readable results", async () => {
  const config = join(root, "config.json"),
    envFile = join(root, "keys.env");
  await writeFile(
    config,
    JSON.stringify({
      members: {
        "member-a": {
          protocol: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          modelId: "a",
          apiKeyEnv: "A"
        },
        "member-b": {
          protocol: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          modelId: "b",
          apiKeyEnv: "B"
        }
      }
    })
  );
  await writeFile(envFile, "A=fake-a\nB=fake-b\n");
  let calls = 0;
  const runtime: MemberRuntime = {
    respond: async (request) => {
      calls++;
      const template = JSON.parse(request.messages[1]!.content).responseContract.template;
      return {
        payload: {
          ...template,
          conclusion: "Synthetic assessment",
          ...(request.phase === "opening"
            ? { claims: [] }
            : {
                positions: template.positions.map((p: { versionId: string }) => ({
                  ...p,
                  stance: "uncertain",
                  rationale: "Synthetic reason"
                }))
              })
        },
        rawContent: "{}",
        protocol: request.protocol,
        modelId: request.modelId,
        generationOptions: request.generationOptions,
        usage: {},
        finishReason: "stop"
      };
    }
  };
  const result = await runCoThink(["test", "--config", config, "--env-file", envFile, "--json"], io, {
    env: {},
    runtime
  });
  expect(result.ok).toBe(true);
  expect(calls).toBe(4);
  expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: true, calls: 4 });
  expect(logs.join("\n")).not.toContain("fake-a");
  expect(logs.join("\n")).not.toContain("fake-b");
});

it("refuses invalid doctor flags before any request", async () => {
  let calls = 0;
  const runtime: MemberRuntime = {
    respond: async () => {
      calls++;
      throw Error("unexpected");
    }
  };
  for (const args of [
    ["test", "--timeout-ms", "0"],
    ["test", "--member", "other"],
    ["test", "--unexpected"]
  ])
    expect((await runCoThink(args, io, { runtime })).ok).toBe(false);
  expect(calls).toBe(0);
});

it("rejects missing credentials and invalid native tuning before creating a paid-call session", async () => {
  const config = join(root, "config.json"),
    sessions = join(root, "sessions");
  const a = { protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", modelId: "a", apiKeyEnv: "A" };
  const variants = [
    { protocol: "openai-compatible", baseUrl: a.baseUrl, modelId: "b", apiKeyEnv: "MISSING" },
    {
      protocol: "anthropic-compatible",
      baseUrl: a.baseUrl,
      modelId: "b",
      apiKeyEnv: "B",
      generationOptions: { thinking: { type: "enabled", budget_tokens: 10 } }
    }
  ];
  for (const [index, b] of variants.entries()) {
    await writeFile(config, JSON.stringify({ members: { "member-a": a, "member-b": b } }));
    const result = await runCoThink(
      [
        "start",
        "--question",
        "Local validation?",
        "--config",
        config,
        "--root",
        sessions,
        "--session-id",
        `preflight-${index}`
      ],
      io,
      { env: { A: "fake-a", B: "fake-b" } }
    );
    expect(result.code).toBe(1);
    await expect(readFile(join(sessions, `preflight-${index}`, "session.json"), "utf8")).rejects.toThrow();
  }
});
