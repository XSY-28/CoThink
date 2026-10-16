import { test, expect } from "vitest";
import { runBuildCommand } from "../../src/build/commands.js";

test("unknown build parameters fail before any run or provider side effect", async () => {
  const errors: string[] = [];
  const result = await runBuildCommand(["start", "--unknown", "--json"], {
    log() {},
    error(value) {
      errors.push(String(value));
    }
  });
  expect(result).toEqual({ ok: false, code: 1 });
  expect(errors.join("\n")).toContain("BUILD_ARGUMENT");
});

import { mkdtemp, cp, readFile, writeFile, realpath, rm, lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, vi } from "vitest";
import { FrozenBuildPlanSchema, freezeBuildPlan, hashBuildValue, type ModelTransport } from "@onevcat/argue";
import { DockerVerifier } from "../../src/build/validator.js";
import { BuildDiscussionLink } from "../../src/build/discussion-link.js";
import { FileBuildStore } from "../../src/build/file-store.js";
import { resolveBuildDevelopmentRoot } from "../../src/build/commands.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "cothink-build-cli-")));
  roots.push(temp);
  const source = join(temp, "input"),
    root = join(temp, "catalogue");
  await cp(resolve("../../examples/todo-stats"), source, { recursive: true });
  const { planHash: _hash, ...raw } = FrozenBuildPlanSchema.parse(
    JSON.parse(await readFile(join(source, "build-plan.json"), "utf8"))
  );
  void _hash;
  const kept = ["SPEC.md", "src/normalize.ts", "src/report.ts"];
  const plan = freezeBuildPlan({
    ...raw,
    manifest: raw.manifest.filter((f) => kept.includes(f.path)),
    tasks: [{ ...raw.tasks[0]!, scope: { read: ["SPEC.md"], write: ["src/normalize.ts"] } }]
  });
  const request = {
    integrationVersion: "build-integration-v1",
    requestId: "cli-fixture",
    frozenBuildPlan: plan,
    materialRefs: plan.manifest.map(({ path, contentHash }) => ({ path, contentHash }))
  };
  const requestPath = join(temp, "request.json"),
    configPath = join(temp, "config.json"),
    envPath = join(temp, "keys.env");
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(
    configPath,
    JSON.stringify({
      configVersion: 2,
      members: {
        "member-a": { profile: "openai-compatible", baseUrl: "http://127.0.0.1:9", modelId: "a" },
        "member-b": { profile: "openai-compatible", baseUrl: "http://127.0.0.1:9", modelId: "b" }
      }
    })
  );
  await writeFile(envPath, "PEER_A_API_KEY=private-alpha\nPEER_B_API_KEY=private-beta\n");
  const argv = [
    "start",
    "--project",
    source,
    "--request",
    requestPath,
    "--approve-plan",
    plan.planHash,
    "--config",
    configPath,
    "--root",
    root,
    "--image",
    `sha256:${"a".repeat(64)}`,
    "--env-file",
    envPath,
    "--json"
  ];
  const logs: string[] = [],
    errors: string[] = [],
    io = {
      log(value: unknown) {
        logs.push(String(value));
      },
      error(value: unknown) {
        errors.push(String(value));
      }
    };
  return { temp, source, root, plan, request, requestPath, configPath, envPath, argv, logs, errors, io };
}
function verifierCapability() {
  vi.spyOn(DockerVerifier.prototype, "describe").mockRejectedValue(
    Error("BUILD_DOCKER_UNAVAILABLE: unit capability absent")
  );
}
function abortTransport(counter: { calls: number }): ModelTransport {
  return {
    async respond(call) {
      counter.calls++;
      const input = JSON.parse(call.messages.find((m) => m.role === "user")!.content);
      const payload = {
        actionVersion: "build-action-v1",
        requestId: input.requestId,
        action: { kind: "abort", reason: "private nonce provider trace" }
      };
      return {
        rawContent: JSON.stringify(payload),
        payload,
        modelId: call.modelId,
        protocol: call.protocol,
        generationOptions: {},
        usage: { outputTokens: 1 },
        finishReason: "stop"
      };
    }
  };
}

test("trusted development checkout resolution is anchored to host module rather than candidate", async () => {
  expect(await resolveBuildDevelopmentRoot()).toBe(resolve("../.."));
});

