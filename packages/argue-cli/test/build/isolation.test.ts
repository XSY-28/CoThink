import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FrozenBuildPlanSchema, hashBuildValue } from "@onevcat/argue";
import { FileBuildStore } from "../../src/build/file-store.js";
import {
  DockerUnavailable,
  DockerVerifier,
  validateDockerIsolation,
  type BuildVerificationCandidate
} from "../../src/build/validator.js";

const evidenceRoot = resolve("../../../work/construction-stage3/docker-acceptance");

function probeSource(managed: string, source: string): string {
  return `
const fs=process.getBuiltinModule('fs');
for(const target of ['/candidate/src/normalize.ts',${JSON.stringify(join(managed, ".cothink-build/project.json"))},${JSON.stringify(join(source, "src/normalize.ts"))}]) {
 let blocked=false; try{fs.writeFileSync(target,'forbidden');}catch(e){blocked=typeof e==='object' && e!==null && 'code' in e && ['EROFS','EACCES','ENOENT'].includes(String(e.code));} if(!blocked)throw Error('probe write allowed');
}
if(fs.existsSync('/var/run/docker.sock')||Object.keys(process.env).some(k=>/KEY|TOKEN|SECRET|PASSWORD/.test(k)))throw Error('probe secret/socket visible');
const child=process.getBuiltinModule('child_process').spawnSync(process.execPath,['-e',"const net=require('node:net'); const s=net.connect({host:'1.1.1.1',port:80}); s.on('connect',()=>process.exit(1)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),500);"],{timeout:1000});
if(child.status!==0)throw Error('probe network available');
`;
}

