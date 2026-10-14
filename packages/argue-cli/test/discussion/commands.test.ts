import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiscussionEngine,
  appendDiscussionRunEvent,
  createDiscussionRun,
  currentDiscussionSegment,
  type DiscussionRun,
  type DiscussionRunInput,
  type DiscussionRunStore,
  type FinalResult,
  type ModelCall,
  type ModelReply,
  type ModelTransport,
  type PeerSession
} from "@onevcat/argue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiscussionCommand, type DiscussionCommandDependencies } from "../../src/discussion/commands.js";
import { FileDiscussionStore } from "../../src/discussion/file-store.js";
import { FilePeerStore } from "../../src/peer/file-store.js";
import { peerRuntimeFromTransport } from "../../src/runtime/peer-api.js";
import paused from "../../../argue/test/discussion/fixtures/peer-v5-paused.json" with { type: "json" };

const INTERNAL = "PRIVATE_COMMAND_BOUNDARY_SENTINEL";
const SECRET = "PRIVATE_COMMAND_KEY_SENTINEL";
const now = () => Date.parse("2026-10-13T00:00:02.000Z");
const member = (id: string) => ({
  protocol: "openai-compatible",
  baseUrl: "https://offline.invalid/v1",
  modelId: id,
  apiKeyEnv: "TEST_API_KEY",
  outputMode: "json_object" as const,
  generationOptions: {}
});
const input = (): DiscussionRunInput => ({
  sessionId: "command-boundaries",
  question: "Which proposal?",
  members: { a: member("a"), b: member("b") },
  policy: { effort: "standard", maxRounds: 1 }
});
let directory: string, root: string, logs: string[], errors: string[], calls: ModelCall[], keyReads: number;
const io = { log: (text: string) => logs.push(text), error: (text: string) => errors.push(text) };
const env = () =>
  Object.defineProperty({}, "TEST_API_KEY", {
    enumerable: true,
    get: () => {
      keyReads++;
      return SECRET;
    }
  }) as Record<string, string | undefined>;
