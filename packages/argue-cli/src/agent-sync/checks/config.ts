import { z } from "zod";
import { posix } from "node:path";
import {
  hashJson,
  freezeSyncValue,
  SyncIdSchema as Id,
  SyncHashSchema as Hash,
  SyncPathSchema as Path,
  type AgentSyncProject
} from "@onevcat/argue/agent-sync/project";
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const Identifier = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
const File = Path.refine((p) => p.endsWith(".ts") && !p.endsWith(".d.ts"), "Only plain TypeScript modules");
const Artifact = z.object({ id: Id, relativePath: Path, expectedHash: Hash }).strict();
const Edge = z.object({ from: File, specifier: z.string().regex(/^\.\.?\/.+\.js$/), to: File }).strict();
const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.string(), z.number().finite(), z.array(Json), z.record(Json)])
);
const Bound = z.number().int().positive().safe();
const Schema = z
  .object({
    version: z.literal("agent-sync-trusted-checks-v1"),
    runtime: z
      .object({
        version: z.literal("agent-sync-runtime-config-v1"),
        files: z.array(File).min(1).max(256),
        compiler: z
          .object({ target: z.literal("ES2022"), module: z.literal("NodeNext"), strict: z.literal(true) })
          .strict(),
        typeModules: z.array(Edge),
        runtimeModules: z.array(Edge),
        builtins: z.array(
          z
            .object({
              from: File,
              specifier: z.enum(["node:buffer", "node:util", "node:stream", "node:string_decoder"])
            })
            .strict()
        ),
        operations: z
          .array(
            z.discriminatedUnion("kind", [
              z.object({ id: Id, kind: z.literal("function"), module: File, exportName: Identifier }).strict(),
              z.object({ id: Id, kind: z.literal("cli"), module: File }).strict()
            ])
          )
          .min(1)
          .max(256)
      })
      .strict(),
    profiles: z.array(z.object({ profileId: Id, checkIds: z.array(Id).min(1) }).strict()).min(1),
    finalProfileId: Id,
    checks: z
      .array(
        z
          .object({
            checkId: Id,
            oracleId: Id,
            parameters: Json,
            expectedCaseIds: z.array(z.string().min(1).max(512)).min(1).max(1024)
          })
          .strict()
      )
      .min(1),
    oracles: z
      .array(
        z
          .object({
            oracleId: Id,
            entry: Path,
            root: Path.optional(),
            dependencyId: Id.optional(),
            files: z.array(Path).min(1),
            kind: z.enum(["node-assert", "vitest-proxy"])
          })
          .strict()
      )
      .min(1),
    proxies: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ path: Path, kind: z.literal("function"), operationId: Id, exportName: Identifier }).strict(),
          z.object({ path: Path, kind: z.literal("cli"), operationId: Id }).strict()
        ])
      )
      .default([]),
    decoders: z.array(z.object({ operationId: Id, module: Path, exportName: Identifier }).strict()).min(1),
    artifacts: z.array(Artifact).min(1),
    dependencies: z.array(z.object({ id: Id, relativePath: Path, expectedHash: Hash }).strict()),
    image: z
      .object({
        profile: z.literal("agent-sync-validator-v1"),
        node: z.string().regex(/^(2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/),
        files: z.record(Hash),
        toolchainTreeHash: Hash,
        nodeBinaryHash: Hash
      })
      .strict(),
    limits: z
      .object({
        checkTimeoutMs: Bound.max(120000),
        callTimeoutMs: Bound.max(30000),
        maxRpcBytes: Bound.max(8388608),
        maxResultBytes: Bound.max(8388608),
        maxOracleOutputBytes: Bound.max(8388608),
        maxCalls: Bound.max(10000),
        maxTotalRpcBytes: Bound.max(67108864),
        maxTotalResultBytes: Bound.max(67108864),
        maxDepth: Bound.max(128),
        maxElements: Bound.max(1000000)
      })
      .strict()
  })
  .strict()
  .superRefine((c, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const ids of [
      c.runtime.files,
      c.runtime.operations.map((o) => o.id),
      c.profiles.map((p) => p.profileId),
      c.checks.map((x) => x.checkId),
      c.oracles.map((o) => o.oracleId),
      c.decoders.map((d) => d.operationId),
      c.artifacts.map((a) => a.id),
      c.artifacts.map((a) => a.relativePath),
      c.dependencies.map((d) => d.id)
    ])
      if (!unique(ids)) bad("Duplicate registry identity");
    const paths = new Map<string, string>();
    for (const path of c.runtime.files) {
      const lower = path.toLowerCase();
      if (paths.has(lower)) bad("Case alias");
      paths.set(lower, path);
    }
    const artifacts = new Set(c.artifacts.map((a) => a.relativePath));
    const artifactPaths = [...artifacts, ...c.dependencies.map((d) => d.relativePath)];
    for (let i = 0; i < artifactPaths.length; i++)
      for (let j = i + 1; j < artifactPaths.length; j++) {
        const a = artifactPaths[i]!.toLowerCase(),
          b = artifactPaths[j]!.toLowerCase();
        if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) bad("Artifact namespace collision");
      }
    if (c.limits.maxTotalRpcBytes < c.limits.maxRpcBytes || c.limits.maxTotalResultBytes < c.limits.maxResultBytes)
      bad("Total byte budget smaller than probe budget");
    for (const edge of [...c.runtime.typeModules, ...c.runtime.runtimeModules]) {
      if (
        !c.runtime.files.includes(edge.from) ||
        !c.runtime.files.includes(edge.to) ||
        posix.normalize(posix.join(posix.dirname(edge.from), edge.specifier)).replace(/\.js$/, ".ts") !== edge.to
      )
        bad("Invalid exact module edge");
    }
    if (!unique([...c.runtime.typeModules, ...c.runtime.runtimeModules].map((e) => `${e.from}:${e.specifier}`)))
      bad("Duplicate dependency edge");
    for (const o of c.runtime.operations) if (!c.runtime.files.includes(o.module)) bad("Unknown operation module");
    for (const d of c.decoders)
      if (!c.runtime.operations.some((o) => o.id === d.operationId) || !artifacts.has(d.module)) bad("Unknown decoder");
    if (c.decoders.length !== c.runtime.operations.length) bad("Every operation needs a trusted decoder");
    for (const o of c.oracles)
      if (!o.files.includes(o.entry) || o.files.some((f) => !artifacts.has(f)) || !unique(o.files))
        bad("Missing oracle closure");
    for (const x of c.checks)
      if (!c.oracles.some((o) => o.oracleId === x.oracleId) || !unique(x.expectedCaseIds)) bad("Invalid check");
    for (const o of c.oracles)
      if (o.kind === "vitest-proxy" && (!o.root || !c.dependencies.some((d) => d.id === o.dependencyId)))
        bad("Vitest requires a measured dependency closure and root");
    if (
      !unique(c.proxies.map((p) => p.path)) ||
      c.proxies.some(
        (p) => !p.path.endsWith(".js") || !c.runtime.operations.some((o) => o.id === p.operationId && o.kind === p.kind)
      )
    )
      bad("Invalid proxy registry");
    for (const p of c.profiles)
      if (!unique(p.checkIds) || p.checkIds.some((id) => !c.checks.some((x) => x.checkId === id)))
        bad("Invalid profile");
    if (!c.profiles.some((p) => p.profileId === c.finalProfileId)) bad("Unknown final profile");
    if (c.limits.callTimeoutMs > c.limits.checkTimeoutMs) bad("Call limit exceeds check limit");
    if (c.runtime.builtins.some((b) => !c.runtime.files.includes(b.from))) bad("Unknown builtin source");
    if (
      Object.keys(c.image.files).length === 0 ||
      Object.keys(c.image.files).some((p) => !/^\/opt\/validator\/[a-z-]+\.(mjs|json)$/.test(p))
    )
      bad("Invalid image program registry");
  });
