import { expect, test } from "vitest";
import { validateDockerIsolation } from "../../src/build/validator.js";

const image = `sha256:${"a".repeat(64)}`;
function descriptor() {
  return {
    Image: image,
    Config: {
      User: "65532:65532",
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8"],
      Entrypoint: ["node"],
      Cmd: ["/opt/validator/supervisor.mjs"],
      Volumes: null
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidMode: "",
      IpcMode: "private",
      PidsLimit: 64,
      Memory: 536870912,
      NanoCpus: 1000000000,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "/cache": "rw,noexec,nosuid,nodev,size=64m,mode=1777"
      },
      Devices: [],
      Binds: [] as string[],
      Mounts: undefined as { Type: string; Source: string; Target: string; ReadOnly: boolean }[] | undefined
    },
    Mounts: [] as { Type: string; Source: string; Destination: string; RW: boolean }[]
  };
}
test("rejects hidden HostConfig bind requests even if resolved Mounts is empty", () => {
  const actual = descriptor();
  actual.HostConfig.Binds = ["/private:/secret:rw"];
  expect(() => validateDockerIsolation(actual, image)).toThrow("BUILD_DOCKER_ISOLATION");
});

import * as shared from "../../src/agent-sync/kernel/docker-runtime.js";
const mode = "agent-sync-docker-data-oracle-v1" as const;
const inputs = { candidateRoot: "/private/tmp/candidate", configRoot: "/private/tmp/config" };
function twoMounts() {
  const actual = descriptor();
  actual.Mounts = [
    { Type: "bind", Source: inputs.candidateRoot, Destination: "/candidate", RW: false },
    { Type: "bind", Source: inputs.configRoot, Destination: "/runtime-config", RW: false }
  ];
  actual.HostConfig.Mounts = actual.Mounts.map((m) => ({
    Type: m.Type,
    Source: m.Source,
    Target: m.Destination,
    ReadOnly: !m.RW
  }));
  return actual;
}
test("new mode accepts exactly both readonly roots and rejects missing, writable or unrequested mounts", () => {
  expect(() => shared.validateRuntimeIsolation(twoMounts(), image, mode, inputs)).not.toThrow();
  for (const change of [
    (v: ReturnType<typeof twoMounts>) => {
      v.Mounts.pop();
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.Mounts[1]!.RW = true;
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.Mounts[1]!.Source += "-different";
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.Mounts[1]!.Destination = "/secret";
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.Mounts.push({ Type: "volume", Source: "x", Destination: "/extra", RW: true });
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.HostConfig.Binds = ["/secret:/extra:ro"];
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.Config.Env.push("NODE_OPTIONS=--require=evil");
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.Config.Entrypoint = ["sh"];
    },
    (v: ReturnType<typeof twoMounts>) => {
      v.HostConfig.PidsLimit = 0;
    }
  ]) {
    const actual = twoMounts();
    change(actual);
    expect(() => shared.validateRuntimeIsolation(actual, image, mode, inputs)).toThrow();
  }
  expect(() => shared.validateRuntimeIsolation(descriptor(), image, mode, {})).not.toThrow();
  expect(() => validateDockerIsolation(twoMounts(), image, inputs.candidateRoot)).toThrow();
});
test("mount request semantics cannot hide a writable or extra request behind readonly resolved mounts", () => {
  const actual = twoMounts();
  const requests = [
    { Type: "bind", Source: inputs.candidateRoot, Target: "/candidate", ReadOnly: true },
    { Type: "bind", Source: inputs.configRoot, Target: "/runtime-config", ReadOnly: true }
  ];
  Object.assign(actual.HostConfig, { Mounts: requests });
  expect(() => shared.validateRuntimeIsolation(actual, image, mode, inputs)).not.toThrow();
  requests[1]!.ReadOnly = false;
  expect(() => shared.validateRuntimeIsolation(actual, image, mode, inputs)).toThrow();
});
test("endpoint parsing only accepts local absolute Unix socket URIs", () => {
  expect(shared.validateLocalDockerEndpoint("unix:///private/tmp/docker.sock")).toBe("unix:///private/tmp/docker.sock");
  for (const endpoint of [
    "tcp://localhost:2375",
    "ssh://localhost",
    "unix://relative",
    "unix:///tmp/a?x",
    "unix:///tmp/a#x",
    "unix:///tmp/a\n",
    "unix:///tmp/../socket",
    "unix:///tmp/a%2fb",
    "unix://user@/tmp/socket"
  ])
    expect(() => shared.validateLocalDockerEndpoint(endpoint)).toThrow();
});

import { afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProjectDockerRuntime } from "../../src/agent-sync/project/runtime.js";
vi.mock("node:child_process", { spy: true });
afterEach(() => vi.mocked(spawnSync).mockRestore());

function fakeLifecycle(fault: "none" | "cleanup" | "post" | "start" = "none") {
  const commands: string[][] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  let inspected = 0;
  vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
    const argv = args as string[];
    commands.push(argv);
    environments.push(options?.env ?? {});
    const op = argv[0] === "--host" ? argv[2] : argv[0];
    let stdout = "";
    let status = 0;
    if (op === "image") stdout = JSON.stringify([{ Id: image }]);
    if (op === "create") stdout = "b".repeat(64);
    if (op === "inspect") {
      inspected++;
      const actual = descriptor();
      if (fault === "post" && inspected === 2) actual.Config.Env.push("SECRET=bad");
      stdout = JSON.stringify([actual]);
    }
    if ((fault === "cleanup" && op === "rm") || (fault === "start" && op === "start")) status = 1;
    return { status, stdout, stderr: "", signal: null, pid: 0, output: [] };
  });
  return { commands, environments };
}
const endpoint = "unix:///private/tmp/docker.sock";
test("cleanup and post-inspection failures cannot release a callback success", async () => {
  const runtime = new shared.DockerRuntime(2000);
  for (const fault of ["cleanup", "post", "start"] as const) {
    const trace = fakeLifecycle(fault);
    await expect(runtime.withContainer(image, undefined, async () => "passed")).rejects.toThrow();
    expect(trace.commands.at(-1)?.[0]).toBe("rm");
  }
});
test("fixed program input cannot select a shell, extra flags, non-worker stdin or a forged container ID", () => {
  const runtime = new shared.DockerRuntime(1000);
  for (const program of ["sh", "node -e", "worker.mjs", "compile --privileged"])
    expect(() => runtime.runFixed("b".repeat(64), program as never)).toThrow("BUILD_DOCKER_PROGRAM");
  expect(() => runtime.runFixed("--privileged", "worker")).toThrow();
  expect(() => runtime.runFixed("b".repeat(64), "compile", "arbitrary source")).toThrow();
});
test("new lifecycle keeps explicit endpoint and private minimal environment and cleans up after expired deadline", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cothink-runtime-home-")));
  try {
    const runtime = new shared.DockerRuntime(1000, {
      connection: { mode: "local-unix-v1", endpoint, executable: "/usr/local/bin/docker" },
      home
    });
    const trace = fakeLifecycle();
    const deadline = performance.now() + 40;
    await expect(
      runtime.withContainer(
        image,
        {},
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return "must not escape";
        },
        deadline
      )
    ).rejects.toThrow("BUILD_DOCKER_DEADLINE");
    expect(trace.commands.every((a) => a[0] === "--host" && a[1] === endpoint)).toBe(true);
    expect(trace.commands.at(-1)?.slice(2, 4)).toEqual(["rm", "-f"]);
    expect(trace.environments.every((e) => Object.keys(e).sort().join() === "HOME,LANG,PATH" && e.HOME === home)).toBe(
      true
    );
    expect(runtime.invocation("b".repeat(64), "worker").args.slice(0, 5)).toEqual([
      "--host",
      endpoint,
      "exec",
      "-i",
      "b".repeat(64)
    ]);
    const metadata = runtime.argumentMetadata();
    expect(JSON.stringify(metadata)).not.toContain(home);
    expect(JSON.stringify(metadata)).not.toContain(endpoint);
    expect(runtime.policyHash(image)).not.toBe(new shared.DockerRuntime().policyHash(image));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("materialized roots reject mount injection, overlap, symlinks, hardlinks, and unknown input keys before Docker create", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-mount-inputs-")));
  const candidateRoot = join(root, "candidate"),
    configRoot = join(root, "config");
  await mkdir(candidateRoot);
  await mkdir(configRoot);
  const runtime = new shared.DockerRuntime(1000, {
    connection: { mode: "local-unix-v1", endpoint, executable: "/usr/local/bin/docker" },
    home: root
  });
  try {
    const trace = fakeLifecycle();
    for (const bad of [
      { candidateRoot },
      { configRoot },
      { candidateRoot, configRoot: candidateRoot },
      { candidateRoot, configRoot: join(candidateRoot, "nested") },
      { candidateRoot: candidateRoot + ",readonly=false", configRoot },
      { candidateRoot, configRoot, flags: ["--privileged"] }
    ])
      await expect(runtime.withContainer(image, bad, async () => true)).rejects.toThrow();
    await symlink(configRoot, join(root, "alias"));
    await expect(
      runtime.withContainer(image, { candidateRoot, configRoot: join(root, "alias") }, async () => true)
    ).rejects.toThrow();
    await writeFile(join(candidateRoot, "file"), "data");
    await link(join(candidateRoot, "file"), join(configRoot, "hardlink"));
    await expect(runtime.withContainer(image, { candidateRoot, configRoot }, async () => true)).rejects.toThrow(
      "BUILD_DOCKER_INPUT_LINK_OR_SPECIAL"
    );
    expect(trace.commands).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("new public runtime rejects ambiguous or remote connections and does not accept arbitrary options", () => {
  for (const options of [
    { dockerEndpoint: "tcp://127.0.0.1:2375" },
    { dockerEndpoint: endpoint, dockerContext: "desktop-linux" },
    { dockerContext: "--host=remote" },
    { command: "sh" }
  ])
    expect(() => new ProjectDockerRuntime({ ...options, home: tmpdir() } as never)).toThrow();
});

test("new mounted execution requires the daemon mount request layer as well as effective mounts", () => {
  const actual = twoMounts();
  actual.HostConfig.Mounts = undefined;
  expect(() => shared.validateRuntimeIsolation(actual, image, mode, inputs)).toThrow();
});

test("new subprocess deadlines use an unignorable kill signal", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cothink-deadline-signal-")));
  try {
    const runtime = new shared.DockerRuntime(100, {
      connection: { mode: "local-unix-v1", endpoint, executable: "/usr/local/bin/docker" },
      home
    });
    expect(runtime.invocation("b".repeat(64), "worker").killSignal).toBe("SIGKILL");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("new cleanup failure and malformed create output both suppress success and target the reserved name", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cothink-cleanup-fault-")));
  try {
    const runtime = new shared.DockerRuntime(1000, {
      connection: { mode: "local-unix-v1", endpoint, executable: "/usr/local/bin/docker" },
      home
    });
    const trace = fakeLifecycle("cleanup");
    await expect(runtime.withContainer(image, {}, async () => "passed")).rejects.toThrow();
    expect(trace.commands.at(-1)?.slice(2, 4)).toEqual(["rm", "-f"]);
    expect(trace.commands.at(-1)?.[4]).toMatch(/^cothink-check-/);
    const malformed = fakeLifecycle();
    vi.mocked(spawnSync).mockImplementationOnce(() => ({
      status: 0,
      stdout: "not-a-container-id",
      stderr: "",
      signal: null,
      pid: 0,
      output: []
    }));
    await expect(runtime.withContainer(image, {}, async () => "passed")).rejects.toThrow("BUILD_DOCKER_CONTAINER_ID");
    expect(malformed.commands.at(-1)?.[4]).toMatch(/^cothink-check-/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cleanup argument evidence matches the captured operand for each lifecycle mode", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cothink-cleanup-metadata-")));
  try {
    for (const local of [false, true]) {
      const runtime = new shared.DockerRuntime(
        1000,
        local
          ? {
              connection: { mode: "local-unix-v1", endpoint, executable: "/usr/local/bin/docker" },
              home
            }
          : undefined
      );
      const trace = fakeLifecycle();
      await runtime.withContainer(image, {}, async () => "passed");
      const create = trace.commands.find((args) => args.includes("create"))!;
      const name = local ? create[create.indexOf("--name") + 1]! : "unused";
      const normalized = runtime
        .argumentMetadata()
        .lifecycle.at(-1)!
        .map((argument) =>
          argument === "CONTAINER_ID" ? "b".repeat(64) : argument === "SESSION_CONTAINER_NAME" ? name : argument
        );
      expect(trace.commands.at(-1)?.slice(local ? 2 : 0)).toEqual(normalized);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
