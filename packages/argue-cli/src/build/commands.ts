import { constants, watch } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BuildIdSchema,
  BuildVersionIdSchema,
  hashBuildValue,
  type BuildDriverEvent,
  type BuildModelProfile,
  type BuildResult,
  type BuildState,
  type ModelTransport
} from "@onevcat/argue";
import { parseBuildConfig } from "./config.js";
import {
  BuildDiscussionLink,
  createBuildIntegrationResult,
  parseBuildIntegrationRequest,
  validateBuildIntegrationRequest,
  type BuildIntegrationBinding
} from "./discussion-link.js";
import { FileBuildStore } from "./file-store.js";
import { GitSnapshots } from "./git-snapshots.js";
import { LocalBuildRuntime } from "./runtime.js";
import { exportAcceptedVersion } from "./recovery.js";
import { publicBuildResult, renderBuildResult, type PublicBuildResult } from "./render.js";
import { FileDiscussionStore } from "../discussion/file-store.js";
import { FileSnapshotStore } from "../storage/snapshot-store.js";
import { readPeerEnvironment, DEFAULT_PEER_ENV } from "../peer/local-config.js";
import { createApiModelTransport } from "../runtime/model-api.js";

type Io = Pick<Console, "log" | "error">;
export interface BuildCommandDependencies {
  env?: Record<string, string | undefined>;
  transport?: ModelTransport;
  now?: () => number;
  onEvent?: (event: BuildDriverEvent) => void | Promise<void>;
  /** Host-only test bound; the public CLI always waits up to two minutes. */
  cancelTimeoutMs?: number;
}
const imagePattern = /^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/;
const profileSchema = z
  .object({
    protocol: z.enum(["openai-compatible", "anthropic-compatible"]),
    baseUrl: z.string().url(),
    modelId: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    outputMode: z.enum(["json_object", "prompt_json"]),
    generationOptions: z.record(z.unknown())
  })
  .strict();
const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: BuildIdSchema,
    revision: z.literal(0),
    requestHash: z.string(),
    workspaceRoot: z.string(),
    sourceRoot: z.string(),
    configPath: z.string(),
    configHash: z.string(),
    requestPath: z.string().optional(),
    envPath: z.string().optional(),
    image: z.string().regex(imagePattern),
    repoRoot: z.string(),
    models: z.record(profileSchema)
  })
  .strict();
type Metadata = z.infer<typeof metadataSchema>;
const hostContextSchema = metadataSchema
  .omit({
    schemaVersion: true,
    sessionId: true,
    revision: true,
    requestHash: true,
    workspaceRoot: true,
    sourceRoot: true
  })
  .extend({ contextVersion: z.literal("build-cli-host-v1") })
  .strict();
function boundMetadata(binding: BuildIntegrationBinding): Metadata | undefined {
  if (!binding.hostContext) return undefined;
  const { contextVersion: _version, ...context } = hostContextSchema.parse(binding.hostContext);
  void _version;
  const validated = parseBuildConfig(
    { configVersion: 2, members: context.models },
    binding.request.frozenBuildPlan,
    {}
  );
  if (hashBuildValue(validated) !== hashBuildValue(context.models)) fail("BUILD_CONFIG_BINDING_CONFLICT");
  return metadataSchema.parse({
    ...context,
    schemaVersion: 1,
    sessionId: binding.runId,
    revision: 0,
    requestHash: binding.requestHash,
    workspaceRoot: binding.workspaceRoot,
    sourceRoot: binding.sourceRoot
  });
}
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const inside = (path: string, root: string) => {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
};
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const fail = (code: string): never => {
  throw Error(code);
};

