import process from "node:process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { posix, dirname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire("/opt/toolchain/package.json");
const ts = require("typescript");
const config = JSON.parse(readFileSync("/runtime-config/config.json", "utf8"));
const fail = () => {
  throw new Error("AGENT_SYNC_SOURCE_DEPENDENCY");
};
if (config.version !== "agent-sync-runtime-config-v1") fail();
for (const path of config.files) {
  const text = readFileSync("/candidate/" + path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  // Reference directives can add undeclared code/lib/type packages through the compiler.
  if (source.referencedFiles.length || source.typeReferenceDirectives.length || source.libReferenceDirectives.length)
    fail();
  function edge(specifier, typeOnly) {
    if (!ts.isStringLiteral(specifier)) fail();
    const spec = specifier.text;
    if (config.builtins.some((b) => b.from === path && b.specifier === spec)) return;
    const list = typeOnly ? config.typeModules : config.runtimeModules;
    const item = list.find((e) => e.from === path && e.specifier === spec);
    if (!item || posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.js$/, ".ts") !== item.to) fail();
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) edge(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) edge(node.moduleSpecifier, node.isTypeOnly === true);
    if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) fail();
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      fail();
    ts.forEachChild(node, visit);
  }
  visit(source);
  mkdirSync(dirname("/tmp/project/" + path), { recursive: true });
  writeFileSync("/tmp/project/" + path, text);
}
writeFileSync("/tmp/project/package.json", '{"type":"module"}\n');
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmitOnError: true,
  skipLibCheck: true,
  rootDir: "/tmp/project",
  outDir: "/tmp/out",
  types: ["node"],
  typeRoots: ["/opt/toolchain/node_modules/@types"],
  sourceMap: false,
  declaration: false
};
const program = ts.createProgram(
  config.files.map((p) => "/tmp/project/" + p),
  options
);
const result = program.emit();
if (ts.getPreEmitDiagnostics(program).length || result.emitSkipped) {
  process.stderr.write("AGENT_SYNC_COMPILE");
  process.exit(1);
}
writeFileSync("/tmp/out/package.json", '{"type":"module"}\n');
