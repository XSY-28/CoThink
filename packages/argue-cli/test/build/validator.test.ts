import { describe, expect, test } from "vitest";
import { decodeDockerData, DockerVerifier } from "../../src/build/validator.js";
import type { FileBuildWriter } from "../../src/build/file-store.js";
// No writer operations are expected: these inputs must reject before candidate IO.
const writer = {} as FileBuildWriter;
describe("Docker adapter trusted input/data boundaries (unit, not isolation evidence)", () => {
  test("refuses mutable image names before any candidate IO", () => {
    for (const image of ["node:latest", "node:22", "", "sha256:123"])
      expect(() => new DockerVerifier(writer, { image })).toThrow("BUILD_IMAGE_DIGEST");
  });
  test("candidate stdout cannot supply a passed receipt or wrong result type", () => {
    for (const raw of [
      "all tests passed",
      '{"passed":true,"exitCode":0}',
      '[]\n{"passed":true}',
      '{"ok":true,"value":"all tests passed"}'
    ])
      expect(() => decodeDockerData("normalize", raw)).toThrow();
    expect(() => decodeDockerData("report", '{"ok":true,"value":[]}')).toThrow();
  });
  test("accepts normalizer/report/CLI data without accepting receipt fields", () => {
    expect(decodeDockerData("normalize", '{"ok":true,"value":[{"id":1,"title":"甲","state":"pending"}]}')).toEqual([
      { id: 1, title: "甲", state: "pending" }
    ]);
    expect(decodeDockerData("report", '{"ok":true,"value":"total: 0\\n"}')).toBe("total: 0\n");
    expect(decodeDockerData("cli", '{"ok":true,"value":{"status":1,"stdout":"","stderr":"E_JSON\\n"}}')).toEqual({
      status: 1,
      stdout: "",
      stderr: "E_JSON\n"
    });
    expect(() => decodeDockerData("normalize", '{"ok":true,"value":[],"passed":true}')).toThrow();
  });
});

