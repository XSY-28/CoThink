import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, delimiter, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { hashJson as hashBuildValue } from "@onevcat/argue/agent-sync/project";
export class DockerUnavailable extends Error {
  constructor(detail: string) {
    super(`BUILD_DOCKER_UNAVAILABLE: ${detail}`);
    this.name = "DockerUnavailable";
  }
}
export const digest = /^sha256:[a-f0-9]{64}$/;
export const imageReference = /^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]*@)?sha256:[a-f0-9]{64}$/;
const limit = 8 * 1024 * 1024;
const isolation = {
  mode: "docker-data-oracle-v1",
  network: "none",
  readOnly: true,
  user: "65532:65532",
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges"],
  pidMode: "",
  ipcMode: "private",
  pidsLimit: 64,
  memory: 536870912,
  cpus: "1",
  environment: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8"],
  tmpfs: {
    "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777",
    "/cache": "rw,noexec,nosuid,nodev,size=64m,mode=1777"
  },
  candidateDestination: "/candidate",
  oracle: "host-trusted-vitest-data-proxy",
  automaticPull: false
};
export type DockerMode = "docker-data-oracle-v1" | "agent-sync-docker-data-oracle-v1";
export type RuntimeInputs = Readonly<{ candidateRoot?: string; configRoot?: string }>;
export type FixedProgram = "describe" | "compile" | "worker";
export interface LocalDockerConnection {
  readonly mode: "local-unix-v1";
  readonly endpoint: string;
  readonly executable: string;
}
export interface LocalDockerOptions {
  dockerEndpoint?: string;
  dockerContext?: string;
}
// Export a frozen copy; callers cannot alter the policy used by actual execution.
export const legacyIsolation = Object.freeze({
  ...isolation,
  capDrop: Object.freeze([...isolation.capDrop]),
  securityOpt: Object.freeze([...isolation.securityOpt]),
  environment: Object.freeze([...isolation.environment]),
  tmpfs: Object.freeze({ ...isolation.tmpfs })
});
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function inputMounts(mode: DockerMode, inputs: RuntimeInputs): { source: string; target: string }[] {
  if (
    !["docker-data-oracle-v1", "agent-sync-docker-data-oracle-v1"].includes(mode) ||
    !inputs ||
    typeof inputs !== "object" ||
    Array.isArray(inputs) ||
    Object.keys(inputs).some((k) => k !== "candidateRoot" && k !== "configRoot")
  )
    throw new Error("BUILD_DOCKER_INPUTS");
  const { candidateRoot, configRoot } = inputs;
  if (
    mode === "docker-data-oracle-v1"
      ? configRoot !== undefined
      : (candidateRoot === undefined) !== (configRoot === undefined)
  )
    throw new Error("BUILD_DOCKER_INPUTS");
  const mounts = [
    ...(candidateRoot === undefined ? [] : [{ source: candidateRoot, target: "/candidate" }]),
    ...(configRoot === undefined ? [] : [{ source: configRoot, target: "/runtime-config" }])
  ];
  for (const { source } of mounts)
    if (
      typeof source !== "string" ||
      !isAbsolute(source) ||
      source === sep ||
      normalize(source) !== source ||
      source.includes(",") ||
      hasControlCharacters(source)
    )
      throw new Error("BUILD_DOCKER_INPUT_PATH");
  if (
    candidateRoot &&
    configRoot &&
    (candidateRoot === configRoot ||
      candidateRoot.startsWith(configRoot + sep) ||
      configRoot.startsWith(candidateRoot + sep))
  )
    throw new Error("BUILD_DOCKER_INPUT_OVERLAP");
  return mounts;
}
async function validateMaterializedRoots(mode: DockerMode, inputs: RuntimeInputs) {
  const mounts = inputMounts(mode, inputs);
  // Legacy materialization already enforces its frozen manifest. New inputs have no business manifest here.
  if (mode === "docker-data-oracle-v1") return;
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
      throw new Error("BUILD_DOCKER_INPUT_LINK_OR_SPECIAL");
    if (stat.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry));
  };
  for (const { source } of mounts) {
    if ((await realpath(source)) !== source || !(await lstat(source)).isDirectory())
      throw new Error("BUILD_DOCKER_INPUT_PATH");
    await walk(source);
  }
}
export function validateLocalDockerEndpoint(endpoint: string): string {
  if (typeof endpoint !== "string" || !/^unix:\/\/\/[^?#%\s]+$/.test(endpoint) || hasControlCharacters(endpoint))
    throw new Error("BUILD_DOCKER_ENDPOINT");
  const path = endpoint.slice("unix://".length);
  if (normalize(path) !== path || path === "/") throw new Error("BUILD_DOCKER_ENDPOINT");
  return endpoint;
}
/** Discover once using the trusted host HOME, before the oracle's private HOME is selected. */
export function resolveLocalDockerConnection(options: LocalDockerOptions = {}): LocalDockerConnection {
  if (
    Object.keys(options).some((k) => !["dockerEndpoint", "dockerContext"].includes(k)) ||
    (options.dockerEndpoint !== undefined && options.dockerContext !== undefined)
  )
    throw new Error("BUILD_DOCKER_CONNECTION");
  let executable: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const file = join(directory, "docker");
      accessSync(file, constants.X_OK);
      executable = realpathSync(file);
      break;
    } catch {
      /* continue trusted PATH search */
    }
  }
  if (!executable) throw new DockerUnavailable("docker executable unavailable");
  let endpoint = options.dockerEndpoint;
  if (endpoint === undefined) {
    if (options.dockerContext !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.dockerContext))
      throw new Error("BUILD_DOCKER_CONTEXT");
    const result = run(
      executable,
      ["context", "inspect", ...(options.dockerContext === undefined ? [] : [options.dockerContext])],
      5000,
      undefined,
      undefined,
      "SIGKILL"
    );
    if (result.error || result.status !== 0) throw new DockerUnavailable("context discovery failed");
    try {
      endpoint = JSON.parse(result.stdout)[0]?.Endpoints?.docker?.Host;
    } catch {
      throw new Error("BUILD_DOCKER_ENDPOINT");
    }
  }
  validateLocalDockerEndpoint(endpoint!);
  try {
    if (!lstatSync(endpoint!.slice(7)).isSocket()) throw new Error();
  } catch {
    throw new DockerUnavailable("local Docker socket unavailable");
  }
  return Object.freeze({ mode: "local-unix-v1", executable, endpoint: endpoint! });
}
export function run(
  command: string,
  args: string[],
  timeout: number,
  input?: string,
  env?: NodeJS.ProcessEnv,
  killSignal?: NodeJS.Signals
) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: limit,
    ...(killSignal ? { killSignal } : {}),
    input,
    env: env ?? { PATH: process.env.PATH, HOME: process.env.HOME }
  });
}
export function docker(args: string[], timeout: number, input?: string) {
  const result = run("docker", args, timeout, input);
  if (result.error || result.status !== 0)
    throw new DockerUnavailable(result.error?.message ?? `docker ${args[0]} exit ${result.status}`);
  return result.stdout;
}
/** Validate the actual daemon descriptor before any candidate code runs. */
export function validateDockerIsolation(value: unknown, image: string, candidateRoot?: string): void {
  validateRuntimeIsolation(value, image, "docker-data-oracle-v1", candidateRoot === undefined ? {} : { candidateRoot });
}
export function validateRuntimeIsolation(value: unknown, image: string, mode: DockerMode, inputs: RuntimeInputs): void {
  const expected = inputMounts(mode, inputs);
  const reject = () => {
    throw new Error("BUILD_DOCKER_ISOLATION");
  };
  if (!value || typeof value !== "object") return reject();
  const actual = value as {
    Image: string;
    Config: { User: string; Env: string[]; Entrypoint: string[]; Cmd: string[]; Volumes: unknown };
    HostConfig: {
      NetworkMode: string;
      ReadonlyRootfs: boolean;
      Privileged: boolean;
      CapAdd: unknown;
      CapDrop: string[];
      SecurityOpt: string[];
      PidMode: string;
      IpcMode: string;
      PidsLimit: number;
      Memory: number;
      NanoCpus: number;
      Tmpfs: Record<string, string>;
      Devices: unknown[];
      Binds: string[];
      Mounts?: {
        Type: string;
        Source: string;
        Target: string;
        ReadOnly: boolean;
        BindOptions?: unknown;
        VolumeOptions?: unknown;
        TmpfsOptions?: unknown;
      }[];
      VolumesFrom?: string[];
      DeviceRequests?: unknown[];
      DeviceCgroupRules?: string[];
      Links?: string[];
      ExtraHosts?: string[];
      PortBindings?: Record<string, unknown>;
      PublishAllPorts?: boolean;
      UTSMode?: string;
      UsernsMode?: string;
      CgroupnsMode?: string;
    };
    Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  };
  const host = actual.HostConfig;
  const config = actual.Config;
  if (
    !host ||
    !config ||
    actual.Image !== image ||
    config.User !== isolation.user ||
    host.NetworkMode !== "none" ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    (host.CapAdd?.toString() ?? "") !== "" ||
    host.CapDrop?.join() !== "ALL" ||
    host.SecurityOpt?.join() !== "no-new-privileges" ||
    host.PidMode !== "" ||
    host.IpcMode !== "private" ||
    host.PidsLimit !== isolation.pidsLimit ||
    host.Memory !== isolation.memory ||
    host.NanoCpus !== 1000000000 ||
    (host.Devices?.length ?? 0) !== 0 ||
    hashBuildValue(host.Tmpfs) !== hashBuildValue(isolation.tmpfs) ||
    !Array.isArray(config.Env) ||
    hashBuildValue([...config.Env].sort()) !== hashBuildValue([...isolation.environment].sort()) ||
    config.Entrypoint?.join() !== "node" ||
    config.Cmd?.join() !== "/opt/validator/supervisor.mjs" ||
    (config.Volumes && Object.keys(config.Volumes).length)
  )
    return reject();
  if (
    (host.Binds?.length ?? 0) !== 0 ||
    (host.VolumesFrom?.length ?? 0) !== 0 ||
    (host.DeviceRequests?.length ?? 0) !== 0 ||
    (host.DeviceCgroupRules?.length ?? 0) !== 0 ||
    (host.Links?.length ?? 0) !== 0 ||
    (host.ExtraHosts?.length ?? 0) !== 0 ||
    Object.keys(host.PortBindings ?? {}).length !== 0 ||
    host.PublishAllPorts ||
    (host.UTSMode ?? "") !== "" ||
    (host.UsernsMode ?? "") !== "" ||
    (host.CgroupnsMode !== undefined && host.CgroupnsMode !== "private")
  )
    return reject();
  // --mount is represented in HostConfig.Mounts, while the daemon's effective mounts are below.
  // Older synthetic legacy descriptors omit this layer. New mounted execution requires both layers.
  if (mode === "agent-sync-docker-data-oracle-v1" && expected.length && !Array.isArray(host.Mounts)) return reject();
  if (
    host.Mounts != null &&
    (!Array.isArray(host.Mounts) ||
      host.Mounts.length !== expected.length ||
      expected.some(
        (e) =>
          host.Mounts!.filter(
            (m) =>
              m.Type === "bind" &&
              m.Source === e.source &&
              m.Target === e.target &&
              m.ReadOnly === true &&
              Object.keys(m).every((k) => ["Type", "Source", "Target", "ReadOnly"].includes(k)) &&
              !m.BindOptions &&
              !m.VolumeOptions &&
              !m.TmpfsOptions
          ).length !== 1
      ))
  )
    return reject();
  const mounts = actual.Mounts?.filter((m) => m.Type !== "tmpfs");
  if (actual.Mounts?.some((m) => m.Type === "tmpfs" && !Object.keys(isolation.tmpfs).includes(m.Destination)))
    return reject();
  if (
    !Array.isArray(mounts) ||
    mounts.length !== expected.length ||
    expected.some(
      (e) =>
        mounts.filter((m) => m.Type === "bind" && m.Source === e.source && m.Destination === e.target && m.RW === false)
          .length !== 1
    )
  )
    return reject();
}

