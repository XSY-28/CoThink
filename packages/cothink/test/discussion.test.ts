import { mkdtemp, readFile, writeFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  appendDiscussionRunEvent,
  currentDiscussionSegment,
  parseDiscussionRun,
  type ModelCall,
  type ModelTransport
} from "@onevcat/argue";
import { runCoThink } from "../src/index.js";
const INTERNAL = "INTERNAL_DISCUSSION_SENTINEL";
let root: string, config: string, sessions: string, logs: string[], errors: string[], calls: ModelCall[];
let failA = false,
  divided = false,
  dissent = false;
const io = { log: (value: string) => logs.push(value), error: (value: string) => errors.push(value) };
const transport: ModelTransport = {
  respond: async (call) => {
    calls.push(structuredClone(call));
    const snapshot = JSON.parse(call.messages[1]!.content),
      member = call.modelId === "a" ? "member-a" : "member-b";
    const contract = snapshot.responseContract.byMember[member],
      turn = structuredClone(contract.template);
    if (failA && member === "member-a") {
      failA = false;
      throw Error(INTERNAL + " fake-a fake-b");
    }
    if (turn.phase === "opening") {
      turn.claims[0] = { statement: INTERNAL, rationale: INTERNAL, assumptions: [], sourceRefs: [] };
      turn.answer.body = `Initial ${member}`;
      turn.complexity = "complex";
      turn.complexityRationale = INTERNAL;
    } else if (turn.phase === "discussion") {
      turn.answer.body = `FINAL_ANSWER_${call.modelId.toUpperCase()}`;
      turn.answer.basisVersionIds = contract.referenceSlots.activeBasisVersionIds;
      turn.readyToReview = true;
      if (dissent && member === "member-a")
        turn.actions = [
          {
            kind: "object",
            objection: {
              targetAnswerVersionId: snapshot.answerVersions.find(
                (item: { authorId: string }) => item.authorId === "member-b"
              ).answerVersionId,
              severity: "material",
              summary: "Public dissent",
              impact: "Public impact",
              evidenceNeeded: "Public evidence needed"
            }
          }
        ];
    } else {
      for (const position of turn.positions) {
        position.stance = divided && position.kind === "answer" ? "reject" : "accept";
        position.rationale = INTERNAL;
        if (position.kind === "objection" && "status" in position)
          Object.assign(position, {
            status: "retained",
            summary: "Public dissent",
            impact: "Public impact",
            evidenceNeeded: "Public evidence needed"
          });
      }
    }
    turn.evidenceRequests = [INTERNAL];
    return {
      rawContent: JSON.stringify(turn),
      payload: turn,
      modelId: call.modelId,
      protocol: call.protocol,
      generationOptions: call.generationOptions,
      usage: { outputTokens: 20 },
      finishReason: "stop"
    };
  }
};
const dependencies = () => ({ env: { A: "fake-a", B: "fake-b" }, transport });
const start = (extra: string[] = []) =>
  runCoThink(
    [
      "start",
      "--config",
      config,
      "--root",
      sessions,
      "--session-id",
      "public-flow",
      "--question",
      "Which proposal?",
      "--max-rounds",
      "1",
      ...extra
    ],
    io,
    dependencies()
  );