import { validateDockerIsolation, DockerUnavailable, hashVerificationSource } from "../../src/build/validator.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { hashBuildValue, type BuildCheckReceipt } from "@onevcat/argue";
import { afterEach, vi } from "vitest";
vi.mock("node:child_process", { spy: true });
afterEach(() => vi.mocked(spawnSync).mockRestore());
const image = `sha256:${"a".repeat(64)}`;
function descriptor(source?: string) {
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
      Binds: []
    },
    Mounts: source ? [{ Type: "bind", Source: source, Destination: "/candidate", RW: false }] : []
  };
}
test("rejects actual daemon configuration deviations before candidate execution", () => {
  const base = descriptor("/private/tmp/candidate");
  expect(() => validateDockerIsolation(base, image, "/private/tmp/candidate")).not.toThrow();
  for (const mutate of [
    (v: typeof base) => {
      v.HostConfig.NetworkMode = "host";
    },
    (v: typeof base) => {
      v.HostConfig.ReadonlyRootfs = false;
    },
    (v: typeof base) => {
      v.HostConfig.Privileged = true;
    },
    (v: typeof base) => {
      v.Config.User = "0";
    },
    (v: typeof base) => {
      v.Config.Env.push("OPENAI_API_KEY=forbidden");
    },
    (v: typeof base) => {
      v.HostConfig.PidMode = "host";
    },
    (v: typeof base) => {
      v.HostConfig.SecurityOpt = [];
    },
    (v: typeof base) => {
      v.Mounts[0]!.RW = true;
    },
    (v: typeof base) => {
      v.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/socket", RW: true });
    },
    (v: typeof base) => {
      v.Image = `sha256:${"b".repeat(64)}`;
    }
  ]) {
    const altered = structuredClone(base);
    mutate(altered);
    expect(() => validateDockerIsolation(altered, image, "/private/tmp/candidate")).toThrow("BUILD_DOCKER_ISOLATION");
  }
});
test("actual Docker environment order is immaterial; extra, duplicate and changed entries still reject", () => {
  const reordered = descriptor();
  reordered.Config.Env.reverse();
  expect(() => validateDockerIsolation(reordered, image)).not.toThrow();
  for (const env of [
    [...descriptor().Config.Env, "HOME=/tmp"],
    [...descriptor().Config.Env, "OPENAI_API_KEY=forbidden"],
    ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/other", "LANG=C.UTF-8"],
    ["HOME=/tmp", "HOME=/tmp", "LANG=C.UTF-8"]
  ]) {
    const changed = descriptor();
    changed.Config.Env = env;
    expect(() => validateDockerIsolation(changed, image)).toThrow("BUILD_DOCKER_ISOLATION");
  }
});
test("daemon/image absence never produces a receipt or invokes host fallback", async () => {
  vi.mocked(spawnSync).mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "daemon unavailable",
    signal: null,
    pid: 0,
    output: []
  });
  const verifier = new DockerVerifier(writer, { image, repoRoot: resolve("../..") });
  await expect(verifier.describe(["common"])).rejects.toBeInstanceOf(DockerUnavailable);
  expect(verifier.ownsReceipt({ passed: true } as BuildCheckReceipt)).toBe(false);
  expect(vi.mocked(spawnSync).mock.calls.every(([command]) => command === "docker")).toBe(true);
});
const hash = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function fakeToolchain() {
  const repo = resolve("../..");
  const files: Record<string, string> = {};
  for (const [internal, host] of [
    ["/opt/toolchain/package-lock.json", "package-lock.json"],
    ["/opt/validator/tsconfig.json", "examples/todo-stats/tsconfig.json"],
    ["/opt/validator/package.json", "examples/todo-stats/package.json"],
    ["/opt/validator/types.ts", "examples/todo-stats/src/types.ts"],
    ["/opt/validator/cli.ts", "examples/todo-stats/src/cli.ts"],
    ["/opt/toolchain/node_modules/typescript/lib/typescript.js", "node_modules/typescript/lib/typescript.js"],
    ["/opt/toolchain/node_modules/typescript/lib/_tsc.js", "node_modules/typescript/lib/_tsc.js"]
  ])
    files[internal!] = hash(readFileSync(resolve(repo, host!)));
  for (const match of readFileSync(resolve(repo, "tools/build-validator/Dockerfile"), "utf8").matchAll(
    /cat > (\/opt\/validator\/[a-z]+\.mjs) <<'JS'\n([\s\S]*?)\nJS/g
  ))
    files[match[1]!] = hash(match[2]! + "\n");
  files["/opt/validator/node-version"] = hash("22.20.0");
  return { profile: "cothink-build-validator-v1", node: "22.20.0", expectedNode: "22.20.0", files };
}
function fakeDocker(metadata = fakeToolchain(), compileStatus = 1, hostOracle?: typeof spawnSync) {
  let source: string | undefined;
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    if (command !== "docker") {
      if (hostOracle) return hostOracle(command, args as string[], options);
      throw new Error("Unit transport must never execute candidate or host oracle");
    }
    const argv = args as string[];
    let stdout = "";
    if (argv[0] === "image") stdout = JSON.stringify([{ Id: image }]);
    if (argv[0] === "create") {
      source = argv
        .find((a) => a.startsWith("type=bind,source="))
        ?.split("source=")[1]
        ?.split(",")[0];
      stdout = "c".repeat(64);
    }
    if (argv[0] === "inspect") stdout = JSON.stringify([descriptor(source)]);
    if (argv.includes("/opt/validator/describe.mjs")) stdout = JSON.stringify(metadata);
    if (argv.includes("/opt/validator/compile.mjs"))
      return { status: compileStatus, stdout: "all tests passed", stderr: "", signal: null, pid: 0, output: [] };
    return { status: 0, stdout, stderr: "", signal: null, pid: 0, output: [] };
  });
}
test("metadata hashes bind image runtime, frozen checker and requested group, not stage0 proof", async () => {
  fakeDocker();
  const verifier = new DockerVerifier(writer, { image, repoRoot: resolve("../..") });
  const common = await verifier.describe(["common"]);
  const report = await verifier.describe(["common", "report"]);
  expect(common.imageDigest).toBe(image);
  expect(common.checksHash).not.toBe(report.checksHash);
  const metadata = fakeToolchain();
  metadata.files["/opt/validator/worker.mjs"] = hash("altered worker");
  fakeDocker(metadata);
  await expect(verifier.describe(["common"])).rejects.toThrow("BUILD_TOOLCHAIN_FROZEN");
});
test("immutable candidate binding rejects wrong hash and failed compiler stdout cannot pass", async () => {
  const repo = resolve("../..");
  const manifest = JSON.parse(readFileSync(resolve(repo, "examples/todo-stats/manifest.json"), "utf8")) as {
    files: { path: string; contentHash: string }[];
  };
  const files = Object.fromEntries(
    manifest.files.map((f) => [
      f.path,
      {
        text: readFileSync(resolve(repo, "examples/todo-stats", f.path), "utf8"),
        contentHash: f.contentHash,
        blobId: "d".repeat(40)
      }
    ])
  );
  const mockWriter = {
    assertOwner: async () => {},
    git: { readFiles: async () => files }
  } as unknown as FileBuildWriter;
  const verifier = new DockerVerifier(mockWriter, { image, repoRoot: repo });
  fakeDocker();
  const definition = await verifier.describe(["common"]);
  const baseVersion = "b".repeat(40);
  const records = manifest.files
    .map((f) => ({ path: f.path, contentHash: f.contentHash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const candidate = {
    attemptId: "test-attempt",
    baseVersion,
    version: "c".repeat(40),
    planHash: hash("plan"),
    candidateHash: hashBuildValue({ baseVersion, files: records })
  };
  await expect(verifier.check({ ...candidate, candidateHash: hash("wrong") }, definition)).rejects.toThrow(
    "BUILD_CANDIDATE_HASH"
  );
  const receipt = await verifier.check(candidate, definition);
  expect(receipt.passed).toBe(false);
  expect(receipt.exitCode).toBe(1);
  expect(receipt.sourceHashBefore).toBe(hashVerificationSource(files));
  expect(receipt.sourceHashAfter).toBe(receipt.sourceHashBefore);
  expect(verifier.ownsReceipt(receipt)).toBe(true);
  expect(() => {
    receipt.passed = true;
  }).toThrow();
  expect(() => {
    receipt.groups.push("final");
  }).toThrow();
  expect(verifier.ownsReceipt({ ...receipt, passed: true, exitCode: 0 })).toBe(false);
});

test("trusted copied host oracle loads outside repository and unavailable data bridge yields failed evidence", async () => {
  const repo = resolve("../..");
  const manifest = JSON.parse(readFileSync(resolve(repo, "examples/todo-stats/manifest.json"), "utf8")) as {
    files: { path: string; contentHash: string }[];
  };
  const files = Object.fromEntries(
    manifest.files.map((f) => [
      f.path,
      {
        text: readFileSync(resolve(repo, "examples/todo-stats", f.path), "utf8"),
        contentHash: f.contentHash,
        blobId: "d".repeat(40)
      }
    ])
  );
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  fakeDocker(fakeToolchain(), 0, actual.spawnSync);
  const verifier = new DockerVerifier(
    { assertOwner: async () => {}, git: { readFiles: async () => files } } as unknown as FileBuildWriter,
    { image, repoRoot: repo }
  );
  const definition = await verifier.describe(["common"]);
  const baseVersion = "b".repeat(40);
  const records = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, f]) => ({ path, contentHash: f.contentHash }));
  const result = await verifier.check(
    {
      attemptId: "host-oracle-only",
      baseVersion,
      version: "c".repeat(40),
      planHash: hash("plan"),
      candidateHash: hashBuildValue({ baseVersion, files: records })
    },
    definition
  );
  expect(result.passed).toBe(false);
});