export class DockerRuntime {
  readonly mode: DockerMode;
  private readonly environment?: Readonly<NodeJS.ProcessEnv>;
  private readonly connection?: LocalDockerConnection;
  constructor(
    private readonly timeout = 120000,
    local?: { connection: LocalDockerConnection; home: string }
  ) {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("BUILD_CHECK_TIMEOUT");
    this.mode = local ? "agent-sync-docker-data-oracle-v1" : "docker-data-oracle-v1";
    if (local) {
      validateLocalDockerEndpoint(local.connection.endpoint);
      if (
        local.connection.mode !== "local-unix-v1" ||
        !isAbsolute(local.connection.executable) ||
        !isAbsolute(local.home) ||
        realpathSync(local.home) !== local.home ||
        !lstatSync(local.home).isDirectory()
      )
        throw new Error("BUILD_DOCKER_CONNECTION");
      this.connection = Object.freeze({ ...local.connection });
      this.environment = Object.freeze({ PATH: process.env.PATH, HOME: local.home, LANG: "C.UTF-8" });
    }
  }
  private remaining(deadline?: number): number {
    if (deadline === undefined) return this.timeout;
    if (!Number.isFinite(deadline)) throw new Error("BUILD_DOCKER_DEADLINE");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error("BUILD_DOCKER_DEADLINE");
    return Math.min(remaining, this.timeout);
  }
  private execute(args: string[], deadline?: number, input?: string, cleanup = false) {
    const timeout = cleanup && this.connection ? Math.min(this.timeout, 5000) : this.remaining(deadline);
    return run(
      this.connection?.executable ?? "docker",
      this.connection ? ["--host", this.connection.endpoint, ...args] : args,
      timeout,
      input,
      this.environment,
      this.connection ? "SIGKILL" : undefined
    );
  }
  private command(args: string[], deadline?: number, input?: string, cleanup = false): string {
    const result = this.execute(args, deadline, input, cleanup);
    if (result.error || result.status !== 0)
      throw new DockerUnavailable(result.error?.message ?? `docker ${args[0]} exit ${result.status}`);
    return result.stdout;
  }
  inspectImage(reference: string, deadline?: number): Readonly<{ Id: string; RepoDigests?: readonly string[] }> {
    if (!imageReference.test(reference)) throw new Error("BUILD_IMAGE_DIGEST");
    const image = JSON.parse(this.command(["image", "inspect", reference], deadline))[0];
    if (!digest.test(image?.Id ?? "")) throw new DockerUnavailable("image has no immutable ID");
    if (
      reference.startsWith("sha256:")
        ? reference !== image.Id
        : !Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(reference)
    )
      throw new Error("BUILD_IMAGE_DIGEST_MISMATCH");
    return Object.freeze({
      Id: image.Id,
      ...(image.RepoDigests ? { RepoDigests: Object.freeze([...image.RepoDigests]) } : {})
    });
  }
  createArgs(image: string, input?: string | RuntimeInputs): string[] {
    if (!digest.test(image)) throw new Error("BUILD_IMAGE_DIGEST");
    const inputs = typeof input === "string" ? { candidateRoot: input } : (input ?? {});
    const mounts = inputMounts(this.mode, inputs);
    return [
      "create",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65532:65532",
      "--ipc=private",
      "--pids-limit=64",
      "--memory=512m",
      "--cpus=1",
      ...Object.entries(isolation.tmpfs).flatMap(([path, flags]) => ["--tmpfs", `${path}:${flags}`]),
      ...isolation.environment.flatMap((entry) => ["--env", entry]),
      ...mounts.flatMap((m) => ["--mount", `type=bind,source=${m.source},destination=${m.target},readonly`]),
      "--entrypoint=node",
      image,
      "/opt/validator/supervisor.mjs"
    ];
  }
  /** Host-only fixed invocation; suitable for capture in the private generated bridge. */
  invocation(id: string, program: FixedProgram, deadline?: number) {
    if (!/^[a-f0-9]{64}$/.test(id) || !["describe", "compile", "worker"].includes(program))
      throw new Error("BUILD_DOCKER_PROGRAM");
    const args = ["exec", ...(program === "worker" ? ["-i"] : []), id, "node", `/opt/validator/${program}.mjs`];
    return Object.freeze({
      command: this.connection?.executable ?? "docker",
      args: Object.freeze(this.connection ? ["--host", this.connection.endpoint, ...args] : args),
      env: Object.freeze({ ...(this.environment ?? { PATH: process.env.PATH, HOME: process.env.HOME }) }),
      timeout: this.remaining(deadline),
      maxBuffer: limit,
      killSignal: this.connection ? ("SIGKILL" as const) : ("SIGTERM" as const)
    });
  }
  runFixed(id: string, program: FixedProgram, input?: string, deadline?: number) {
    if (input !== undefined && (program !== "worker" || Buffer.byteLength(input) > limit))
      throw new Error("BUILD_DOCKER_INPUT");
    const invocation = this.invocation(id, program, deadline);
    return run(
      invocation.command,
      [...invocation.args],
      invocation.timeout,
      input,
      invocation.env,
      this.connection ? invocation.killSignal : undefined
    );
  }
  policyHash(image: string): string {
    if (!digest.test(image)) throw new Error("BUILD_IMAGE_DIGEST");
    return hashBuildValue(
      this.mode === "docker-data-oracle-v1"
        ? { ...isolation, imageDigest: image }
        : {
            ...isolation,
            mode: this.mode,
            imageDigest: image,
            oracle: "host-trusted-data-proxy",
            configDestination: "/runtime-config",
            bindPolicy: "exact-disjoint-readonly",
            connectionMode: "local-unix-v1",
            entrypoint: ["node"],
            command: ["/opt/validator/supervisor.mjs"],
            privileged: false,
            capAdd: [],
            devices: [],
            volumes: [],
            extraMounts: false,
            candidateReadOnly: true,
            configReadOnly: true
          }
    );
  }
  argumentMetadata() {
    // Portable evidence normalizes ephemeral host paths; private invocation captures their exact values.
    return {
      mode: this.mode,
      connectionMode: this.connection?.mode ?? "legacy-home-v1",
      executable: this.connection ? "DOCKER_EXECUTABLE" : "docker",
      prefix: this.connection ? ["--host", "LOCAL_UNIX_ENDPOINT"] : [],
      create: this.createArgs(
        `sha256:${"0".repeat(64)}`,
        this.connection ? { candidateRoot: "/CANDIDATE_ROOT", configRoot: "/CONFIG_ROOT" } : "/CANDIDATE_ROOT"
      ),
      describeCreate: this.createArgs(`sha256:${"0".repeat(64)}`),
      name: this.connection ? ["--name", "SESSION_CONTAINER_NAME"] : [],
      lifecycle: [
        ["image", "inspect", "IMAGE_REFERENCE"],
        ["inspect", "CONTAINER_ID"],
        ["start", "CONTAINER_ID"],
        ["inspect", "CONTAINER_ID"],
        ["rm", "-f", this.connection ? "SESSION_CONTAINER_NAME" : "CONTAINER_ID"]
      ],
      programs: {
        describe: ["exec", "CONTAINER_ID", "node", "/opt/validator/describe.mjs"],
        compile: ["exec", "CONTAINER_ID", "node", "/opt/validator/compile.mjs"],
        worker: ["exec", "-i", "CONTAINER_ID", "node", "/opt/validator/worker.mjs"]
      },
      environment: this.connection
        ? { PATH: "TRUSTED_PATH", HOME: "PRIVATE_HOME", LANG: "C.UTF-8" }
        : { PATH: "HOST_PATH", HOME: "HOST_HOME" },
      timeoutMs: this.timeout,
      maxBuffer: limit,
      killSignal: this.connection ? "SIGKILL" : "SIGTERM",
      cleanupTimeoutMs: this.connection ? Math.min(this.timeout, 5000) : this.timeout
    };
  }
  async withContainer<T>(
    image: string,
    input: string | RuntimeInputs | undefined,
    fn: (id: string, actual: unknown) => Promise<T>,
    deadline?: number
  ): Promise<T> {
    const inputs = typeof input === "string" ? { candidateRoot: input } : { ...input };
    await validateMaterializedRoots(this.mode, inputs);
    const args = this.createArgs(image, inputs);
    // A known cleanup target also covers create timeout/malformed stdout in new mode.
    const name = this.connection ? `cothink-check-${randomUUID()}` : undefined;
    if (name) args.splice(1, 0, "--name", name);
    let id: string | undefined;
    let attempted = false;
    let result: T;
    try {
      this.remaining(deadline);
      attempted = true;
      id = this.command(args, deadline).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("BUILD_DOCKER_CONTAINER_ID");
      const actual = JSON.parse(this.command(["inspect", id], deadline))[0];
      validateRuntimeIsolation(actual, image, this.mode, inputs);
      this.command(["start", id], deadline);
      result = await fn(id, actual);
      validateRuntimeIsolation(JSON.parse(this.command(["inspect", id], deadline))[0], image, this.mode, inputs);
    } finally {
      // Cleanup is mandatory even when the execution deadline expires; bounded cleanup gets no evidence credit.
      const target = name ?? (id && /^[a-f0-9]{64}$/.test(id) ? id : undefined);
      if (attempted && target) this.command(["rm", "-f", target], undefined, undefined, true);
    }
    this.remaining(deadline);
    return result;
  }
}
