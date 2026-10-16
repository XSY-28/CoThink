/** Stage 0 host oracle. No Docker isolation or construction engine is implemented here. */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import process from "node:process";
import { Buffer } from "node:buffer";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(repo, "examples/todo-stats");
const scriptPath = fileURLToPath(import.meta.url);
const groupFiles = {
  common: "baseline",
  "state-format": "state-format",
  report: "report",
  identity: "identity",
  final: "final"
};
const groupOrder = Object.keys(groupFiles);
const mutablePaths = ["src/normalize.ts", "src/report.ts"];
const isolation = {
  mode: "host-stage0",
  docker: false,
  networkIsolation: false,
  filesystemIsolation: false,
  candidateSources: "copied-to-temporary-directory",
  acceptedWorkspaceMounted: false
};
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hashFile = (path) => sha(readFileSync(path));
// Reuse the core's pure canonical serializer through the installed TS compiler.
// This trusted host module contains no imports and never comes from a candidate.
const hasherPath = join(repo, "packages/argue/src/peer/hash.ts");
const hasherCode = ts.transpileModule(readFileSync(hasherPath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText;
const { canonicalJson: canonical } = await import(
  `data:text/javascript;base64,${Buffer.from(hasherCode).toString("base64")}`
);

function reject(code, detail) {
  throw new Error(`${code}: ${detail}`);
}
export function normalizeGroups(input) {
  const groups = input.split(",").map((group) => (group === "baseline" ? "common" : group));
  if (groups.length === 0 || groups.some((group) => !groupOrder.includes(group))) reject("E_GROUP", input);
  return groupOrder.filter((group) => groups.includes(group));
}
function toolchain() {
  const packages = ["typescript", "vitest", "@types/node"];
  return {
    node: process.version,
    nodeExecutableHash: hashFile(process.execPath),
    platform: process.platform,
    arch: process.arch,
    packages: Object.fromEntries(
      packages.map((name) => [
        name,
        JSON.parse(readFileSync(join(repo, "node_modules", name, "package.json"), "utf8")).version
      ])
    ),
    files: Object.fromEntries(
      [
        "package-lock.json",
        "node_modules/typescript/lib/_tsc.js",
        "node_modules/typescript/lib/typescript.js",
        "node_modules/vitest/vitest.mjs"
      ].map((path) => [path, hashFile(join(repo, path))])
    )
  };
}
function readManifest() {
  const manifest = JSON.parse(readFileSync(join(host, "manifest.json"), "utf8"));
  if (manifest.manifestVersion !== "todo-stats-manifest-v1") reject("E_MANIFEST", "version");
  for (const file of [...manifest.files.filter((file) => file.access === "read-only"), ...manifest.hostOnly]) {
    if (hashFile(join(host, file.path)) !== file.contentHash) reject("E_HOST_FROZEN", file.path);
  }
  return manifest;
}
export function getChecksMetadata(groups) {
  const normalized = normalizeGroups(groups.join(","));
  const manifest = readManifest();
  const trustedFiles = [
    "manifest.json",
    "SPEC.md",
    "package.json",
    "tsconfig.json",
    "src/types.ts",
    "src/cli.ts",
    "vitest.config.mjs",
    "test/harness.ts",
    ...manifest.files.filter((file) => file.path.startsWith("fixtures/")).map((file) => file.path),
    ...normalized.map((group) => `test/${groupFiles[group]}.test.ts`)
  ];
  const definition = {
    checkVersion: "build-check-v1",
    groups: normalized,
    trustedFiles: Object.fromEntries(
      [...new Set(trustedFiles)].sort().map((path) => [path, hashFile(join(host, path))])
    ),
    checkerHash: hashFile(scriptPath),
    canonicalSerializerHash: hashFile(hasherPath),
    parameters: {
      timeoutMs: 30000,
      cliTimeoutMs: 5000,
      outputLimitBytes: 8 * 1024 * 1024,
      compilerArguments: [
        "-p",
        "trusted-tsconfig",
        "--outDir",
        "temporary-directory",
        "--typeRoots",
        "host-node-types"
      ],
      testArguments: ["run", "--root", "trusted-host", "--config", "trusted-host-config", "--reporter=json"]
    },
    toolchain: toolchain(),
    isolation
  };
  return { checksHash: sha(canonical(definition)), ...definition };
}
function plainFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) reject("E_FILE", path);
  return readFileSync(path, "utf8");
}
function verifyCandidate(project, manifest) {
  for (const path of [project, join(project, "src"), join(project, "fixtures")]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("E_DIRECTORY", path);
  }
  for (const file of manifest.files) {
    const value = plainFile(join(project, file.path));
    if (file.access === "read-only" && sha(value) !== file.contentHash) reject("E_FROZEN", file.path);
  }
  // Candidate copies may omit host-only checks. If present they must remain byte-identical.
  for (const file of manifest.hostOnly) {
    if (existsSync(join(project, file.path)) && sha(plainFile(join(project, file.path))) !== file.contentHash)
      reject("E_FROZEN", file.path);
  }
  for (const path of readdirSync(join(project, "src"))) {
    if (!["types.ts", "cli.ts", "normalize.ts", "report.ts"].includes(path)) reject("E_SCOPE", `src/${path}`);
  }
  const sources = Object.fromEntries(mutablePaths.map((path) => [path, plainFile(join(project, path))]));
  for (const [path, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        if (
          !node.importClause?.isTypeOnly ||
          !ts.isStringLiteral(node.moduleSpecifier) ||
          node.moduleSpecifier.text !== "./types.js"
        )
          reject("E_SOURCE_DEPENDENCY", path);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) reject("E_SOURCE_DEPENDENCY", path);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        reject("E_SOURCE_DEPENDENCY", path);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    sources,
    candidateHash: sha(
      canonical(Object.fromEntries(manifest.files.map((file) => [file.path, hashFile(join(project, file.path))])))
    )
  };
}
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    ...options
  });
  return {
    exitCode: result.status ?? 2,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {})
  };
}
export function checkProject(project, groups, stdinFixture) {
  groups = normalizeGroups(groups.join(","));
  if (Number(process.versions.node.split(".")[0]) < 22) reject("E_NODE", "Node 22+ required");
  const manifest = readManifest();
  const metadata = getChecksMetadata(groups);
  const candidate = verifyCandidate(project, manifest);
  const directory = mkdtempSync(join(tmpdir(), "cothink-sample-check-"));
  try {
    mkdirSync(join(directory, "src"));
    for (const path of ["package.json", "tsconfig.json", "src/types.ts", "src/cli.ts"])
      writeFileSync(join(directory, path), readFileSync(join(host, path)));
    for (const [path, text] of Object.entries(candidate.sources)) writeFileSync(join(directory, path), text);
    const compiler = execute(process.execPath, [
      join(repo, "node_modules/typescript/bin/tsc"),
      "-p",
      join(directory, "tsconfig.json"),
      "--outDir",
      join(directory, "out"),
      "--typeRoots",
      join(repo, "node_modules/@types")
    ]);
    const base = { ...metadata, project: resolve(project), candidateHash: candidate.candidateHash, compiler };
    if (compiler.exitCode !== 0)
      return { ...base, exitCode: 1, failures: [{ name: "typecheck", messages: [compiler.stdout, compiler.stderr] }] };
    writeFileSync(join(directory, "out/package.json"), '{"type":"module"}\n');
    const tests = execute(
      process.execPath,
      [
        join(repo, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        host,
        "--config",
        join(host, "vitest.config.mjs"),
        ...groups.map((group) => `test/${groupFiles[group]}.test.ts`),
        "--reporter=json"
      ],
      { env: { PATH: process.env.PATH, BUILD_SAMPLE_COMPILED_ROOT: join(directory, "out") } }
    );
    let summary;
    try {
      summary = JSON.parse(tests.stdout);
    } catch {
      reject("E_HARNESS", `${tests.stdout}\n${tests.stderr}`);
    }
    const failures = summary.testResults.flatMap((suite) =>
      suite.assertionResults
        .filter((test) => test.status === "failed")
        .map((test) => ({ name: test.fullName, messages: test.failureMessages }))
    );
    if (tests.exitCode !== 0 && failures.length === 0) reject("E_HARNESS", "no behavioral assertion failures");
    // Detect visible writes to the candidate and trusted host materials. This is observation, not isolation.
    if (verifyCandidate(project, readManifest()).candidateHash !== candidate.candidateHash)
      reject("E_CANDIDATE_CHANGED", project);
    const result = {
      ...base,
      exitCode: tests.exitCode,
      tests: { passed: summary.numPassedTests, failed: summary.numFailedTests, total: summary.numTotalTests },
      failures,
      testStderr: tests.stderr
    };
    if (stdinFixture && tests.exitCode === 0) {
      const input = readFileSync(join(host, stdinFixture), "utf8");
      result.cli = execute(process.execPath, [join(directory, "out/src/cli.js")], {
        input,
        env: { PATH: process.env.PATH }
      });
      result.exitCode = result.cli.exitCode;
    }
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function reference(project, manifest, normalize, report) {
  mkdirSync(join(project, "src"), { recursive: true });
  for (const file of manifest.files) {
    mkdirSync(dirname(join(project, file.path)), { recursive: true });
    writeFileSync(join(project, file.path), readFileSync(join(host, file.path)));
  }
  if (normalize)
    writeFileSync(join(project, "src/normalize.ts"), normalize.replaceAll("../../src/types.js", "./types.js"));
  if (report) writeFileSync(join(project, "src/report.ts"), report.replaceAll("../../src/types.js", "./types.js"));
}
export function selfTest() {
  const manifest = readManifest();
  const directory = mkdtempSync(join(tmpdir(), "cothink-oracle-self-test-"));
  const entries = [];
  const oracle = (name) => readFileSync(join(host, "test/oracle", `${name}.ts`), "utf8");
  const finalNormalize = oracle("correct-final");
  const stateNormalize = oracle("correct-state");
  const finalReport = oracle("correct-report");
  function run(name, groups, expected, normalize, report, failureName) {
    const project = join(directory, name);
    reference(project, manifest, normalize, report);
    const result = checkProject(project, groups, name === "v0-baseline" ? "fixtures/legacy.json" : undefined);
    if (
      name === "v0-baseline" &&
      (result.cli?.stdout !== "total: 2\n" || result.cli?.stderr !== "" || result.cli?.exitCode !== 0)
    )
      reject("E_ORACLE", "V0 must output exactly total only");
    if (
      result.exitCode !== expected ||
      (failureName && !result.failures.some((failure) => failure.name.includes(failureName)))
    )
      reject("E_ORACLE", JSON.stringify({ name, expected, failureName, result }));
    const entry = { name, expectedExitCode: expected, ...result };
    entries.push(entry);
    return project;
  }
  function mutate(source, from, to) {
    if (!source.includes(from)) reject("E_ORACLE_MUTATION", from);
    return source.replace(from, to);
  }
  try {
    run("v0-baseline", ["common"], 0);
    run("v0-state-format-expected-failure", ["state-format"], 1, undefined, undefined, "status is accepted");
    run("v0-report-expected-failure", ["report"], 1, undefined, undefined, "counts frozen");
    run("v0-identity-expected-failure", ["identity"], 1, undefined, undefined, "trims only");
    run("v0-final-expected-failure", ["final"], 1, undefined, undefined, "joint CLI");
    run("reference-T-A", ["common", "state-format"], 0, stateNormalize);
    run("reference-T-B1", ["common", "report"], 0, undefined, finalReport);
    run("reference-T-A-T-B2", ["common", "state-format", "identity"], 0, finalNormalize);
    run("reference-final", groupOrder, 0, finalNormalize, finalReport);
    run(
      "reference-report-independent",
      ["report"],
      0,
      'export function normalizeTasks(_input: unknown): never { throw new Error("NORMALIZER_MUST_NOT_RUN"); }',
      finalReport
    );
    run(
      "wrong-common-done",
      ["common"],
      1,
      mutate(stateNormalize, 'state = item.done ? "done" : "pending";', 'state = "pending";'),
      undefined,
      "legacy states"
    );
    run(
      "wrong-status-priority",
      ["state-format"],
      1,
      mutate(stateNormalize, "state = item.status;", 'state = item.done ? "done" : "pending";'),
      undefined,
      "status is accepted"
    );
    run(
      "wrong-status-fallback",
      ["state-format"],
      1,
      mutate(
        stateNormalize,
        'throw new Error("E_INPUT");\n      state = item.status;',
        'return { id: item.id, title: item.title, state: item.done ? "done" : "pending" };\n      state = item.status;'
      ),
      undefined,
      "invalid status"
    );
    run(
      "wrong-report-hardcoded",
      ["report"],
      1,
      undefined,
      'export function renderReport(_tasks: unknown): string { return "total: 4\\npending: 1\\ndone: 2\\ncancelled: 1\\n"; }',
      "counts empty"
    );
    run(
      "wrong-report-order",
      ["report"],
      1,
      undefined,
      finalReport.replaceAll("pending", "STATE_TEMP").replaceAll("done", "pending").replaceAll("STATE_TEMP", "done"),
      "counts frozen"
    );
    run(
      "wrong-identity-trim",
      ["identity"],
      1,
      mutate(finalNormalize, "const title = item.title.trim();", "const title = item.title;"),
      undefined,
      "trims only"
    );
    run(
      "wrong-identity-blank",
      ["identity"],
      1,
      mutate(finalNormalize, 'if (title.length === 0) throw new Error("E_INPUT");', ""),
      undefined,
      "rejects blank"
    );
    run(
      "wrong-identity-duplicate",
      ["identity"],
      1,
      mutate(finalNormalize, 'if (seen.has(item.id)) throw new Error("E_INPUT");', ""),
      undefined,
      "batch uniqueness"
    );
    run(
      "wrong-final-order",
      ["final"],
      1,
      mutate(finalNormalize, "return input.map", "return [...input].reverse().map"),
      finalReport,
      "handles empty"
    );
    const dependency = join(directory, "wrong-report-dependency");
    reference(
      dependency,
      manifest,
      finalNormalize,
      'import { normalizeTasks } from "./normalize.js";\nexport function renderReport(): string { return String(normalizeTasks([]).length); }'
    );
    try {
      checkProject(dependency, ["report"]);
      reject("E_ORACLE", "dependency accepted");
    } catch (error) {
      if (!String(error).includes("E_SOURCE_DEPENDENCY")) throw error;
    }
    entries.push({ name: "wrong-report-dependency", rejected: "E_SOURCE_DEPENDENCY", executedCandidate: false });
    for (const path of ["fixtures/legacy.json", "src/types.ts", "tsconfig.json", "test/baseline.test.ts"]) {
      const project = join(directory, `changed-${path.replaceAll("/", "-")}`);
      reference(project, manifest);
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), "changed");
      try {
        checkProject(project, ["common"]);
        reject("E_ORACLE", `${path} accepted`);
      } catch (error) {
        if (!String(error).includes("E_FROZEN")) throw error;
      }
      entries.push({ name: `changed-${path}`, rejected: "E_FROZEN", executedCandidate: false });
    }
    for (const path of ["src", "fixtures"]) {
      const project = join(directory, `linked-${path}`);
      reference(project, manifest);
      rmSync(join(project, path), { recursive: true });
      symlinkSync(join(host, path), join(project, path), "dir");
      try {
        checkProject(project, ["common"]);
        reject("E_ORACLE", `${path} link accepted`);
      } catch (error) {
        if (!String(error).includes("E_DIRECTORY")) throw error;
      }
      entries.push({ name: `linked-${path}`, rejected: "E_DIRECTORY", executedCandidate: false });
    }
    const unknown = execute(process.execPath, [
      scriptPath,
      "--project",
      join(directory, "does-not-exist"),
      "--groups",
      "common,shell"
    ]);
    if (unknown.exitCode !== 2 || !unknown.stderr.includes("E_GROUP") || unknown.stdout !== "")
      reject("E_ORACLE", "unknown group must fail before opening candidate");
    entries.push({ name: "unknown-group", rejected: "E_GROUP", executedCandidate: false, ...unknown });
    return { selfTest: "passed", isolation, entries };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") {
    const result = selfTest();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  let project;
  let groupInput;
  let stdinFixture;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value || !["--project", "--groups", "--stdin"].includes(key)) reject("E_ARGUMENT", key);
    if (key === "--project") {
      if (project) reject("E_ARGUMENT", "duplicate project");
      project = resolve(value);
    }
    if (key === "--groups") {
      if (groupInput) reject("E_ARGUMENT", "duplicate groups");
      groupInput = value;
    }
    if (key === "--stdin") {
      if (stdinFixture) reject("E_ARGUMENT", "duplicate stdin");
      stdinFixture = value;
    }
  }
  if (!project || !groupInput) reject("E_ARGUMENT", "required: --project DIR --groups GROUPS");
  const groups = normalizeGroups(groupInput);
  if (
    stdinFixture &&
    !["fixtures/legacy.json", "fixtures/mixed.json", "fixtures/normalized.json", "fixtures/invalid.json"].includes(
      stdinFixture
    )
  )
    reject("E_ARGUMENT", "stdin must name a frozen fixture");
  const result = checkProject(project, groups, stdinFixture);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode;
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