const clearOutput = () => {
  logs = [];
  errors = [];
};
function safeOutput() {
  const output = [...logs, ...errors].join("\n");
  expect(output).not.toContain(INTERNAL);
  expect(output).not.toContain(SECRET);
  for (const field of ["rawContent", "frozenInput", "attempts", "claims", "payload", "diagnostics"])
    expect(output).not.toContain(`"${field}"`);
}
function publicResult(): FinalResult {
  expect(logs).toHaveLength(1);
  safeOutput();
  return JSON.parse(logs[0]!);
}
const transport: ModelTransport = {
  respond: async (call) => {
    calls.push(structuredClone(call));
    return discussionReply(call);
  }
};
function discussionReply(call: ModelCall): ModelReply {
  const snapshot = JSON.parse(call.messages.find((message) => message.role === "user")!.content);
  const contract = snapshot.responseContract.byMember[call.modelId];
  const turn = structuredClone(contract.template);
  if (turn.phase === "opening") {
    turn.claims[0].statement = INTERNAL;
    turn.claims[0].rationale = INTERNAL;
    turn.answer.body = `Initial answer ${call.modelId}`;
    turn.complexity = "simple";
    turn.complexityRationale = INTERNAL;
  } else if (turn.phase === "discussion") {
    turn.answer.body = "Public selected proposal";
    turn.answer.basisVersionIds = contract.referenceSlots.activeBasisVersionIds;
    turn.readyToReview = true;
  } else
    for (const position of turn.positions) {
      position.stance = "accept";
      position.rationale = INTERNAL;
    }
  turn.evidenceRequests = [INTERNAL];
  return {
    modelId: call.modelId,
    protocol: call.protocol,
    generationOptions: call.generationOptions,
    usage: {},
    finishReason: "stop",
    rawContent: JSON.stringify(turn),
    payload: turn
  };
}
const legacyTransport: ModelTransport = {
  respond: async (call) => {
    calls.push(structuredClone(call));
    const context = JSON.parse(call.messages[1]!.content);
    const template = context.responseContract.template;
    const payload = {
      ...template,
      conclusion: INTERNAL,
      ...(context.phase === "opening"
        ? { claims: [{ statement: INTERNAL, rationale: INTERNAL, assumptions: [], sourceRefs: [] }] }
        : context.phase === "discussion"
          ? { actions: [], readyToReview: true }
          : {
              positions: template.positions.map((position: { versionId: string }) => ({
                ...position,
                stance: "uncertain",
                rationale: INTERNAL
              }))
            })
    };
    return {
      modelId: call.modelId,
      protocol: call.protocol,
      generationOptions: call.generationOptions,
      usage: {},
      finishReason: "stop",
      rawContent: JSON.stringify(payload),
      payload
    };
  }
};
const dependencies = (): DiscussionCommandDependencies => ({
  env: env(),
  transport,
  legacyRuntime: peerRuntimeFromTransport(legacyTransport),
  now
});
const missingEnvironment = () => ["--env-file", join(directory, "missing-credentials.env")];
async function command(args: string[], deps = dependencies()) {
  return runDiscussionCommand([...args, "--root", root, "--json"], io, deps);
}
async function writeLegacy(state: unknown = paused) {
  await mkdir(join(root, paused.config.sessionId), { recursive: true });
  await writeFile(join(root, paused.config.sessionId, "session.json"), JSON.stringify(state));
  return paused.config.sessionId;
}
async function saveDiscussion(run = createDiscussionRun(input(), now())) {
  const store = new FileDiscussionStore(root);
  await store.withWriter(run.sessionId, async (writer) => writer.commit(-1, run));
  return run;
}
async function completedDiscussion() {
  const store = new FileDiscussionStore(root);
  return store.withWriter(input().sessionId, async (writer) =>
    new DiscussionEngine(writer, transport, { now }).start(input())
  );
}
async function interruptedDiscussion(phase: "opening" | "review"): Promise<DiscussionRun> {
  const store = new FileDiscussionStore(root);
  await store.withWriter(input().sessionId, async (writer) => {
    const interrupted: DiscussionRunStore = {
      load: (id) => writer.load(id),
      commit: async (revision, next) => {
        const segment = currentDiscussionSegment(next);
        if (
          next.events.at(-1)?.type === "settled" &&
          segment.protocol.phase === phase &&
          segment.seals.filter((seal) => segment.currentBatch!.jobIds.includes(seal.jobId)).length === 2
        )
          throw new Error("Synthetic crash before second seal");
        await writer.commit(revision, next);
      }
    };
    await expect(new DiscussionEngine(interrupted, transport, { now }).start(input())).rejects.toThrow(
      "Synthetic crash"
    );
  });
  const run = await store.load(input().sessionId);
  expect(run.status).toBe("active");
  expect(currentDiscussionSegment(run).protocol.phase).toBe(phase);
  return run;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "discussion-command-boundaries-"));
  root = join(directory, "sessions");
  calls = [];
  keyReads = 0;
  clearOutput();
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe("legacy commands preserve peer-v5 and expose only an incomplete public result", () => {
  it.each(["show", "export:txt", "export:md", "export:json", "export:html", "view"])(
    "%s never reads credentials, calls models or rewrites the captured snapshot",
    async (kind) => {
      const state = structuredClone(paused);
      state.pauseReason.message = INTERNAL;
      const id = await writeLegacy(state);
      const file = join(root, id, "session.json");
      const before = await readFile(file, "utf8");
      const [action, format] = kind.split(":");
      const output = join(directory, `legacy-${kind.replace(":", ".")}`);
      const args = [action!, id, ...missingEnvironment()];
      if (format) args.push("--format", format, "--output", output);
      if (action === "view") args.push("--no-open", "--output", output);
      expect(await command(args)).toEqual({ ok: false, code: 2 });
      expect(publicResult()).toMatchObject({
        outcome: "incomplete",
        answer: "",
        selectedAnswerVersionIds: [],
        importantDissent: [],
        incompleteReason: "incomplete_review"
      });
      expect(publicResult().limitations.join(" ")).toContain("Legacy peer format: paused");
      expect(await readFile(file, "utf8")).toBe(before);
      expect(calls).toHaveLength(0);
      expect(keyReads).toBe(0);
      if (action !== "show") {
        const exported = await readFile(output, "utf8");
        expect(exported).toContain("incomplete");
        expect(exported).not.toContain(INTERNAL);
        expect((await stat(output)).mode & 0o777).toBe(0o600);
      }
    }
  );

  it("explicit retry uses the original frozen inputs/hashes and completed legacy state remains incomplete", async () => {
    const id = await writeLegacy();
    expect(await command(["retry", id])).toEqual({ ok: false, code: 2 });
    expect(publicResult().limitations.join(" ")).toContain("Legacy peer format: completed");
    expect(calls).toHaveLength(2 * (2 + paused.config.limits.minDiscussionRounds));
    const ended = await new FilePeerStore(root).load(id);
    expect(ended.status).toBe("completed");
    expect(ended.config).toEqual(paused.config);
    for (const original of paused.jobs) {
      const { outputSchema, ...frozen } = original.frozenInput;
      expect(outputSchema).toBeDefined();
      expect(calls.find((call) => call.modelId === frozen.modelId)).toEqual(frozen);
      expect(ended.jobs.find((job) => job.jobId === original.jobId)!.inputHash).toBe(original.inputHash);
    }
    const file = join(root, id, "session.json");
    const before = await readFile(file, "utf8");
    expect(before).toContain(INTERNAL);
    expect(JSON.parse(before)).not.toHaveProperty("runtimeVersion");
    const count = calls.length;
    keyReads = 0;
    for (const kind of ["show", "retry", "export:txt", "export:md", "export:json", "export:html", "view"]) {
      clearOutput();
      const [action, format] = kind.split(":");
      const args = [action!, id, ...missingEnvironment()];
      if (format) args.push("--format", format);
      if (action === "view") args.push("--no-open");
      expect(await command(args)).toEqual({ ok: false, code: 2 });
      expect(publicResult().outcome).toBe("incomplete");
      expect(await readFile(file, "utf8")).toBe(before);
      if (action === "export" || action === "view") {
        const artifact = await readFile(join(root, id, `final.${format ?? "html"}`), "utf8");
        expect(artifact).not.toContain(INTERNAL);
        expect(artifact).not.toContain(SECRET);
        expect(artifact).toContain("incomplete");
      }
    }
    expect(calls).toHaveLength(count);
    expect(keyReads).toBe(0);
    clearOutput();
    expect(await command(["continue", id, "--note", "Additional public material"])).toEqual({ ok: false, code: 2 });
    expect(publicResult().outcome).toBe("incomplete");
    const continued = await new FilePeerStore(root).load(id);
    expect(continued.currentSegmentId).toBe(2);
    expect(continued.config).toEqual(paused.config);
    expect(continued.jobs.slice(0, ended.jobs.length)).toEqual(ended.jobs);
    expect(continued).not.toHaveProperty("runtimeVersion");
  });

  it("first retry of an active legacy snapshot saves a pause with zero calls and zero key reads", async () => {
    const state = structuredClone(paused) as unknown as PeerSession;
    state.status = "active";
    delete state.pauseReason;
    for (const attempt of state.attempts) {
      attempt.status = "running";
      delete attempt.endedAt;
    }
    for (const job of state.jobs) job.status = "running";
    const id = await writeLegacy(state);
    expect(await new FilePeerStore(root).load(id)).toEqual(state);
    expect(await command(["retry", id, ...missingEnvironment()])).toEqual({ ok: false, code: 2 });
    expect(publicResult().outcome).toBe("incomplete");
    expect(calls).toHaveLength(0);
    expect(keyReads).toBe(0);
    const recovered = await new FilePeerStore(root).load(id);
    expect(recovered.status).toBe("paused");
    expect(recovered.attempts.map((attempt) => attempt.status)).toEqual(["unknown", "unknown"]);
    expect(recovered.jobs.map((job) => job.inputHash)).toEqual(state.jobs.map((job) => job.inputHash));
    expect(recovered.attempts).toHaveLength(state.attempts.length);
  });
});