/** Check aliases, links, and Git checkout ancestry before creating any managed directory. */
async function safePath(path: string, allowMissing = false, rejectGit = false): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fail("BUILD_PATH_INVALID");
  let cursor = path;
  while (true) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail("BUILD_PATH_UNSAFE");
      if ((await realpath(cursor)) !== cursor) fail("BUILD_PATH_ALIAS");
      const parent = dirname(cursor);
      if (parent !== cursor) {
        const names = (await readdir(parent)).filter(
          (name) => name.toLowerCase() === cursor.slice(parent.length + (parent === sep ? 0 : 1)).toLowerCase()
        );
        if (names.length !== 1 || join(parent, names[0]!) !== cursor) fail("BUILD_PATH_ALIAS");
      }
      if (rejectGit && stat.isDirectory()) {
        try {
          await lstat(join(cursor, ".git"));
          fail("BUILD_ROOT_GIT_CHECKOUT");
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (cursor.split(sep).some((part) => part.toLowerCase() === ".cothink-build"))
          fail("BUILD_ROOT_CONTROL_OVERLAP");
      }
    } catch (error) {
      if (!allowMissing || !missing(error)) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
async function readJson(path: string): Promise<unknown> {
  await safePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail("BUILD_FILE_UNSAFE");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
export async function resolveBuildDevelopmentRoot(): Promise<string> {
  for (let cursor = dirname(fileURLToPath(import.meta.url)); ; cursor = dirname(cursor)) {
    try {
      const metadata = await readJson(join(cursor, "package.json"));
      if (typeof metadata === "object" && metadata !== null && "private" in metadata && metadata.private === true) {
        await Promise.all([
          lstat(join(cursor, "scripts/check-build-sample.mjs")),
          lstat(join(cursor, "tools/build-validator/Dockerfile"))
        ]);
        return cursor;
      }
    } catch {
      /* bounded ancestor discovery, anchored to this module, never the candidate */
    }
    if (dirname(cursor) === cursor) break;
  }
  return fail("BUILD_DEVELOPMENT_CHECKOUT_REQUIRED");
}
function metadataStore(root: string) {
  return new FileSnapshotStore<Metadata>(join(root, "cli-records"), {
    formatName: "build cli",
    parse: (raw) => metadataSchema.parse(raw),
    sessionId: (s) => s.sessionId,
    revision: (s) => s.revision,
    validateTransition(next, old) {
      if (old && hashBuildValue(next) !== hashBuildValue(old)) fail("BUILD_CONFIG_BINDING_CONFLICT");
    }
  });
}
async function saveMetadata(root: string, value: Metadata): Promise<Metadata> {
  return metadataStore(root).withWriter(value.sessionId, async (writer) => {
    try {
      const old = await writer.load(value.sessionId);
      if (hashBuildValue(old) !== hashBuildValue(value)) fail("BUILD_CONFIG_BINDING_CONFLICT");
      return old;
    } catch (error) {
      if (!(error instanceof Error && error.message === `Build cli session does not exist: ${value.sessionId}`))
        throw error;
    }
    await writer.commit(-1, value);
    return value;
  });
}
async function loadMetadata(root: string, binding: BuildIntegrationBinding): Promise<Metadata> {
  const bound = boundMetadata(binding);
  let value: Metadata;
  try {
    value = await metadataStore(root).load(binding.runId);
  } catch (error) {
    if (
      bound &&
      (missing(error) ||
        (error instanceof Error && error.message === `Build cli session does not exist: ${binding.runId}`))
    )
      return bound;
    throw error;
  }
  if (
    value.requestHash !== binding.requestHash ||
    value.workspaceRoot !== binding.workspaceRoot ||
    value.sourceRoot !== binding.sourceRoot
  )
    fail("BUILD_BINDING_INVALID");
  if (bound && hashBuildValue(value) !== hashBuildValue(bound)) fail("BUILD_CONFIG_BINDING_CONFLICT");
  return value;
}
function storeFor(binding: BuildIntegrationBinding, now?: () => number) {
  return new FileBuildStore({
    workspaceRoot: binding.workspaceRoot,
    projectKey: binding.request.frozenBuildPlan.projectKey,
    clock: now
  });
}
async function stateFor(binding: BuildIntegrationBinding, now?: () => number): Promise<BuildState> {
  const state = await storeFor(binding, now).load();
  if (state.runId !== binding.runId || state.plan.planHash !== binding.planHash) fail("BUILD_BINDING_INVALID");
  return state;
}
/** Raw snapshots are wake hints only. The caller verifies authority with stateFor/project before success. */
function watchCancellation(binding: BuildIntegrationBinding, timeoutMs: number) {
  let finish!: (observed: boolean) => void,
    finished = false,
    reading = false,
    again = false;
  const promise = new Promise<boolean>((resolveWait) => {
    finish = (observed) => {
      if (finished) return;
      finished = true;
      resolveWait(observed);
    };
  });
  const path = join(
    binding.workspaceRoot,
    ".cothink-build",
    "state",
    binding.request.frozenBuildPlan.projectKey,
    "session.json"
  );
  const hint = () => {
    if (finished) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    void readJson(path)
      .then((raw) => {
        if (
          typeof raw === "object" &&
          raw !== null &&
          "runId" in raw &&
          raw.runId === binding.runId &&
          "status" in raw &&
          ["cancelled", "completed"].includes(String(raw.status))
        )
          finish(true);
      })
      .catch(() => {
        /* Corrupt or temporarily renamed bytes cannot acknowledge cancellation. */
      })
      .finally(() => {
        reading = false;
        if (again) {
          again = false;
          hint();
        }
      });
  };
  const watcher = watch(dirname(path), { persistent: false }, hint);
  watcher.on("error", () => finish(false));
  const timer = setTimeout(() => finish(false), timeoutMs);
  hint();
  return {
    promise,
    close() {
      finished = true;
      clearTimeout(timer);
      watcher.close();
    }
  };
}
async function sourceMatches(binding: {
  sourceRoot: string;
  request: BuildIntegrationBinding["request"];
}): Promise<void> {
  for (const entry of binding.request.frozenBuildPlan.manifest) {
    const path = join(binding.sourceRoot, entry.path);
    try {
      await safePath(path);
      const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await h.stat();
        if (!stat.isFile() || stat.nlink !== 1) fail("BUILD_SOURCE_UNSAFE");
        const bytes = await h.readFile();
        if (entry.contentHash !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`)
          fail("BUILD_SOURCE_HASH_MISMATCH");
      } finally {
        await h.close();
      }
    } catch (error) {
      if (missing(error) && entry.contentHash === null) continue;
      throw error;
    }
  }
}
async function project(binding: BuildIntegrationBinding, result?: BuildResult): Promise<PublicBuildResult> {
  const state = await stateFor(binding);
  const controlRoot = join(binding.workspaceRoot, ".cothink-build");
  const identity = await lstat(controlRoot);
  const git = new GitSnapshots(controlRoot, state.plan, async () => {
    const current = await lstat(controlRoot);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      fail("BUILD_CONTROL_REPLACED");
  });
  const baseVersion = state.publishReceipts[0]?.baseVersion ?? state.acceptedVersion;
  const [files, baseline] = await Promise.all([git.readFiles(state.acceptedVersion), git.readFiles(baseVersion)]);
  const output = publicBuildResult({
    state,
    result,
    requestId: binding.requestId,
    directory: binding.workspaceRoot,
    recoveryRequired: binding.recoveryRequired,
    files,
    baseline,
    baseVersion
  });
  if (state.status === "completed") output.integrationResult = createBuildIntegrationResult(binding, state);
  if (binding.request.origin) output.origin = binding.request.origin;
  return output;
}
const flags: Record<string, string[]> = {
  start: [
    "project",
    "request",
    "approve-plan",
    "config",
    "root",
    "image",
    "env-file",
    "json",
    "plan",
    "request-id",
    "discussion-root"
  ],
  show: ["root", "json"],
  retry: ["root", "json"],
  cancel: ["root", "json"],
  export: ["root", "json", "output", "version"]
};
function parse(argv: string[]) {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help")
    return { command: "help", values: new Map<string, string>(), json: false, id: undefined };
  if (!flags[command]) fail("BUILD_ARGUMENT_INVALID");
  const values = new Map<string, string>(),
    positionals: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!flags[command]!.includes(key) || values.has(key) || (key === "json" && json)) fail("BUILD_ARGUMENT_INVALID");
    if (key === "json") {
      json = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) return fail("BUILD_ARGUMENT_INVALID");
    values.set(key, value);
  }
  if (positionals.length !== (command === "start" ? 0 : 1)) fail("BUILD_ARGUMENT_INVALID");
  if (command !== "start") BuildIdSchema.parse(positionals[0]);
  if (!values.has("root")) fail("BUILD_ARGUMENT_INVALID");
  if (command === "start") {
    for (const key of ["project", "approve-plan", "config", "image"])
      if (!values.has(key)) fail("BUILD_ARGUMENT_INVALID");
    if (values.has("request") === values.has("plan") || values.has("plan") !== values.has("request-id"))
      fail("BUILD_ARGUMENT_INVALID");
    if (!imagePattern.test(values.get("image")!)) fail("BUILD_IMAGE_DIGEST");
  }
  if (command === "export" && !values.has("output")) fail("BUILD_ARGUMENT_INVALID");
  if (values.has("version")) BuildVersionIdSchema.parse(values.get("version"));
  return { command, values, json, id: positionals[0] };
}
const help =
  "cothink build start --project DIR (--request FILE | --plan FILE --request-id ID) --approve-plan HASH --config FILE --root ROOT --image SHA [--env-file FILE] [--json]\ncothink build show|retry|cancel RUN_ID --root ROOT [--json]\ncothink build export RUN_ID --root ROOT --output DIR [--version SHA] [--json]\nFirst retry recovers without model calls. The next explicit retry resumes within the frozen budget.";
const inertTransport: ModelTransport = {
  async respond() {
    return fail("BUILD_RECOVERY_MODEL_FORBIDDEN");
  }
};
function runtime(
  binding: BuildIntegrationBinding,
  metadata: Metadata,
  deps: BuildCommandDependencies,
  transport: ModelTransport
) {
  return new LocalBuildRuntime({
    workspaceRoot: binding.workspaceRoot,
    plan: binding.request.frozenBuildPlan,
    runId: binding.runId,
    sourceRoot: binding.sourceRoot,
    image: metadata.image,
    repoRoot: metadata.repoRoot,
    transport,
    models: metadata.models as Record<string, BuildModelProfile>,
    clock: deps.now,
    onEvent: deps.onEvent
  });
}
async function credentialTransport(metadata: Metadata, deps: BuildCommandDependencies): Promise<ModelTransport> {
  if (deps.transport) return deps.transport;
  const env = await readPeerEnvironment(metadata.envPath, deps.env ?? process.env);
  const names = Object.values(metadata.models).map((m) => m.apiKeyEnv);
  if (names.some((name) => !env[name]?.trim())) fail("BUILD_CREDENTIALS_REQUIRED");
  return createApiModelTransport(env, names);
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("BUILD_DOCKER_UNAVAILABLE")) return "BUILD_DOCKER_UNAVAILABLE";
  if (/^BUILD_[A-Z_]+$/.test(message)) return message;
  if (message.includes("writer") || message.includes("owner")) return "BUILD_BUSY_OR_OWNER_INVALID";
  return "BUILD_INPUT_OR_STATE_INVALID";
}
async function executeActive(
  link: BuildDiscussionLink,
  binding: BuildIntegrationBinding,
  host: LocalBuildRuntime,
  resume: boolean
): Promise<BuildResult> {
  const controller = new AbortController();
  let polling = false;
  const cancel = () => {
    // The existing driver's abort listener revokes through its own writer. If
    // import is still running, execute() checks this signal before any dispatch.
    controller.abort();
  };
  const interval = setInterval(() => {
    if (polling) return;
    polling = true;
    void link
      .get(binding.runId)
      .then((current) => {
        if (current.cancelRequested) cancel();
      })
      .catch(() => {
        cancel();
      })
      .finally(() => {
        polling = false;
      });
  }, 100);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if ((await link.get(binding.runId)).cancelRequested) {
      cancel();
    }
    const options = {
      signal: controller.signal,
      taskOrder: [
        ...["T-A", "T-B2", "T-B1"].filter((id) => binding.request.frozenBuildPlan.tasks.some((t) => t.taskId === id)),
        ...binding.request.frozenBuildPlan.tasks
          .map((t) => t.taskId)
          .filter((id) => !["T-A", "T-B2", "T-B1"].includes(id))
      ]
    };
    const result = resume ? await host.retry(options) : await host.run(options);
    return result;
  } finally {
    clearInterval(interval);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

export async function runBuildCommand(
  argv: string[],
  io: Io = console,
  deps: BuildCommandDependencies = {}
): Promise<{ ok: boolean; code: number }> {
  let binding: BuildIntegrationBinding | undefined, link: BuildDiscussionLink | undefined;
  const json = argv.includes("--json");
  const emit = (value: PublicBuildResult) => io.log(json ? JSON.stringify(value, null, 2) : renderBuildResult(value));
  try {
    const options = parse(argv),
      { command, values } = options;
    if (command === "help") {
      io.log(help);
      return { ok: true, code: 0 };
    }
    const root = resolve(values.get("root")!);
    await safePath(root, command === "start", true);
    link = new BuildDiscussionLink(root);
    if (command === "start") {
      const sourceRoot = resolve(values.get("project")!),
        configPath = resolve(values.get("config")!);
      await safePath(sourceRoot);
      await safePath(configPath);
      if (overlap(root, sourceRoot) || overlap(root, configPath)) fail("BUILD_ROOT_INPUT_OVERLAP");
      const requestPath = values.has("request") ? resolve(values.get("request")!) : undefined;
      const planPath = values.has("plan") ? resolve(values.get("plan")!) : undefined;
      const raw = requestPath
        ? await readJson(requestPath)
        : {
            integrationVersion: "build-integration-v1",
            requestId: values.get("request-id"),
            frozenBuildPlan: await readJson(planPath!),
            materialRefs: []
          };
      if (!requestPath) {
        const x = raw as {
          frozenBuildPlan: { manifest: { path: string; contentHash: string | null }[] };
          materialRefs: { path: string; contentHash: string | null }[];
        };
        x.materialRefs = x.frozenBuildPlan.manifest.map(({ path, contentHash }) => ({ path, contentHash }));
      }
      const request = parseBuildIntegrationRequest(raw);
      const loadDiscussion = (id: string) =>
        new FileDiscussionStore(resolve(values.get("discussion-root") ?? ".cothink/sessions")).load(id);
      await validateBuildIntegrationRequest(request, { approvedPlanHash: values.get("approve-plan")!, loadDiscussion });
      await sourceMatches({ sourceRoot, request });
      if ((requestPath && overlap(root, requestPath)) || (planPath && overlap(root, planPath)))
        fail("BUILD_ROOT_INPUT_OVERLAP");
      const repoRoot = await resolveBuildDevelopmentRoot();
      if (overlap(root, repoRoot)) fail("BUILD_ROOT_INPUT_OVERLAP");
      const rawConfig = await readJson(configPath);
      // Validate all structural fields before opening a credential file. Model-env resolution happens below.
      parseBuildConfig(rawConfig, request.frozenBuildPlan, new Proxy({}, { get: () => "preflight-model" }));
      // A repeated start replays the immutable binding without reopening credentials.
      let existing: BuildIntegrationBinding | undefined;
      try {
        existing = await link.get(`build-${hashBuildValue(request.requestId).slice(7, 55)}`);
      } catch (error) {
        if (
          !missing(error) &&
          !(
            error instanceof Error &&
            (error.message.includes("session does not exist") || error.message === "Unknown build run")
          )
        )
          throw error;
      }
      if (existing) {
        if (existing.requestHash !== hashBuildValue(request) || existing.sourceRoot !== sourceRoot)
          fail("BUILD_REQUEST_BINDING_CONFLICT");
      }
      let saved: Metadata | undefined;
      if (existing) {
        try {
          saved = await loadMetadata(root, existing);
        } catch (error) {
          if (
            !missing(error) &&
            !(error instanceof Error && error.message === `Build cli session does not exist: ${existing.runId}`)
          )
            throw error;
        }
      }
      if (existing && saved) {
        if (
          saved.configPath !== configPath ||
          saved.configHash !== hashBuildValue(rawConfig) ||
          saved.image !== values.get("image") ||
          (values.has("env-file") && saved.envPath !== resolve(values.get("env-file")!))
        )
          fail("BUILD_CONFIG_BINDING_CONFLICT");
        binding = existing;
        let state: BuildState | undefined;
        try {
          state = await stateFor(binding, deps.now);
        } catch (error) {
          if (!missing(error) && !(error instanceof Error && error.message.includes("session does not exist")))
            throw error;
        }
        if (!state) {
          io.log(
            JSON.stringify({
              status: "incomplete",
              runId: binding.runId,
              requestId: binding.requestId,
              recoveryRequired: binding.recoveryRequired,
              error: "BUILD_INITIALIZATION_RECOVERY",
              recovery: "Retry this reserved run explicitly; repeated start never redispatches."
            })
          );
          return { ok: false, code: 2 };
        }
        emit(await project(binding));
        return { ok: state.status === "completed", code: state.status === "completed" ? 0 : 2 };
      }
      let envPath = values.has("env-file") ? resolve(values.get("env-file")!) : undefined;
      if (!envPath) {
        try {
          await lstat(resolve(DEFAULT_PEER_ENV));
          envPath = resolve(DEFAULT_PEER_ENV);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (envPath) {
        await safePath(envPath);
        if (overlap(root, envPath)) fail("BUILD_ROOT_INPUT_OVERLAP");
      }
      const env = await readPeerEnvironment(envPath, deps.env ?? process.env);
      const models = parseBuildConfig(rawConfig, request.frozenBuildPlan, env);
      if (!deps.transport && Object.values(models).some((m) => !env[m.apiKeyEnv]?.trim()))
        fail("BUILD_CREDENTIALS_REQUIRED");
      const reserved = await link.reserve(request, {
        approvedPlanHash: values.get("approve-plan")!,
        sourceRoot,
        loadDiscussion,
        hostContext: hostContextSchema.parse({
          contextVersion: "build-cli-host-v1",
          configPath,
          configHash: hashBuildValue(rawConfig),
          ...(requestPath ? { requestPath } : {}),
          ...(envPath ? { envPath } : {}),
          image: values.get("image"),
          repoRoot,
          models
        })
      });
      binding = reserved;
      const metadata = await saveMetadata(root, boundMetadata(binding) ?? fail("BUILD_HOST_CONTEXT_REQUIRED"));
      let exists = false;
      try {
        await stateFor(binding, deps.now);
        exists = true;
      } catch (error) {
        if (!missing(error) && !(error instanceof Error && error.message.includes("session does not exist")))
          throw error;
      }
      if (exists) {
        const recovered = await runtime(binding, metadata, deps, inertTransport).recover();
        binding = await link.markRecovered(binding.runId);
        emit(await project(binding, recovered));
        return { ok: recovered.status === "completed", code: recovered.status === "completed" ? 0 : 2 };
      }
      if (!reserved.created) {
        io.log(
          JSON.stringify({
            status: "incomplete",
            runId: binding.runId,
            requestId: binding.requestId,
            recoveryRequired: true,
            error: "BUILD_INITIALIZATION_RECOVERY",
            recovery: "No model calls were made. Retry explicitly to initialize the reserved run."
          })
        );
        return { ok: false, code: 2 };
      }
      await mkdir(binding.workspaceRoot, { recursive: true, mode: 0o700 });
      binding = await link.markRecoveryRequired(binding.runId);
      const transport =
        deps.transport ??
        createApiModelTransport(
          env,
          Object.values(models).map((m) => m.apiKeyEnv)
        );
      const result = await executeActive(link, binding, runtime(binding, metadata, deps, transport), false);
      emit(await project(await link.get(binding.runId), result));
      return { ok: result.status === "completed", code: result.status === "completed" ? 0 : 2 };
    }
    binding = await link.get(options.id!);
    const metadata = await loadMetadata(root, binding);
    if (command === "show") {
      emit(await project(binding));
      return { ok: true, code: 0 };
    }
    if (command === "export") {
      const target = resolve(values.get("output")!);
      await safePath(target, true);
      if (
        [root, binding.sourceRoot, metadata.repoRoot, metadata.configPath, metadata.envPath, metadata.requestPath].some(
          (path) => path && overlap(target, path)
        )
      )
        fail("BUILD_EXPORT_PROTECTED_TARGET");
      const store = storeFor(binding, deps.now);
      let exported: { status: "exported"; version: string; directory: string } | undefined;
      await store.withWriter(async (writer) => {
        const state = await writer.load();
        if (state.runId !== binding!.runId || state.plan.planHash !== binding!.planHash) fail("BUILD_BINDING_INVALID");
        exported = await exportAcceptedVersion(writer, { version: values.get("version"), target });
      });
      const output = await project(binding);
      output.export = exported;
      emit(output);
      return { ok: true, code: 0 };
    }
    if (command === "cancel") {
      const state = await stateFor(binding, deps.now);
      if (state.status === "completed" || state.status === "cancelled") {
        // A writer acquisition advances ownership even when Driver.stop would be a no-op.
        const output = await project(binding);
        output.cancellationRequested = true;
        output.cancellation = state.status === "cancelled" ? "revoked" : "already_completed";
        emit(output);
        return { ok: true, code: 0 };
      }
      const requestedTimeout = deps.cancelTimeoutMs ?? 120000;
      const waiter = watchCancellation(
        binding,
        Number.isSafeInteger(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, 120000) : 120000
      );
      try {
        binding = await link.requestCancel(binding.runId);
        let result: BuildResult | undefined;
        try {
          result = await runtime(binding, metadata, deps, inertTransport).cancel();
        } catch (error) {
          if (errorCode(error) !== "BUILD_BUSY_OR_OWNER_INVALID") throw error;
        }
        await waiter.promise;
        const output = await project(binding, result);
        output.cancellationRequested = true;
        output.cancellation =
          output.status === "cancelled" ? "revoked" : output.status === "completed" ? "already_completed" : "requested";
        emit(output);
        const complete = output.cancellation !== "requested";
        return { ok: complete, code: complete ? 0 : 2 };
      } finally {
        waiter.close();
      }
    }
    const host = runtime(binding, metadata, deps, inertTransport);
    let state: BuildState | undefined;
    try {
      state = await stateFor(binding, deps.now);
    } catch (error) {
      if (!missing(error) && !(error instanceof Error && error.message.includes("session does not exist"))) throw error;
    }
    if (!state) {
      await sourceMatches(binding);
      await mkdir(binding.workspaceRoot, { recursive: true, mode: 0o700 });
      const result = await host.recover({ initialize: true });
      const shown = binding.cancelRequested ? await host.cancel() : result;
      binding = await link.markRecovered(binding.runId);
      emit(await project(binding, shown));
      return { ok: false, code: 2 };
    }
    if (state.status === "completed" || state.status === "cancelled") {
      if (binding.recoveryRequired) binding = await link.markRecovered(binding.runId);
      emit(await project(binding));
      return { ok: state.status === "completed", code: state.status === "completed" ? 0 : 2 };
    }
    if (binding.recoveryRequired) {
      const result = binding.cancelRequested ? await host.cancel() : await host.recover();
      binding = await link.markRecovered(binding.runId);
      emit(await project(binding, result));
      return { ok: result.status === "completed", code: result.status === "completed" ? 0 : 2 };
    }
    if (binding.cancelRequested) {
      const result = await host.cancel();
      emit(await project(binding, result));
      return { ok: false, code: 2 };
    }
    const resumed = runtime(binding, metadata, deps, await credentialTransport(metadata, deps));
    await resumed.recover();
    binding = await link.markRecoveryRequired(binding.runId);
    const result = await executeActive(link, binding, resumed, true);
    emit(await project(binding, result));
    return { ok: result.status === "completed", code: result.status === "completed" ? 0 : 2 };
  } catch (error) {
    const code = errorCode(error);
    io.error(code);
    if (binding && link) {
      try {
        const output = await project(await link.get(binding.runId));
        output.error = code;
        emit(output);
        return { ok: false, code: 2 };
      } catch {
        /* reservation may predate initial V0; never fabricate an accepted version */
      }
    }
    return { ok: false, code: 1 };
  }
}
