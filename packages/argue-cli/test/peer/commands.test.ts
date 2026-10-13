import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemberRequest, buildPeerReport, createPeerSession, type MemberRequest } from "@onevcat/argue";
import prettier from "prettier";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "../../src/index.js";
import { FilePeerStore } from "../../src/peer/file-store.js";
import { renderPeerMarkdown } from "../../src/peer/render.js";

let root: string;
let server: Server | undefined;
const logs: string[] = [];
const errors: string[] = [];
const io = { log: (value: string) => logs.push(value), error: (value: string) => errors.push(value) };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "argue-peer-commands-"));
  logs.length = 0;
  errors.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  delete process.env.FAKE_PEER_A;
  delete process.env.FAKE_PEER_B;
});

const defaultSource = "[link](https://example.test/path)\n[ref]: https://example.test/ref\n~~~\n&lt;script&gt;";

async function savePartial(sourceContent = defaultSource) {
  const state = createPeerSession(
    {
      sessionId: "partial-1",
      schemaVersion: 1,
      question: "<script>alert('x')</script>\n# Injected heading\n![](https://example.test/pixel.png)",
      sourceCommit: "local-test",
      createdAt: new Date().toISOString(),
      members: [
        {
          id: "member-a",
          protocol: "openai-compatible",
          baseUrl: "https://example.test",
          modelId: "a",
          apiKeyEnv: "KEY_A",
          outputMode: "json_object",
          generationOptions: {}
        },
        {
          id: "member-b",
          protocol: "openai-compatible",
          baseUrl: "https://example.test",
          modelId: "b",
          apiKeyEnv: "KEY_B",
          outputMode: "json_object",
          generationOptions: {}
        }
      ]
    },
    [
      {
        sourceId: "source-1",
        segmentId: 1,
        content: sourceContent,
        name: "source.md"
      }
    ]
  );
  state.status = "paused";
  state.pauseReason = { code: "runtime_error", message: "check provider", retryable: true };
  await new FilePeerStore(root).withWriter(state.config.sessionId, (writer) => writer.commit(-1, state));
}