test.each(["unapproved", "unknown-field", "budget", "config", "source", "image"])(
  "%s rejects before catalogue creation and before credential access",
  async (kind) => {
    const f = await fixture();
    if (kind === "unapproved") f.argv[f.argv.indexOf("--approve-plan") + 1] = `sha256:${"f".repeat(64)}`;
    if (kind === "unknown-field") await writeFile(f.requestPath, JSON.stringify({ ...f.request, approved: true }));
    if (kind === "budget")
      await writeFile(
        f.requestPath,
        JSON.stringify({ ...f.request, frozenBuildPlan: { ...f.plan, budget: { ...f.plan.budget, maxCalls: 0 } } })
      );
    if (kind === "config")
      await writeFile(f.configPath, JSON.stringify({ configVersion: 2, members: {}, credential: "raw-secret" }));
    if (kind === "source") await writeFile(join(f.source, "src/normalize.ts"), "altered");
    if (kind === "image") f.argv[f.argv.indexOf("--image") + 1] = "node:latest";
    await rm(f.envPath);
    const result = await runBuildCommand(f.argv, f.io, {
      env: new Proxy(
        {},
        {
          get() {
            throw Error("KEY_READ");
          },
          ownKeys() {
            throw Error("KEY_ENUM");
          }
        }
      )
    });
    expect(result.code).toBe(1);
    await expect(lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.errors.join()).not.toMatch(/KEY_READ|KEY_ENUM|raw-secret/);
  }
);

test("Docker absence is an explicit incomplete result; reads and first retry never open keys or call transport", async () => {
  const f = await fixture();
  verifierCapability();
  const counter = { calls: 0 };
  const started = await runBuildCommand(f.argv, f.io, { transport: abortTransport(counter), env: {} });
  expect(started.code).toBe(2);
  const output = JSON.parse(f.logs.at(-1)!);
  expect(output.error).toBe("BUILD_DOCKER_UNAVAILABLE");
  expect(counter.calls).toBe(0);
  const version = output.acceptedVersion;
  await rm(f.envPath);
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("KEY_READ");
      },
      ownKeys() {
        throw Error("KEY_ENUM");
      }
    }
  );
  expect((await runBuildCommand(["show", output.runId, "--root", f.root, "--json"], f.io, { env })).code).toBe(0);
  expect((await runBuildCommand(["retry", output.runId, "--root", f.root, "--json"], f.io, { env })).code).toBe(2);
  expect(JSON.parse(f.logs.at(-1)!).acceptedVersion).toBe(version);
  expect(counter.calls).toBe(0);
  const exported = join(f.temp, "exported");
  expect(
    (await runBuildCommand(["export", output.runId, "--root", f.root, "--output", exported, "--json"], f.io, { env }))
      .code
  ).toBe(0);
  expect(await readFile(join(exported, "src/normalize.ts"), "utf8")).toBe(
    await readFile(join(f.source, "src/normalize.ts"), "utf8")
  );
  expect((await runBuildCommand(f.argv, f.io, { env })).code).toBe(2);
  expect(counter.calls).toBe(0);
  expect(f.logs.join()).not.toMatch(/private-alpha|private-beta|nonce provider trace|generationOptions|apiKeyEnv/);
}, 120000);

test("first CLI retry only recovers; second resumes a frozen profile without redoing accepted tasks", async () => {
  const f = await fixture();
  vi.spyOn(DockerVerifier.prototype, "describe").mockResolvedValue({
    groups: ["common"],
    checksHash: `sha256:${"a".repeat(64)}`,
    toolchainHash: `sha256:${"b".repeat(64)}`,
    isolationHash: `sha256:${"c".repeat(64)}`,
    imageDigest: `sha256:${"d".repeat(64)}`
  });
  const counter = { calls: 0 },
    transport = abortTransport(counter);
  expect((await runBuildCommand(f.argv, f.io, { transport, env: {} })).code).toBe(2);
  expect(counter.calls).toBe(1);
  const first = JSON.parse(f.logs.at(-1)!);
  const retry = ["retry", first.runId, "--root", f.root, "--json"];
  expect(
    (
      await runBuildCommand(retry, f.io, {
        env: new Proxy(
          {},
          {
            get() {
              throw Error("KEY_READ");
            },
            ownKeys() {
              throw Error("KEY_ENUM");
            }
          }
        )
      })
    ).code
  ).toBe(2);
  expect(counter.calls).toBe(1);
  expect((await runBuildCommand(retry, f.io, { transport, env: {} })).code).toBe(2);
  expect(counter.calls).toBe(2);
  const binding = await new BuildDiscussionLink(f.root).get(first.runId);
  const state = await new FileBuildStore({
    workspaceRoot: binding.workspaceRoot,
    projectKey: f.plan.projectKey
  }).load();
  expect(state.calls).toHaveLength(2);
  expect(state.acceptedVersion).toBe(first.acceptedVersion);
  expect((await runBuildCommand(["cancel", first.runId, "--root", f.root, "--json"], f.io)).code).toBe(0);
  expect((await runBuildCommand(["cancel", first.runId, "--root", f.root, "--json"], f.io)).code).toBe(0);
  expect(JSON.parse(f.logs.at(-1)!).status).toBe("cancelled");
  expect(counter.calls).toBe(2);
}, 120000);