import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("all frozen groups run in actual host Vitest through scripted DATA bridge (unit only, no candidate execution)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cothink-fake-docker-data-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    // Trusted test implementation, not read/imported/evaluated from candidate JS.
    const script = `#!${process.execPath}
const input=[]; process.stdin.on('data',chunk=>input.push(chunk)); process.stdin.on('end',()=>{
 const req=JSON.parse(Buffer.concat(input).toString());
 const decode=v=>v[0]==='undefined'?undefined:v[0]==='number'?Number(v[1]):v[0]==='scalar'?v[1]:v[0]==='array'?v[1].map(decode):Object.fromEntries(v[1].map(([k,x])=>[k,decode(x)]));
 const normalize=value=>{
  if(!Array.isArray(value))throw Error('E_INPUT');const seen=new Set();
  return value.map(item=>{
   if(!item||typeof item!=='object'||Array.isArray(item)||!Number.isInteger(item.id)||item.id<=0||seen.has(item.id)||typeof item.title!=='string'||!item.title.trim())throw Error('E_INPUT');
   seen.add(item.id);let state;
   if('status' in item){if(!['pending','done','cancelled'].includes(item.status))throw Error('E_INPUT');state=item.status;}
   else{if(typeof item.done!=='boolean')throw Error('E_INPUT');state=item.done?'done':'pending';}
   return{id:item.id,title:item.title.trim(),state};
  });
 };
 const report=tasks=>'total: '+tasks.length+'\\npending: '+tasks.filter(t=>t.state==='pending').length+'\\ndone: '+tasks.filter(t=>t.state==='done').length+'\\ncancelled: '+tasks.filter(t=>t.state==='cancelled').length+'\\n';
 let result;
 try{
  const value=decode(req.input);
  if(req.operation==='normalize')result=normalize(value);
  else if(req.operation==='report')result=report(value);
  else {
   const text=Buffer.concat(value.map(c=>Buffer.from(c))).toString('utf8');let data;
   try{data=JSON.parse(text);}catch{result={status:1,stdout:'',stderr:'E_JSON\\n'};}
   if(!result){try{result={status:0,stdout:report(normalize(data)),stderr:''};}catch{result={status:1,stdout:'',stderr:'E_INPUT\\n'};}}
  }
  process.stdout.write(JSON.stringify({ok:true,value:result}));
 }catch{process.stdout.write(JSON.stringify({ok:false,error:'E_INPUT'}));}
});
`;
    await writeFile(join(bin, "docker"), script, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const repo = resolve("../..");
    const manifest = JSON.parse(readFileSync(resolve(repo, "examples/todo-stats/manifest.json"), "utf8")) as {
      files: { path: string; contentHash: string }[];
    };
    const files = Object.fromEntries(
      manifest.files.map((f) => [
        f.path,
        {
          text: readFileSync(resolve(repo, "examples/todo-stats", f.path), "utf8"),
          contentHash: f.contentHash,
          blobId: "d".repeat(40)
        }
      ])
    );
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    fakeDocker(fakeToolchain(), 0, actual.spawnSync);
    const verifier = new DockerVerifier(
      { assertOwner: async () => {}, git: { readFiles: async () => files } } as unknown as FileBuildWriter,
      { image, repoRoot: repo }
    );
    const definition = await verifier.describe(["common", "state-format", "report", "identity", "final"]);
    const baseVersion = "b".repeat(40);
    const records = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, f]) => ({ path, contentHash: f.contentHash }));
    const result = await verifier.check(
      {
        attemptId: "all-groups-scripted-data-unit",
        baseVersion,
        version: "c".repeat(40),
        planHash: hash("plan"),
        candidateHash: hashBuildValue({ baseVersion, files: records })
      },
      definition
    );
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("unknown, inherited object names, duplicate and empty groups reject before Docker IO", async () => {
  fakeDocker();
  const verifier = new DockerVerifier(writer, { image, repoRoot: resolve("../..") });
  for (const groups of [[], ["common", "common"], ["toString"], ["__proto__"], ["shell"]])
    await expect(verifier.describe(groups as never)).rejects.toThrow("BUILD_CHECK_GROUPS");
});
