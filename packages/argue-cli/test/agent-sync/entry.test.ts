import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildResult, type Metafile } from "esbuild";
import { describe, expect, test } from "vitest";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const core = resolve(repo, "packages/argue/src/agent-sync/index.ts");
const host = resolve(repo, "packages/argue-cli/src/agent-sync/index.ts");
const forbidden =
  /(?:packages\/argue\/src\/(?:index\.ts|build\/(?:index|driver|requests)\.ts|core\/|discussion\/|transport\/)|packages\/argue-cli\/src\/(?:index\.ts|runtime\/|model-api\/|discussion\/|peer\/|build\/(?:runtime|config|commands|discussion-link)\.ts|config\.ts|env[^/]*\.ts)|node_modules\/(?:@ai-sdk\/|ai\/))/;

async function bundle(entry: string) {
  return build({
    absWorkingDir: repo,
    entryPoints: [entry],
    bundle: true,
    treeShaking: false,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: {
      "@onevcat/argue/agent-sync/project": resolve(repo, "packages/argue/src/agent-sync/project/index.ts"),
      "@onevcat/argue/agent-sync/legacy-v1": resolve(repo, "packages/argue/src/agent-sync/legacy-v1/index.ts"),
      "@onevcat/argue/agent-sync": core,
      "@onevcat/argue": resolve(repo, "packages/argue/src/index.ts")
    },
    write: false,
    metafile: true,
    logLevel: "silent"
  });
}

function forbiddenInputs(metafile: Metafile) {
  return Object.keys(metafile.inputs).filter((path) => forbidden.test(path));
}

function assertNeutral(result: BuildResult<{ metafile: true; write: false }>) {
  expect(forbiddenInputs(result.metafile)).toEqual([]);
  const external = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external).map((item) => item.path)
  );
  expect(external.filter((path) => /^(?:@onevcat\/argue(?:\/|$)|@ai-sdk\/|ai$|dotenv(?:\/|$))/.test(path))).toEqual([]);
}

function execute(result: BuildResult<{ metafile: true; write: false }>, assertions: string) {
  const source = result.outputFiles[0]!.text;
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  // The real emitted ESM runs in a fresh process; no provider or environment setup.
  const child = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    input: `import assert from "node:assert/strict";\nconst api = await import(${JSON.stringify(url)});\n${assertions}`,
    encoding: "utf8",
    timeout: 10000
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
}

describe("neutral agent-sync public imports", () => {
  test("core exposes usable validation and hashing without the model driver graph", async () => {
    const result = await bundle(core);
    assertNeutral(result);
    expect(Object.keys(result.metafile.inputs)).toContain("packages/argue/src/build/scheduler.ts");
    execute(
      result,
      `
      assert.equal(api.BuildPathSchema.parse("src/value.ts"), "src/value.ts");
      assert.throws(() => api.BuildPathSchema.parse("../secret"));
      assert.equal(api.hashBuildValue({}), "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
      assert.equal(typeof api.buildWaitReasons, "function");
      assert.equal(typeof api.reserveBuildScope, "function");
      assert.equal(typeof api.validatePublisherPortResult, "function");
      assert.equal(api.BuildDriver, undefined);
    `
    );
  });

  test("host bundles all real backends through the neutral core subpath", async () => {
    const result = await bundle(host);
    assertNeutral(result);
    const inputs = Object.keys(result.metafile.inputs);
    for (const backend of [
      "file-store",
      "git-snapshots",
      "workspace",
      "validator",
      "publisher",
      "recovery",
      "local-sync-adapter"
    ])
      expect(inputs).toContain(`packages/argue-cli/src/build/${backend}.ts`);
    expect(inputs).toContain("packages/argue/src/agent-sync/index.ts");
    expect(inputs).toContain("packages/argue-cli/src/storage/snapshot-store.ts");
    execute(
      result,
      `
      assert.throws(() => new api.FileBuildStore({ workspaceRoot: "relative", projectKey: "entry" }), /absolute and canonical/);
      assert.deepEqual(api.decodeDockerData("report", '{"ok":true,"value":"checked"}'), "checked");
      assert.throws(() => api.decodeDockerData("report", '{"ok":true,"value":42}'), /BUILD_DOCKER_DATA/);
      for (const key of ["GitSnapshots", "Workspace", "DockerVerifier", "Publisher", "LocalBuildSyncAdapter", "recoverBuild", "exportAcceptedVersion"])
        assert.equal(typeof api[key], "function", key);
    `
    );
  });

  test("the legacy root graph is a positive control for forbidden dependencies", async () => {
    const result = await bundle(resolve(repo, "packages/argue/src/index.ts"));
    const rejected = forbiddenInputs(result.metafile);
    expect(rejected).toContain("packages/argue/src/build/driver.ts");
    expect(rejected.some((path) => path.includes("/discussion/"))).toBe(true);
    expect(rejected.some((path) => path.includes("/transport/"))).toBe(true);
  });
});