it("exports a paused report as deterministic JSON, Markdown and escaped offline HTML without runtime calls", async () => {
  await savePartial();
  for (const format of ["json", "md", "html"]) {
    const output = join(root, `report.${format}`);
    expect(
      (await runCli(["peer", "export", "partial-1", "--root", root, "--format", format, "--output", output], io)).ok
    ).toBe(true);
    const first = await readFile(output, "utf8");
    expect(
      (await runCli(["peer", "export", "partial-1", "--root", root, "--format", format, "--output", output], io)).ok
    ).toBe(true);
    expect(await readFile(output, "utf8")).toBe(first);
    if (format === "json")
      expect(JSON.parse(first)).toMatchObject({
        resultVersion: "peer.v1",
        status: "paused",
        reviewStatus: "incomplete_review"
      });
    if (format === "md") {
      expect(first).toContain("Incomplete review");
      expect(first).toContain("&#60;script&#62;alert");
      expect(first).not.toContain("<script>");
    }
    if (format === "html") {
      expect(first).toContain("&lt;script&gt;alert");
      expect(first).not.toContain("<script>");
      expect(first).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=/i);
      expect(first).not.toMatch(/url\(\s*["']?https?:/i);
      expect(first.match(/class="member-card"/g)).toHaveLength(2);
      expect(first).toContain('<section class="members"');
      expect(first).toContain("<details><summary>Full committed rounds");
      expect(first).not.toContain("## Member conclusions");
    }
  }
});

it("renders supplied Markdown syntax as text without creating active image, link, HTML or injected headings", async () => {
  await savePartial();
  const output = join(root, "literal.md");
  expect(
    (await runCli(["peer", "export", "partial-1", "--root", root, "--format", "md", "--output", output], io)).ok
  ).toBe(true);
  const parsed = await prettier.__debug.parse(await readFile(output, "utf8"), { parser: "markdown" });
  const nodes: Array<{ type?: string; children?: unknown[]; value?: string }> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const current = node as { type?: string; children?: unknown[]; value?: string };
    nodes.push(current);
    for (const child of current.children ?? []) visit(child);
  };
  visit(parsed.ast);
  expect(nodes.filter((node) => ["image", "link", "definition", "html"].includes(node.type ?? ""))).toEqual([]);
  expect(nodes.filter((node) => node.type === "code").map((node) => node.value)).toEqual([defaultSource]);
  const literalText = nodes
    .filter((node) => node.type === "text")
    .map((node) => node.value ?? "")
    .join("");
  expect(literalText).toContain("![](https://example.test/pixel.png)");
  expect(literalText).toContain("<script>alert('x')</script>");
  expect(nodes.filter((node) => node.type === "heading").some((node) => JSON.stringify(node).includes("Sources"))).toBe(
    true
  );
  expect(
    nodes.filter((node) => node.type === "heading").some((node) => JSON.stringify(node).includes("Injected heading"))
  ).toBe(false);
});

it("keeps indented source text and longer fence runs literal in a bounded code block", async () => {
  const source =
    "    indented ![](https://example.test/pixel.png)\n\t<script>alert('x')</script>\n`````\n[ref]: https://example.test/ref\n";
  await savePartial(source);
  const output = join(root, "fenced.md");
  expect(
    (await runCli(["peer", "export", "partial-1", "--root", root, "--format", "md", "--output", output], io)).ok
  ).toBe(true);
  const parsed = await prettier.__debug.parse(await readFile(output, "utf8"), { parser: "markdown" });
  const sourceCode = (parsed.ast as { children: Array<{ type: string; value?: string }> }).children.filter(
    (node) => node.type === "code"
  );
  expect(sourceCode.map((node) => node.value)).toEqual([source]);
  expect(JSON.stringify(parsed.ast)).not.toMatch(/"type":"(?:image|link|html|definition)"/);
});

it("literalizes identifiers, reasons, committed payload JSON and raw diagnostic content", async () => {
  await savePartial();
  const report = buildPeerReport(await new FilePeerStore(root).load("partial-1"));
  const unsafe = "![](https://example.test/second.png)";
  report.claims.push({
    version: {
      claimId: unsafe,
      versionId: unsafe,
      authorId: "member-a",
      segmentId: 1,
      roundIndex: 0,
      version: 1,
      statement: unsafe,
      rationale: "[reason](https://example.test/reason)",
      assumptions: [],
      sourceRefs: [],
      withdrawn: false
    },
    label: "incomplete_review",
    positions: []
  });
  report.rounds.push({
    segmentId: 1,
    roundIndex: 0,
    phase: "opening",
    snapshotId: "snapshot",
    replies: [
      {
        memberId: "member-a",
        jobId: "job-a",
        snapshotId: "snapshot",
        inputHash: "hash-a",
        payload: { phase: "opening", conclusion: unsafe, evidenceRequests: [], claims: [] }
      },
      {
        memberId: "member-b",
        jobId: "job-b",
        snapshotId: "snapshot",
        inputHash: "hash-b",
        payload: { phase: "opening", conclusion: "Other", evidenceRequests: [], claims: [] }
      }
    ]
  });
  report.attempts.push({
    jobId: "job-c",
    attemptId: unsafe,
    inputHash: "hash-c",
    memberId: "member-a",
    status: "invalid",
    startedAt: "2026-10-13T00:00:00.000Z",
    deadline: "2026-10-13T00:10:00.000Z",
    acceptance: "invalidated",
    cancellation: "none",
    rawContent: "[raw](https://example.test/raw)"
  });
  const parsed = await prettier.__debug.parse(renderPeerMarkdown(report), { parser: "markdown" });
  const types: string[] = [];
  const values: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const current = node as { type?: string; value?: string; children?: unknown[] };
    if (current.type) types.push(current.type);
    if (current.type === "text" && current.value) values.push(current.value);
    for (const child of current.children ?? []) visit(child);
  };
  visit(parsed.ast);
  expect(types.filter((type) => ["image", "link", "definition", "html"].includes(type))).toEqual([]);
  expect(types.filter((type) => type === "code")).toHaveLength(1);
  expect(values.join("")).toContain(unsafe);
  expect(values.join("")).toContain("[raw](https://example.test/raw)");
});

it("show is read-only and retry and continue enforce different saved states", async () => {
  await savePartial();
  expect((await runCli(["peer", "show", "partial-1", "--root", root], io)).ok).toBe(true);
  expect(logs.join("\n")).toContain("paused");
  expect((await runCli(["peer", "continue", "partial-1", "--root", root], io)).ok).toBe(false);
  expect(errors.join("\n")).toContain("Only a completed peer segment can continue");
  expect((await runCli(["peer", "retry", "missing", "--root", root], io)).ok).toBe(false);
});

it("rejects missing start input before a network request", async () => {
  const config = join(root, "peer.json");
  await writeFile(config, "{}", "utf8");
  expect((await runCli(["peer", "start", "--config", config, "--root", root], io)).ok).toBe(false);
  expect(errors.join("\n")).toContain("--question");
});