test("export protected paths and aliases cannot change the official pointer", async () => {
  const f = await fixture();
  verifierCapability();
  await runBuildCommand(f.argv, f.io, { transport: abortTransport({ calls: 0 }), env: {} });
  const before = JSON.parse(f.logs.at(-1)!);
  for (const target of [f.root, f.source, f.configPath, f.envPath, join(f.root, "nested")]) {
    expect(
      (await runBuildCommand(["export", before.runId, "--root", f.root, "--output", target, "--json"], f.io)).code
    ).not.toBe(0);
    expect(JSON.parse(f.logs.at(-1)!).acceptedVersion).toBe(before.acceptedVersion);
  }
}, 120000);

test("a crash after bridge reservation binds the same run, then first retry seeds V0 with zero calls and zero Docker checks", async () => {
  const f = await fixture(),
    link = new BuildDiscussionLink(f.root);
  const reserved = await link.reserve(f.request, {
    approvedPlanHash: f.plan.planHash,
    sourceRoot: f.source,
    hostContext: await contextFor(f)
  });
  expect(reserved.created).toBe(true);
  expect(reserved.recoveryRequired).toBe(true);
  const counter = { calls: 0 },
    transport = abortTransport(counter),
    describe = vi
      .spyOn(DockerVerifier.prototype, "describe")
      .mockRejectedValue(Error("Docker must not be queried during recovery"));
  expect((await runBuildCommand(f.argv, f.io, { transport, env: {} })).code).toBe(2);
  const replay = JSON.parse(f.logs.at(-1)!);
  expect(replay.runId).toBe(reserved.runId);
  expect(counter.calls).toBe(0);
  await rm(f.envPath);
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("KEY_READ");
      },
      ownKeys() {
        throw Error("KEY_ENUM");
      }
    }
  );
  expect((await runBuildCommand(["retry", reserved.runId, "--root", f.root, "--json"], f.io, { env })).code).toBe(2);
  const recovered = JSON.parse(f.logs.at(-1)!);
  expect(recovered.acceptedVersion).toMatch(/^[a-f0-9]{40}$/);
  expect(recovered.budget.calls).toBe(0);
  expect(recovered.recoveryRequired).toBe(false);
  expect(describe).not.toHaveBeenCalled();
  expect(counter.calls).toBe(0);
  expect((await link.get(reserved.runId)).runId).toBe(reserved.runId);
}, 120000);

test("read-only commands reject credential-related flags without touching the environment", async () => {
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("KEY_READ");
      },
      ownKeys() {
        throw Error("KEY_ENUM");
      }
    }
  );
  for (const command of ["show", "export"]) {
    const errors: string[] = [];
    const result = await runBuildCommand(
      [command, "run", "--root", "/not-created", "--env-file", "/never-read", "--json"],
      {
        log() {},
        error(value) {
          errors.push(String(value));
        }
      },
      { env }
    );
    expect(result.code).toBe(1);
    expect(errors.join()).toContain("BUILD_ARGUMENT_INVALID");
  }
});

import { parseBuildConfig } from "../../src/build/config.js";
async function contextFor(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    contextVersion: "build-cli-host-v1",
    configPath: f.configPath,
    configHash: hashBuildValue(JSON.parse(await readFile(f.configPath, "utf8"))),
    requestPath: f.requestPath,
    envPath: f.envPath,
    image: `sha256:${"a".repeat(64)}`,
    repoRoot: resolve("../.."),
    models: parseBuildConfig(JSON.parse(await readFile(f.configPath, "utf8")), f.plan, {})
  };
}