describe("discussion CLI recovery and integrity gates", () => {
  it("active recovery keeps all charged attempts and seals; the second retry asks only the missing member", async () => {
    const initial = await interruptedDiscussion("opening");
    const old = currentDiscussionSegment(initial);
    const beforeCalls = calls.length;
    expect(beforeCalls).toBe(2);
    expect(old.seals).toHaveLength(1);
    const missing = old.jobs.find((job) => !old.seals.some((seal) => seal.jobId === job.jobId))!;
    expect(await command(["retry", initial.sessionId, ...missingEnvironment()])).toEqual({ ok: false, code: 2 });
    expect(publicResult().outcome).toBe("incomplete");
    expect(calls).toHaveLength(beforeCalls);
    expect(keyReads).toBe(0);
    const recovered = await new FileDiscussionStore(root).load(initial.sessionId);
    const segment = currentDiscussionSegment(recovered);
    expect(recovered.status).toBe("paused");
    expect(segment.jobs).toEqual(old.jobs);
    expect(segment.seals).toEqual(old.seals);
    expect(segment.ledger.attempts).toHaveLength(2);
    expect(segment.ledger.attempts.map((attempt) => attempt.status).sort()).toEqual(["succeeded", "unknown"]);
    expect(segment.ledger.attempts.map((attempt) => attempt.maxOutputTokens)).toEqual(
      old.ledger.attempts.map((attempt) => attempt.maxOutputTokens)
    );
    clearOutput();
    expect(await command(["retry", initial.sessionId])).toEqual({ ok: true, code: 0 });
    expect(
      calls.slice(beforeCalls).filter((call) => JSON.parse(call.messages[1]!.content).phase === "opening")
    ).toEqual([missing.call]);
    expect(publicResult().outcome).toBe("consensus");
    const final = currentDiscussionSegment(await new FileDiscussionStore(root).load(initial.sessionId));
    expect(final.ledger.attempts).toHaveLength(7);
    expect(final.ledger.attempts.find((attempt) => attempt.status === "unknown")).toEqual(
      segment.ledger.attempts.find((attempt) => attempt.status === "unknown")
    );
    expect(final.jobs.slice(0, old.jobs.length)).toEqual(old.jobs);
  });

  it("an incomplete review and internal pause message produce fixed incomplete results and public recovery tips", async () => {
    const active = await interruptedDiscussion("review");
    expect(currentDiscussionSegment(active).protocol.answerVersions.length).toBeGreaterThan(0);
    const before = calls.length;
    expect(await command(["show", active.sessionId, ...missingEnvironment()])).toEqual({ ok: false, code: 2 });
    expect(publicResult()).toMatchObject({ outcome: "incomplete", answer: "", incompleteReason: "incomplete_review" });
    expect(publicResult().limitations.join(" ")).toContain("first retry");
    const store = new FileDiscussionStore(root);
    await store.withWriter(active.sessionId, async (writer) => {
      const recovered = appendDiscussionRunEvent(active, { type: "recovered", atMs: now() });
      await writer.commit(active.revision, recovered);
      const resumed = appendDiscussionRunEvent(recovered, { type: "resumed", atMs: now() });
      await writer.commit(recovered.revision, resumed);
      await writer.commit(
        resumed.revision,
        appendDiscussionRunEvent(resumed, { type: "paused", atMs: now(), code: "manual", message: INTERNAL })
      );
    });
    clearOutput();
    expect(await command(["show", active.sessionId, ...missingEnvironment()])).toEqual({ ok: false, code: 2 });
    expect(publicResult()).toMatchObject({ outcome: "incomplete", answer: "", incompleteReason: "incomplete_review" });
    expect(publicResult().limitations.join(" ")).toContain("only missing members");
    expect(calls).toHaveLength(before);
    expect(keyReads).toBe(0);
    expect(await readFile(join(root, active.sessionId, "session.json"), "utf8")).toContain(INTERNAL);
  });

  it.each(["runtimeVersion", "promptVersion", "inputHash"])(
    "discussion %s corruption is rejected before any transport or credential access",
    async (field) => {
      const state = structuredClone(await interruptedDiscussion("opening"));
      const changed = JSON.parse(JSON.stringify(state));
      if (field === "runtimeVersion") changed.runtimeVersion = "unsupported";
      else if (field === "promptVersion") changed.promptVersion = "peer-v99";
      else changed.segments[0].jobs[0].inputHash = "sha256:corrupt";
      await writeFile(join(root, state.sessionId, "session.json"), JSON.stringify(changed));
      const count = calls.length;
      expect(await command(["retry", state.sessionId, ...missingEnvironment()])).toEqual({ ok: false, code: 1 });
      expect(logs).toEqual([]);
      expect(errors.join(" ")).toMatch(/snapshot|version|format/i);
      safeOutput();
      expect(calls).toHaveLength(count);
      expect(keyReads).toBe(0);
    }
  );

  it.each(["promptVersion", "inputHash"])("legacy %s corruption cannot dispatch model calls", async (field) => {
    const changed = JSON.parse(JSON.stringify(paused));
    if (field === "promptVersion") changed.config.promptVersion = "peer-v99";
    else changed.jobs[0].inputHash = "sha256:corrupt";
    const id = await writeLegacy(changed);
    expect(await command(["retry", id])).toEqual({ ok: false, code: 1 });
    expect(logs).toEqual([]);
    safeOutput();
    expect(calls).toHaveLength(0);
  });
});