const reset = () => {
  logs = [];
  errors = [];
};
const safe = () => {
  expect([...logs, ...errors].join("\n")).not.toContain(INTERNAL);
  expect([...logs, ...errors].join("\n")).not.toContain("fake-a");
  expect([...logs, ...errors].join("\n")).not.toContain("fake-b");
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-discussion-cli-"));
  config = join(root, "config.json");
  sessions = join(root, "sessions");
  reset();
  calls = [];
  failA = false;
  divided = false;
  dissent = false;
  await writeFile(
    config,
    JSON.stringify({
      configVersion: 2,
      members: {
        "member-a": {
          protocol: "openai-compatible",
          baseUrl: "https://offline.invalid",
          modelId: "a",
          apiKeyEnv: "A",
          generationOptions: { privateMarker: INTERNAL }
        },
        "member-b": { protocol: "openai-compatible", baseUrl: "https://offline.invalid", modelId: "b", apiKeyEnv: "B" }
      },
      discussion: { effort: "standard" }
    })
  );
});
afterEach(async () => rm(root, { recursive: true, force: true }));
it("new default discussion CLI hides internal sentinel in every final output, export and HTML source", async () => {
  expect(await start(["--json"])).toEqual({ ok: true, code: 0 });
  expect(calls).toHaveLength(6);
  safe();
  const result = JSON.parse(logs.join("\n"));
  expect(result.outcome).toBe("consensus");
  expect(result.answer).toMatch(/^FINAL_ANSWER_/);
  const saved = await readFile(join(sessions, "public-flow", "session.json"), "utf8");
  expect(saved).toContain(INTERNAL);
  expect(parseDiscussionRun(JSON.parse(saved)).schemaVersion).toBe(2);
  for (const json of [false, true]) {
    reset();
    expect(
      (
        await runCoThink(
          [
            "show",
            "public-flow",
            "--root",
            sessions,
            "--env-file",
            join(root, "missing-secret"),
            ...(json ? ["--json"] : [])
          ],
          io,
          { env: {}, transport }
        )
      ).code
    ).toBe(0);
    safe();
    if (json) expect(JSON.parse(logs.join("\n"))).toEqual(result);
  }
  for (const format of ["txt", "md", "json", "html"]) {
    reset();
    const output = join(root, `result.${format}`);
    expect(
      (
        await runCoThink(
          [
            "export",
            "public-flow",
            "--root",
            sessions,
            "--format",
            format,
            "--output",
            output,
            "--json",
            "--env-file",
            join(root, "missing-secret")
          ],
          io,
          { env: {}, transport }
        )
      ).code
    ).toBe(0);
    safe();
    expect(JSON.parse(logs.join("\n"))).toEqual(result);
    const content = await readFile(output, "utf8");
    expect(content).not.toContain(INTERNAL);
    expect(content).not.toContain("fake-a");
    expect(content).toContain(result.answer);
  }
  reset();
  const html = join(root, "view.html");
  expect(
    (
      await runCoThink(["view", "public-flow", "--root", sessions, "--output", html, "--no-open", "--json"], io, {
        env: {},
        transport
      })
    ).code
  ).toBe(0);
  safe();
  expect(await readFile(html, "utf8")).not.toContain(INTERNAL);
  expect(calls).toHaveLength(6);
  expect(await readFile(join(sessions, "public-flow", "session.json"), "utf8")).toBe(saved);
}, 20000);
it("weighted fallback exposes original latest answer and sourced important dissent, while ties preserve alternatives", async () => {
  divided = true;
  dissent = true;
  expect((await start(["--decision-weight", "member-b=2", "--json"])).code).toBe(0);
  safe();
  const result = JSON.parse(logs.join("\n"));
  expect(result.outcome).toBe("weighted_fallback");
  expect(result.answer).toBe("FINAL_ANSWER_B");
  expect(result.importantDissent[0].summary).toBe("Public dissent");
  expect(calls).toHaveLength(6);
  reset();
  expect(
    (
      await runCoThink(
        [
          "continue",
          "public-flow",
          "--root",
          sessions,
          "--note",
          "New evidence",
          "--max-rounds",
          "1",
          "--decision-weight",
          "member-b=1",
          "--json"
        ],
        io,
        dependencies()
      )
    ).code
  ).toBe(0);
  safe();
  const next = JSON.parse(logs.join("\n"));
  expect(next.outcome).toBe("tied_preferences");
  expect(next.answer).toBe("");
  expect(next.alternatives).toHaveLength(2);
  expect(calls).toHaveLength(12);
}, 20000);
it("explicit retry only asks missing member; unknown failure diagnostics never reach outputs", async () => {
  failA = true;
  expect((await start(["--json"])).code).toBe(2);
  expect(calls).toHaveLength(2);
  safe();
  expect(JSON.parse(logs.join("\n")).outcome).toBe("incomplete");
  const old = JSON.parse(await readFile(join(sessions, "public-flow", "session.json"), "utf8"));
  expect(currentDiscussionSegment(old).protocol.answerVersions).toHaveLength(0);
  reset();
  expect((await runCoThink(["retry", "public-flow", "--root", sessions, "--json"], io, dependencies())).code).toBe(0);
  expect(calls).toHaveLength(7);
  safe();
  expect(calls[2]).toEqual(calls[0]);
  expect(JSON.parse(logs.join("\n")).outcome).toBe("consensus");
}, 20000);
it("question-file and CLI overrides freeze real policy and a new segment without rewriting old inputs or configuration", async () => {
  const bytes = await readFile(config, "utf8"),
    question = join(root, "question.txt"),
    context = join(root, "context.md");
  await writeFile(question, "Question read as UTF-8");
  await writeFile(context, INTERNAL);
  expect(
    (
      await runCoThink(
        [
          "start",
          "--config",
          config,
          "--root",
          sessions,
          "--session-id",
          "file-flow",
          "--question-file",
          question,
          "--context",
          context,
          "--effort",
          "low",
          "--participation-weight",
          "member-a=2",
          "--decision-weight",
          "member-b=3",
          "--max-rounds",
          "1",
          "--json"
        ],
        io,
        dependencies()
      )
    ).code
  ).toBe(0);
  safe();
  const before = parseDiscussionRun(JSON.parse(await readFile(join(sessions, "file-flow", "session.json"), "utf8"))),
    first = currentDiscussionSegment(before);
  expect(first.protocol.question).toBe("Question read as UTF-8");
  expect(first.protocol.policy.effort).toBe("low");
  expect(first.protocol.policy.weights["member-a"]!.participationWeight).toBe(2);
  expect(first.protocol.policy.weights["member-b"]!.decisionWeight).toBe(3);
  expect(await readFile(config, "utf8")).toBe(bytes);
  reset();
  expect(
    (
      await runCoThink(
        [
          "continue",
          "file-flow",
          "--root",
          sessions,
          "--note",
          "New evidence",
          "--effort",
          "high",
          "--decision-weight",
          "member-a=4",
          "--max-rounds",
          "1",
          "--json"
        ],
        io,
        dependencies()
      )
    ).code
  ).toBe(0);
  safe();
  const next = parseDiscussionRun(JSON.parse(await readFile(join(sessions, "file-flow", "session.json"), "utf8")));
  expect(next.segments[0]).toEqual(first);
  expect(currentDiscussionSegment(next).protocol.policy.effort).toBe("high");
  expect(currentDiscussionSegment(next).protocol.policy.weights["member-a"]!.decisionWeight).toBe(4);
  expect(calls).toHaveLength(12);
}, 20000);
it("invalid questions, weights and duplicate inputs are rejected before calls or creating sessions", async () => {
  for (const args of [
    [],
    ["--question", "x", "--question-file", "y"],
    ["--question", " "],
    ["--question", "x", "--participation-weight", "member-a=0"],
    ["--question", "x", "--decision-weight", "member-b=NaN"],
    ["--question", "x", "--decision-weight", "unknown=2"],
    ["--question", "x", "--effort", "maximum"]
  ]) {
    reset();
    const result = await runCoThink(["start", "--config", config, "--root", sessions, ...args], io, dependencies());
    expect(result.code).toBe(1);
    safe();
    expect(logs).toHaveLength(0);
  }
  expect(calls).toHaveLength(0);
});