test("direct first retry recovers an atomic reservation without CLI metadata or credential files", async () => {
  const f = await fixture();
  const hostContext = await contextFor(f);
  const reserved = await new BuildDiscussionLink(f.root).reserve(f.request, {
    approvedPlanHash: f.plan.planHash,
    sourceRoot: f.source,
    hostContext
  });
  await rm(f.envPath);
  await rm(f.configPath);
  await rm(f.requestPath);
  const describe = vi.spyOn(DockerVerifier.prototype, "describe").mockRejectedValue(Error("RECOVERY_DOCKER_FORBIDDEN"));
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("KEY_READ");
      },
      ownKeys() {
        throw Error("KEY_ENUM");
      }
    }
  );
  const result = await runBuildCommand(["retry", reserved.runId, "--root", f.root, "--json"], f.io, { env });
  expect(result.code).toBe(2);
  expect(JSON.parse(f.logs.at(-1)!).budget.calls).toBe(0);
  expect(describe).not.toHaveBeenCalled();
}, 120000);

test("active cancellation distinguishes a persisted request from acknowledged revocation and rejects a valid late edit", async () => {
  const f = await fixture();
  vi.spyOn(DockerVerifier.prototype, "describe").mockResolvedValue({
    groups: ["common"],
    checksHash: `sha256:${"a".repeat(64)}`,
    toolchainHash: `sha256:${"b".repeat(64)}`,
    isolationHash: `sha256:${"c".repeat(64)}`,
    imageDigest: `sha256:${"d".repeat(64)}`
  });
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const modelEntered = deferred<void>(),
    pollEntered = deferred<void>(),
    releasePoll = deferred<void>();
  let pending = false,
    activeLinkKnown = false,
    releaseReply!: (value: Awaited<ReturnType<ModelTransport["respond"]>>) => void;
  let validLateReply: Awaited<ReturnType<ModelTransport["respond"]>> | undefined;
  const activeLinks = new WeakSet<BuildDiscussionLink>();
  const originalGet = BuildDiscussionLink.prototype.get;
  vi.spyOn(BuildDiscussionLink.prototype, "get").mockImplementation(async function (
    this: BuildDiscussionLink,
    id: string
  ) {
    if (!activeLinkKnown) {
      activeLinks.add(this);
      activeLinkKnown = true;
    }
    if (activeLinks.has(this) && pending) {
      pollEntered.resolve();
      await releasePoll.promise;
    }
    return originalGet.call(this, id);
  });
  let calls = 0;
  const transport: ModelTransport = {
    async respond(call) {
      calls++;
      const input = JSON.parse(call.messages.find((m) => m.role === "user")!.content);
      const payload = {
        actionVersion: "build-action-v1",
        requestId: input.requestId,
        action: {
          kind: "edit",
          path: "src/normalize.ts",
          expectedContentHash: f.plan.manifest.find((x) => x.path === "src/normalize.ts")!.contentHash,
          text: "export const lateMutation = true;\n"
        }
      };
      validLateReply = {
        rawContent: JSON.stringify(payload),
        payload,
        modelId: call.modelId,
        protocol: call.protocol,
        generationOptions: {},
        usage: { outputTokens: 1 },
        finishReason: "stop"
      };
      pending = true;
      modelEntered.resolve();
      return new Promise((resolveReply) => {
        releaseReply = resolveReply;
      });
    }
  };
  const running = runBuildCommand(f.argv, f.io, { transport, env: {} });
  await modelEntered.promise;
  await pollEntered.promise;
  const runId = `build-${hashBuildValue(f.request.requestId).slice(7, 55)}`,
    cancel = ["cancel", runId, "--root", f.root, "--json"];
  const cancelLogs: string[] = [];
  const cancelIo = {
    log(value: unknown) {
      cancelLogs.push(String(value));
    },
    error: f.io.error
  };
  try {
    const pendingResult = await runBuildCommand(cancel, cancelIo, { cancelTimeoutMs: 25 });
    expect(pendingResult).toEqual({ ok: false, code: 2 });
    expect(JSON.parse(cancelLogs.at(-1)!).cancellation).toBe("requested");
    const confirmed = runBuildCommand(cancel, cancelIo);
    releasePoll.resolve();
    expect((await confirmed).code).toBe(0);
    expect(JSON.parse(cancelLogs.at(-1)!).cancellation).toBe("revoked");
    expect((await running).code).toBe(2);
    releaseReply(validLateReply!);
    await new Promise<void>((done) => setImmediate(done));
    const binding = await originalGet.call(new BuildDiscussionLink(f.root), runId),
      state = await new FileBuildStore({ workspaceRoot: binding.workspaceRoot, projectKey: f.plan.projectKey }).load();
    expect(state.status).toBe("cancelled");
    expect(state.coordination.locks).toEqual([]);
    expect(state.publishReceipts).toEqual([]);
    expect(state.workspace?.staging.every((s) => s.files.length === 0)).toBe(true);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.allocatedOutputTokens).toBe(4096);
    expect(calls).toBe(1);
  } finally {
    releasePoll.resolve();
    await running;
    releaseReply?.(validLateReply!);
  }
}, 180000);