function activeSession(sessionId: string, baseUrl: string) {
  return createPeerSession({
    sessionId,
    schemaVersion: 1,
    question: "Crash recovery?",
    sourceCommit: "local-test",
    createdAt: new Date().toISOString(),
    members: [
      {
        id: "member-a",
        protocol: "openai-compatible",
        baseUrl,
        modelId: "a",
        apiKeyEnv: "FAKE_PEER_A",
        outputMode: "json_object",
        generationOptions: {}
      },
      {
        id: "member-b",
        protocol: "openai-compatible",
        baseUrl,
        modelId: "b",
        apiKeyEnv: "FAKE_PEER_B",
        outputMode: "json_object",
        generationOptions: {}
      }
    ]
  });
}
function frozen(request: MemberRequest) {
  const {
    messages,
    outputSchema,
    outputMode,
    maxOutputTokens,
    modelId,
    protocol,
    baseUrl,
    apiKeyEnv,
    generationOptions
  } = request;
  return {
    messages,
    outputSchema,
    outputMode,
    maxOutputTokens,
    modelId,
    protocol,
    baseUrl,
    apiKeyEnv,
    generationOptions
  };
}

it("first CLI retry recovers active sealed/running snapshot with zero calls; second explicit retry reuses seal/hash", async () => {
  const requests: Array<{ model: string; phase: string }> = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    const phase = (JSON.parse(body.messages.at(-1)!.content) as { phase: string }).phase;
    requests.push({ model: body.model, phase });
    const payload =
      phase === "opening"
        ? { phase, conclusion: body.model, evidenceRequests: [], claims: [] }
        : { phase, conclusion: body.model, evidenceRequests: [], actions: [], readyToReview: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "local",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }]
      })
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  const sessionId = "crashed-sealed";
  const state = activeSession(sessionId, `http://127.0.0.1:${address.port}/v1`);
  const a = buildMemberRequest(state, "member-a");
  const b = buildMemberRequest(state, "member-b");
  const now = new Date().toISOString();
  state.jobs.push(
    {
      jobId: a.jobId,
      memberId: "member-a",
      segmentId: 1,
      roundIndex: 0,
      phase: "opening",
      snapshotId: a.snapshotId,
      inputHash: a.inputHash,
      status: "sealed",
      frozenInput: frozen(a),
      sealedReply: {
        memberId: "member-a",
        jobId: a.jobId,
        snapshotId: a.snapshotId,
        inputHash: a.inputHash,
        payload: { phase: "opening", conclusion: "a", evidenceRequests: [], claims: [] }
      }
    },
    {
      jobId: b.jobId,
      memberId: "member-b",
      segmentId: 1,
      roundIndex: 0,
      phase: "opening",
      snapshotId: b.snapshotId,
      inputHash: b.inputHash,
      status: "running",
      activeAttemptId: "attempt-before-crash",
      frozenInput: frozen(b)
    }
  );
  state.attempts.push(
    {
      jobId: a.jobId,
      attemptId: "sealed-before-crash",
      inputHash: a.inputHash,
      memberId: "member-a",
      status: "valid",
      startedAt: now,
      deadline: state.segments[0]!.deadline,
      acceptance: "accepted",
      cancellation: "none"
    },
    {
      jobId: b.jobId,
      attemptId: "attempt-before-crash",
      inputHash: b.inputHash,
      memberId: "member-b",
      status: "running",
      startedAt: now,
      deadline: state.segments[0]!.deadline,
      acceptance: "active",
      cancellation: "none"
    }
  );
  const store = new FilePeerStore(root);
  await store.withWriter(sessionId, (writer) => writer.commit(-1, state));
  process.env.FAKE_PEER_B = "fake-b";
  const first = await runCli(["peer", "retry", sessionId, "--root", root, "--extra-calls", "2"], io);
  expect(first.code).toBe(2);
  expect(requests).toHaveLength(0);
  const recovered = await store.load(sessionId);
  expect(recovered.status).toBe("paused");
  expect(recovered.pauseReason?.code).toBe("recovered_unknown");
  expect(recovered.jobs.find((job) => job.memberId === "member-a")?.status).toBe("sealed");
  expect(recovered.attempts.find((attempt) => attempt.memberId === "member-b")?.status).toBe("unknown");
  expect(recovered.segments[0]!.maxCalls).toBe(12);
  expect(logs.join("\n")).toContain("repeat --extra-calls/--extend-seconds");
  process.env.FAKE_PEER_A = "fake-a";
  const second = await runCli(["peer", "retry", sessionId, "--root", root, "--extra-calls", "2"], io);
  expect(errors).toEqual([]);
  expect(second.ok).toBe(true);
  expect(requests.filter((request) => request.phase === "opening")).toEqual([{ model: "b", phase: "opening" }]);
  const complete = await store.load(sessionId);
  expect(complete.status).toBe("completed");
  expect(complete.segments[0]!.maxCalls).toBe(14);
  expect(complete.attempts.find((attempt) => attempt.attemptId === "attempt-before-crash")?.inputHash).toBe(
    b.inputHash
  );
  expect(complete.attempts.filter((attempt) => attempt.jobId === b.jobId).at(-1)?.inputHash).toBe(b.inputHash);
  expect(complete.rounds[0]!.replies.find((reply) => reply.memberId === "member-a")?.payload.conclusion).toBe("a");
});