describe("read-only results and private artifact paths", () => {
  it.each(["show", "export", "view"])(
    "%s ignores an explicit absent credential file and never calls models or reads key getters",
    async (action) => {
      const run = await completedDiscussion();
      const before = await readFile(join(root, run.sessionId, "session.json"), "utf8");
      const count = calls.length;
      const args = [action, run.sessionId, ...missingEnvironment()];
      if (action === "export") args.push("--format", "json");
      if (action === "view") args.push("--no-open");
      expect(await command(args)).toEqual({ ok: true, code: 0 });
      expect(publicResult()).toEqual(currentDiscussionSegment(run).finalResult);
      expect(calls).toHaveLength(count);
      expect(keyReads).toBe(0);
      expect(await readFile(join(root, run.sessionId, "session.json"), "utf8")).toBe(before);
    }
  );

  it("exports tighten existing public file permissions and keep default artifact files private", async () => {
    const run = await saveDiscussion();
    const output = join(directory, "existing-result.json");
    await writeFile(output, "old public data", { mode: 0o644 });
    expect(await command(["export", run.sessionId, "--format", "json", "--output", output])).toEqual({
      ok: false,
      code: 2
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(publicResult());
    clearOutput();
    expect(await command(["view", run.sessionId, "--no-open"])).toEqual({ ok: false, code: 2 });
    expect((await stat(join(root, run.sessionId, "final.html"))).mode & 0o777).toBe(0o600);
    safeOutput();
  });

  it.each(["session.json", ".writer.lock", ".recovery.lock"])("cannot export over authoritative %s", async (name) => {
    const run = await saveDiscussion();
    const snapshot = join(root, run.sessionId, "session.json");
    const before = await readFile(snapshot, "utf8");
    expect(
      await command(["export", run.sessionId, "--format", "json", "--output", join(root, run.sessionId, name)])
    ).toEqual({
      ok: false,
      code: 1
    });
    expect(logs).toEqual([]);
    expect(errors.join(" ")).toContain("cannot replace");
    expect(await readFile(snapshot, "utf8")).toBe(before);
    expect(calls).toHaveLength(0);
    expect(keyReads).toBe(0);
  });

  it("rejects a symlink artifact and preserves both its target and the authoritative snapshot", async () => {
    const run = await saveDiscussion();
    const snapshot = join(root, run.sessionId, "session.json");
    const before = await readFile(snapshot, "utf8");
    const target = join(directory, "outside.json");
    const output = join(directory, "linked-result.json");
    await writeFile(target, "Private unrelated file");
    await symlink(target, output);
    expect(await command(["export", run.sessionId, "--format", "json", "--output", output])).toEqual({
      ok: false,
      code: 1
    });
    expect(await readFile(target, "utf8")).toBe("Private unrelated file");
    expect(await readFile(snapshot, "utf8")).toBe(before);
    expect(logs).toEqual([]);
    safeOutput();
    expect(calls).toHaveLength(0);
    expect(keyReads).toBe(0);
  });
});