export type TrustedCheckConfig = Readonly<z.infer<typeof Schema>>;
export function freezeTrustedCheckConfig(input: unknown): TrustedCheckConfig {
  // Roundtrip also rejects cyclic data, undefined parameters, and non-JSON host objects.
  const parsed = Schema.parse(input);
  const plain = JSON.parse(JSON.stringify(parsed)) as unknown;
  return freezeSyncValue(Schema.parse(plain)) as TrustedCheckConfig;
}
export function configurationHash(config: TrustedCheckConfig): string {
  return hashJson({ version: "agent-sync-check-configuration-v1", config });
}
export function runtimeProjection(config: TrustedCheckConfig) {
  return freezeSyncValue({ ...config.runtime, limits: config.limits });
}
export function selectedChecks(config: TrustedCheckConfig, ids: readonly string[]): string[] {
  if (!ids.length || !unique(ids) || ids.some((id) => !config.checks.some((c) => c.checkId === id)))
    throw new Error("AGENT_SYNC_CHECK_SELECTION");
  // The core already selected a deterministic order from frozen profiles.
  // Reordering here would make a valid multi-check publication reject itself.
  return [...ids];
}
export function validateProjectChecks(config: TrustedCheckConfig, project: AgentSyncProject): void {
  if (
    configurationHash(config) !== project.checkConfigurationHash ||
    hashJson(config.profiles) !== hashJson(project.profiles) ||
    config.finalProfileId !== project.finalProfileId
  )
    throw new Error("AGENT_SYNC_CHECK_CONFIGURATION");
  if (
    config.runtime.files.some((path) => !project.manifest.some((e) => e.path === path)) ||
    config.runtime.builtins.some((b) => !project.manifest.some((e) => e.path === b.from && e.access === "read-only"))
  )
    throw new Error("AGENT_SYNC_CHECK_MANIFEST");
}