test("reservation freezes config and image before metadata exists, and direct retry survives the metadata-only boundary", async () => {
  const f = await fixture(),
    hostContext = await contextFor(f),
    link = new BuildDiscussionLink(f.root);
  const binding = await link.reserve(f.request, {
    approvedPlanHash: f.plan.planHash,
    sourceRoot: f.source,
    hostContext
  });
  const changedImage = [...f.argv];
  changedImage[changedImage.indexOf("--image") + 1] = `sha256:${"b".repeat(64)}`;
  expect((await runBuildCommand(changedImage, f.io)).code).toBe(1);
  expect(f.errors.at(-1)).toBe("BUILD_CONFIG_BINDING_CONFLICT");
  const original = await readFile(f.configPath, "utf8"),
    changed = JSON.parse(original);
  changed.members["member-a"].modelId = "different";
  await writeFile(f.configPath, JSON.stringify(changed));
  expect((await runBuildCommand(f.argv, f.io)).code).toBe(1);
  expect(f.errors.at(-1)).toBe("BUILD_CONFIG_BINDING_CONFLICT");
  await writeFile(f.configPath, original);
  const { contextVersion: _version, ...saved } = hostContext;
  void _version;
  const directory = join(f.root, "cli-records", binding.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.json"),
    JSON.stringify({
      ...saved,
      schemaVersion: 1,
      sessionId: binding.runId,
      revision: 0,
      requestHash: binding.requestHash,
      workspaceRoot: binding.workspaceRoot,
      sourceRoot: binding.sourceRoot
    })
  );
  await rm(f.envPath);
  const describe = vi.spyOn(DockerVerifier.prototype, "describe").mockRejectedValue(Error("RECOVERY_DOCKER_FORBIDDEN"));
  const env = new Proxy(
    {},
    {
      get() {
        throw Error("KEY_READ");
      },
      ownKeys() {
        throw Error("KEY_ENUM");
      }
    }
  );
  expect((await runBuildCommand(["retry", binding.runId, "--root", f.root, "--json"], f.io, { env })).code).toBe(2);
  const result = JSON.parse(f.logs.at(-1)!);
  expect(result.budget.calls).toBe(0);
  expect(result.acceptedVersion).toMatch(/^[a-f0-9]{40}$/);
  expect(describe).not.toHaveBeenCalled();
}, 120000);

// Regression: a terminal CLI replay must never re-enter Driver.stop/recover.
test.each(["retry", "cancel"])(
  "terminal %s replays cancelled authoritative bytes without another action",
  async (command) => {
    const f = await fixture();
    verifierCapability();
    const counter = { calls: 0 },
      transport = abortTransport(counter);
    expect((await runBuildCommand(f.argv, f.io, { transport, env: {} })).code).toBe(2);
    const runId = JSON.parse(f.logs.at(-1)!).runId;
    expect((await runBuildCommand(["cancel", runId, "--root", f.root, "--json"], f.io)).code).toBe(0);
    const binding = await new BuildDiscussionLink(f.root).get(runId);
    const snapshot = join(binding.workspaceRoot, ".cothink-build", "state", f.plan.projectKey, "session.json");
    const before = await readFile(snapshot, "utf8");
    expect(JSON.parse(before).status).toBe("cancelled");
    await rm(f.envPath);
    const env = new Proxy(
      {},
      {
        get() {
          throw Error("KEY_READ");
        },
        ownKeys() {
          throw Error("KEY_ENUM");
        }
      }
    );
    for (let replay = 0; replay < 2; replay++) {
      expect((await runBuildCommand([command, runId, "--root", f.root, "--json"], f.io, { transport, env })).code).toBe(
        command === "cancel" ? 0 : 2
      );
      expect(JSON.parse(f.logs.at(-1)!).status).toBe("cancelled");
      expect(await readFile(snapshot, "utf8")).toBe(before);
      expect(counter.calls).toBe(0);
    }
    expect(JSON.parse(await readFile(snapshot, "utf8")).publishReceipts).toEqual([]);
  },
  120000
);