it("rejects invalid retry extensions before even the zero-call recovery can mutate an active snapshot", async () => {
  failA = true;
  await start();
  const path = join(sessions, "public-flow", "session.json");
  const paused = parseDiscussionRun(JSON.parse(await readFile(path, "utf8"))),
    active = appendDiscussionRunEvent(paused, { type: "resumed", atMs: paused.events.at(-1)!.atMs });
  const bytes = JSON.stringify(active);
  for (const extension of [
    ["--extra-calls", "NaN"],
    ["--extra-calls", "0"],
    ["--extend-seconds", "9007199254740991"]
  ]) {
    await writeFile(path, bytes);
    reset();
    expect(
      (await runCoThink(["retry", "public-flow", "--root", sessions, ...extension], io, dependencies())).code
    ).toBe(1);
    expect(await readFile(path, "utf8")).toBe(bytes);
    safe();
  }
  expect(calls).toHaveLength(2);
});
it("rejects per-member input character overflow before creating a session or dispatching", async () => {
  const raw = JSON.parse(await readFile(config, "utf8"));
  raw.members["member-a"].maxInputCharacters = 20;
  await writeFile(config, JSON.stringify(raw));
  expect((await start()).code).toBe(1);
  expect(calls).toHaveLength(0);
  await expect(readFile(join(sessions, "public-flow", "session.json"), "utf8")).rejects.toThrow();
  safe();
});

it("refuses a hard-linked export target so read commands cannot overwrite the saved session", async () => {
  await start();
  const path = join(sessions, "public-flow", "session.json"),
    bytes = await readFile(path, "utf8"),
    output = join(root, "linked.html");
  await link(path, output);
  reset();
  expect(
    (
      await runCoThink(["export", "public-flow", "--root", sessions, "--format", "html", "--output", output], io, {
        env: {},
        transport
      })
    ).code
  ).toBe(1);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(calls).toHaveLength(6);
  safe();
});

it("rejects invalid continue effort and member weights before active recovery changes state", async () => {
  failA = true;
  await start();
  const path = join(sessions, "public-flow", "session.json"),
    paused = parseDiscussionRun(JSON.parse(await readFile(path, "utf8"))),
    active = appendDiscussionRunEvent(paused, { type: "resumed", atMs: paused.events.at(-1)!.atMs }),
    bytes = JSON.stringify(active);
  for (const flags of [
    ["--effort", "maximum"],
    ["--decision-weight", "unknown=2"],
    ["--participation-weight", "member-a=NaN"],
    ["--max-calls", "999"]
  ]) {
    await writeFile(path, bytes);
    reset();
    expect((await runCoThink(["continue", "public-flow", "--root", sessions, ...flags], io, dependencies())).code).toBe(
      1
    );
    expect(await readFile(path, "utf8")).toBe(bytes);
    safe();
  }
  expect(calls).toHaveLength(2);
});