it("first CLI retry of active snapshot between commits pauses without dispatch", async () => {
  const sessionId = "crashed-between-rounds";
  const store = new FilePeerStore(root);
  await store.withWriter(sessionId, (writer) => writer.commit(-1, activeSession(sessionId, "https://example.test")));
  const first = await runCli(["peer", "retry", sessionId, "--root", root], io);
  expect(first.code).toBe(2);
  const recovered = await store.load(sessionId);
  expect(recovered.status).toBe("paused");
  expect(recovered.pauseReason?.code).toBe("recovered_interrupted");
  expect(recovered.attempts).toHaveLength(0);
  expect(recovered.events.at(-1)?.type).toBe("SessionPaused");
});

it("completes a paired review over HTTP with omitted metadata and commentary in exactly eight calls", async () => {
  const requests: Array<{ model: string; phase: string; context: string }> = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    const context = body.messages.at(-1)!.content;
    const frozen = JSON.parse(context) as { phase: string; reviewSetHash?: string; reviewVersions: string[] };
    requests.push({ model: body.model, phase: frozen.phase, context });
    const payload = {
      phase: frozen.phase,
      conclusion: "Independent position",
      evidenceRequestsNote: "No sources supplied",
      ...(frozen.phase === "opening"
        ? { claims: [{ statement: `${body.model} hypothesis`, rationale: "A reason", note: "Unverified" }] }
        : frozen.phase === "discussion"
          ? { actions: [], readyToReview: true }
          : {
              reviewSetHash: frozen.reviewSetHash,
              positions: frozen.reviewVersions.map((versionId) => ({
                versionId,
                stance: "uncertain",
                rationale: "No evidence",
                note: "Unverified"
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
  if (!address || typeof address === "string") throw new Error("No local port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      members: {
        "member-a": { profile: "deepseek", baseUrl, modelId: "a", apiKeyEnv: "FAKE_PEER_A" },
        "member-b": { profile: "glm", baseUrl, modelId: "b", apiKeyEnv: "FAKE_PEER_B" }
      }
    })
  );
  process.env.FAKE_PEER_A = "test-a";
  process.env.FAKE_PEER_B = "test-b";
  const sessionId = "normalized-http";
  const result = await runCli(
    [
      "peer",
      "start",
      "--question",
      "Which?",
      "--config",
      config,
      "--session-id",
      sessionId,
      "--root",
      root,
      "--rounds",
      "2",
      "--max-calls",
      "8"
    ],
    io
  );
  expect(errors).toEqual([]);
  expect(result.ok).toBe(true);
  expect(requests).toHaveLength(8);
  const state = await new FilePeerStore(root).load(sessionId);
  expect(state.status).toBe("completed");
  expect(state.rounds).toHaveLength(4);
  expect(state.attempts.every((attempt) => attempt.status === "valid")).toBe(true);
  for (const phase of ["opening", "discussion", "review"]) {
    const a = requests
      .filter((request) => request.model === "a" && request.phase === phase)
      .map((request) => request.context);
    const b = requests
      .filter((request) => request.model === "b" && request.phase === phase)
      .map((request) => request.context);
    expect(a).toEqual(b);
  }
  for (const job of state.jobs) {
    expect(job.sealedReply!.payload).not.toHaveProperty("evidenceRequestsNote");
    expect(job.sealedReply!.payload.evidenceRequests).toEqual([]);
  }
  for (const attempt of state.attempts) {
    expect(attempt.payload).toHaveProperty("evidenceRequestsNote");
    expect(attempt.payload).toEqual(JSON.parse(attempt.rawContent!));
  }
  expect(buildPeerReport(state).reviewStatus).toBe("complete");
  expect(state.segments[0]!.reviews.map((review) => review.positions.length)).toEqual([2, 2]);
});

it("runs a real local HTTP CLI session through failure, retry, continuation and export", async () => {
  let failDiscussionB = true;
  const requests: Array<{ model: string; phase: string; max_tokens: number }> = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    const phase = (JSON.parse(body.messages.at(-1)!.content) as { phase: string }).phase;
    requests.push({ model: body.model, phase, max_tokens: body.max_tokens });
    if (phase === "discussion" && body.model === "b" && failDiscussionB) {
      failDiscussionB = false;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "temporary" } }));
      return;
    }
    const payload =
      phase === "opening"
        ? { phase, conclusion: `${body.model} opening`, evidenceRequests: [], claims: [] }
        : { phase, conclusion: `${body.model} discussion`, evidenceRequests: [], actions: [], readyToReview: true };
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
  if (!address || typeof address === "string") throw new Error("No local port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      members: {
        "member-a": { profile: "deepseek", baseUrl, modelId: "a", apiKeyEnv: "FAKE_PEER_A" },
        "member-b": { profile: "deepseek", baseUrl, modelId: "b", apiKeyEnv: "FAKE_PEER_B" }
      }
    }),
    "utf8"
  );
  process.env.FAKE_PEER_A = "test-a";
  process.env.FAKE_PEER_B = "test-b";
  const sessionId = "scripted-cli";
  const started = await runCli(
    [
      "peer",
      "start",
      "--question",
      "Which?",
      "--config",
      config,
      "--session-id",
      sessionId,
      "--root",
      root,
      "--rounds",
      "2",
      "--max-output-tokens",
      "8192"
    ],
    io
  );
  expect(started.code).toBe(2);
  const paused = await new FilePeerStore(root).load(sessionId);
  expect(paused.status).toBe("paused");
  expect(paused.rounds).toHaveLength(1);
  expect(paused.jobs.filter((x) => x.status === "sealed")).toHaveLength(1);
  const priorCalls = requests.length;
  const resumed = await runCli(["peer", "retry", sessionId, "--root", root], io);
  expect(resumed.ok).toBe(true);
  expect(requests.length - priorCalls).toBe(3);
  expect(requests.every((x) => x.max_tokens === 8192)).toBe(true);
  const completed = await new FilePeerStore(root).load(sessionId);
  expect(completed.status).toBe("completed");
  expect(completed.rounds).toHaveLength(3);
  const failedAttempt = completed.attempts.find((attempt) => attempt.status === "failed");
  expect(failedAttempt).toBeDefined();
  logs.length = 0;
  expect((await runCli(["peer", "show", sessionId, "--root", root], io)).ok).toBe(true);
  expect(logs.join("\n")).toContain(`Uncommitted diagnostic: member-b failed`);
  const mdOutput = join(root, "retry-history.md");
  const htmlOutput = join(root, "retry-history.html");
  expect(
    (await runCli(["peer", "export", sessionId, "--root", root, "--format", "md", "--output", mdOutput], io)).ok
  ).toBe(true);
  const md = await prettier.__debug.parse(await readFile(mdOutput, "utf8"), { parser: "markdown" });
  const textValues: string[] = [];
  const collect = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const current = node as { type?: string; value?: string; children?: unknown[] };
    if (current.type === "text" && current.value) textValues.push(current.value);
    for (const child of current.children ?? []) collect(child);
  };
  collect(md.ast);
  expect(textValues.join("")).toContain(failedAttempt!.attemptId);
  expect(
    (await runCli(["peer", "export", sessionId, "--root", root, "--format", "html", "--output", htmlOutput], io)).ok
  ).toBe(true);
  const html = await readFile(htmlOutput, "utf8");
  const diagnosticSection = html
    .split("<details><summary>Uncommitted diagnostic attempts</summary>")[1]!
    .split("</details>")[0]!;
  expect(diagnosticSection).toContain(failedAttempt!.attemptId);
  logs.length = 0;
  expect(
    (await runCli(["peer", "continue", sessionId, "--root", root, "--note", "New context", "--rounds", "1"], io)).ok
  ).toBe(true);
  expect(logs.join("\n")).toMatch(/Segment 2 started: rounds 1\.\.1, calls 6, output tokens\/call 8192, deadline /);
  const beforeExport = requests.length;
  const output = join(root, "final.json");
  expect(
    (await runCli(["peer", "export", sessionId, "--root", root, "--format", "json", "--output", output], io)).ok
  ).toBe(true);
  expect(requests).toHaveLength(beforeExport);
  expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
    resultVersion: "peer.v1",
    status: "completed",
    segmentId: 2
  });
});