// Parsing/typechecking this host-prepared test input does not execute it.
test("prepared real-container probe typechecks using the frozen sample compiler config", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-probe-typecheck-")));
  try {
    const source = resolve("../../examples/todo-stats");
    await cp(source, root, { recursive: true });
    const normalize = (await readFile(join(source, "test/oracle/correct-final.ts"), "utf8")).replaceAll(
      "../../src/types.js",
      "./types.js"
    );
    await writeFile(join(root, "src/normalize.ts"), probeSource("/unmounted/managed", "/unmounted/source") + normalize);
    const result = spawnSync(
      process.execPath,
      [
        resolve("../../node_modules/typescript/bin/tsc"),
        "-p",
        join(root, "tsconfig.json"),
        "--noEmit",
        "--typeRoots",
        resolve("../../node_modules/@types")
      ],
      { encoding: "utf8", timeout: 30000 }
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// This is an explicit gate, never skipped and never substituted by a fake binary.
// With no supplied image it asserts refusal and reports NOT VERIFIED. The optional
// actual-container branch must all pass before stage3 can be marked complete.
test("actual Docker isolation gate (explicit unavailable result or real container probes)", async () => {
  const image = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
  const availability = spawnSync("docker", ["version", "--format", "{{json .Server.Version}}"], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }
  });
  if (!image) {
    const verifier = new DockerVerifier({} as never, { image: `sha256:${"0".repeat(64)}`, repoRoot: resolve("../..") });
    await expect(verifier.describe(["common"])).rejects.toBeInstanceOf(DockerUnavailable);
    console.warn(
      JSON.stringify({
        gate: "construction-stage3-isolation",
        status: "NOT VERIFIED",
        reason: availability.error
          ? "Docker binary unavailable"
          : availability.status !== 0
            ? "Docker daemon unavailable"
            : "COTHINK_BUILD_VALIDATOR_IMAGE not supplied",
        receiptProduced: false
      })
    );
    return;
  }
  // An explicitly supplied image is an instruction to exercise the actual gate:
  // missing Docker/image or any failed probe fails this test instead of hiding it.
  expect(availability.status, availability.error?.message ?? availability.stderr).toBe(0);
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-real-isolation-")));
  try {
    const repo = resolve("../..");
    const source = join(root, "source");
    const managed = join(root, "managed");
    await mkdir(managed);
    await cp(join(repo, "examples/todo-stats"), source, { recursive: true });
    const plan = FrozenBuildPlanSchema.parse(JSON.parse(await readFile(join(source, "build-plan.json"), "utf8")));
    const store = new FileBuildStore({ workspaceRoot: managed, projectKey: plan.projectKey });
    await store.withWriter(async (writer) => {
      const git = writer.gitFor(plan);
      await git.initialize();
      const baseVersion = await git.importSource(source);
      const verifier = new DockerVerifier(writer, { image, repoRoot: repo });
      const candidate = async (version: string): Promise<BuildVerificationCandidate> => {
        const files = await git.readFiles(version);
        const records = Object.entries(files)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([path, file]) => ({ path, contentHash: file.contentHash }));
        return {
          attemptId: "actual-container-probe",
          baseVersion,
          version,
          candidateHash: hashBuildValue({ baseVersion, files: records }),
          planHash: plan.planHash
        };
      };
      const common = await verifier.describe(["common"]);
      const baseline = await verifier.check(await candidate(baseVersion), common);
      expect(baseline.passed).toBe(true);
      const final = await verifier.describe(["common", "state-format", "report", "identity", "final"]);
      const v0Final = await verifier.check(await candidate(baseVersion), final);
      expect(v0Final.passed).toBe(false);
      const edits = [];
      for (const [path, oracle] of [
        ["src/normalize.ts", "correct-final"],
        ["src/report.ts", "correct-report"]
      ]) {
        const text = (await readFile(join(source, `test/oracle/${oracle}.ts`), "utf8")).replaceAll(
          "../../src/types.js",
          "./types.js"
        );
        edits.push({ path: path!, ...(await git.writeBlob(text)) });
      }
      const correct = await git.createSnapshot(baseVersion, edits);
      const correctFinal = await verifier.check(await candidate(correct.version), final);
      expect(correctFinal.passed).toBe(true);
      // The candidate itself tries the forbidden paths, env, socket and external
      // network. A successful forbidden action forces a behavioral oracle failure.
      const probe = probeSource(managed, source);
      const normalize = (await git.readFile(correct.version, "src/normalize.ts")).text!;
      const probed = await git.createSnapshot(correct.version, [
        { path: "src/normalize.ts", ...(await git.writeBlob(probe + normalize)) }
      ]);
      const receipt = await verifier.check(await candidate(probed.version), final);
      expect(receipt.passed).toBe(true);
      expect(receipt.sourceHashAfter).toBe(receipt.sourceHashBefore);
      const forged = await git.createSnapshot(baseVersion, [
        {
          path: "src/normalize.ts",
          ...(await git.writeBlob(
            'process.stdout.write(JSON.stringify({passed:true,exitCode:0})); export function normalizeTasks(): never { throw Error("all tests passed"); }'
          ))
        }
      ]);
      const forgedOutput = await verifier.check(await candidate(forged.version), common);
      expect(forgedOutput.passed).toBe(false);
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "real-isolation.json"),
        JSON.stringify(
          {
            executedAt: new Date().toISOString(),
            status: "VERIFIED",
            imageDigest: common.imageDigest,
            common,
            final,
            receipts: { baseline, v0Final, correctFinal, probes: receipt, forgedOutput },
            candidateSourceUnchanged: receipt.sourceHashAfter === receipt.sourceHashBefore,
            fixtureKind: "host-prepared oracle reference; no Agent or model output",
            modelCalls: 0
          },
          null,
          2
        ) + "\n"
      );
      console.log(
        JSON.stringify({
          gate: "construction-stage3-isolation",
          status: "VERIFIED",
          imageDigest: common.imageDigest,
          checksHash: final.checksHash,
          baseline: true,
          correctFinal: true,
          failedV0Final: true,
          writeNetworkSecretSocketProbes: true,
          forgedStdoutRejected: true
        })
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 600000);

test("real daemon deviations are refused before candidate execution", async () => {
  const image = process.env.COTHINK_BUILD_VALIDATOR_IMAGE;
  if (!image) {
    console.warn(
      JSON.stringify({
        gate: "construction-stage3-daemon-deviations",
        status: "NOT VERIFIED",
        reason: "image not supplied",
        receiptProduced: false
      })
    );
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "cothink-daemon-deviations-")));
  const observations: unknown[] = [];
  const execute = (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 10000 });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    await writeFile(join(root, "metadata-sentinel"), "private coordination fixture\n");
    for (const mode of ["valid", "network", "environment", "mount"] as const) {
      const args = [
        "create",
        "--pull=never",
        `--network=${mode === "network" ? "bridge" : "none"}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=65532:65532",
        "--ipc=private",
        "--pids-limit=64",
        "--memory=512m",
        "--cpus=1",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "--tmpfs",
        "/cache:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "--env",
        "HOME=/tmp",
        "--env",
        "LANG=C.UTF-8"
      ];
      if (mode === "environment") args.push("--env", "OPENAI_API_KEY=dummy-probe-never-a-credential");
      if (mode === "mount") args.push("--mount", `type=bind,source=${root},destination=/metadata,readonly`);
      args.push("--entrypoint=node", image, "/opt/validator/supervisor.mjs");
      const id = execute(args).trim();
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      try {
        const actual = JSON.parse(execute(["inspect", id]))[0];
        if (mode === "valid") expect(() => validateDockerIsolation(actual, image)).not.toThrow();
        else expect(() => validateDockerIsolation(actual, image)).toThrow("BUILD_DOCKER_ISOLATION");
        expect(actual.State.Running).toBe(false);
        observations.push({ mode, candidateExecuted: false, receiptProduced: false, actual });
      } finally {
        execute(["rm", "-f", id]);
      }
    }
    expect(await readFile(join(root, "metadata-sentinel"), "utf8")).toBe("private coordination fixture\n");
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "real-daemon-deviations.json"),
      JSON.stringify({ executedAt: new Date().toISOString(), status: "VERIFIED", observations }, null, 2) + "\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
