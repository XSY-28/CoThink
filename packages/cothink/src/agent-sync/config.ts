import { z } from "zod";
import { isAbsolute } from "node:path";
import {
  FrozenAgentSyncProjectSchema,
  SyncIdSchema,
  SyncHashSchema,
  hashJson
} from "@onevcat/argue/agent-sync/project";
import type { AgentSyncProject } from "@onevcat/argue/agent-sync/project";
import { parseDiscussionConfig } from "../../../argue-cli/src/discussion/config.js";
import { validateModelCall } from "../../../argue-cli/src/runtime/model-api.js";
import type { ModelProfile } from "./types.js";
const positive = z.number().int().positive().safe();
const absolute = z.string().refine(isAbsolute);
export const integrationSchema = z
  .object({
    integrationVersion: z.literal("cothink-agent-sync-v1"),
    toolEntry: absolute,
    jobFile: absolute,
    members: z.record(SyncIdSchema, z.enum(["member-a", "member-b"])),
    instructions: z.record(SyncIdSchema, z.string().min(1).max(100000)),
    budget: z
      .object({
        maxCalls: positive.max(1000),
        maxOutputTokensPerCall: positive.max(65536),
        maxAllocatedOutputTokens: positive,
        maxDurationMs: positive.max(2700000),
        callTimeoutMs: positive.max(300000)
      })
      .strict()
  })
  .strict();
export type Integration = z.infer<typeof integrationSchema>;
export const jobSchema = z
  .object({
    options: z
      .object({
        project: FrozenAgentSyncProjectSchema,
        workspaceRoot: absolute,
        runId: SyncIdSchema,
        sourceRoot: absolute.optional()
      })
      .passthrough(),
    connections: z.record(
      SyncIdSchema,
      z.union([z.object({ role: z.literal("host") }).strict(), z.object({ workerId: SyncIdSchema }).strict()])
    )
  })
  .strict();
export type Job = z.infer<typeof jobSchema>;
export function bindings(job: Job, integration: Integration) {
  const project = job.options.project;
  const exact = (a: string[], b: readonly string[]) => a.sort().join("\0") === [...b].sort().join("\0");
  if (
    !exact(Object.keys(integration.members), project.memberIds) ||
    !exact(
      Object.keys(integration.instructions),
      project.tasks.map((t) => t.taskId)
    )
  )
    throw Error("SYNC_BINDING_INVALID");
  const entries = Object.entries(job.connections);
  const admin = entries.find(([, b]) => "role" in b)?.[0];
  const workers = Object.fromEntries(
    project.memberIds.map((worker) => {
      const matching = entries.filter(([, b]) => "workerId" in b && b.workerId === worker);
      if (matching.length !== 1) throw Error("SYNC_BINDING_INVALID");
      return [worker, matching[0]![0]];
    })
  );
  if (!admin || entries.some(([, b]) => "workerId" in b && !project.memberIds.includes(b.workerId)))
    throw Error("SYNC_BINDING_INVALID");
  return { admin, workers };
}
export function modelProfiles(
  raw: unknown,
  project: AgentSyncProject,
  integration: Integration
): Record<string, ModelProfile> {
  const config = parseDiscussionConfig(raw);
  return Object.fromEntries(
    project.memberIds.map((worker) => {
      const { id: _id, ...profile } = config.members[integration.members[worker]!]!;
      void _id;
      const { maxInputCharacters: _limit, ...call } = profile;
      void _limit;
      validateModelCall({ ...call, messages: [], maxOutputTokens: integration.budget.maxOutputTokensPerCall });
      return [worker, { ...profile, maxInputCharacters: profile.maxInputCharacters ?? 120000 }];
    })
  );
}
export const modelSchema = z
  .object({
    protocol: z.string(),
    baseUrl: z.string().url(),
    modelId: z.string(),
    apiKeyEnv: z.string(),
    outputMode: z.enum(["json_object", "prompt_json"]),
    generationOptions: z.record(z.unknown()),
    maxInputCharacters: positive
  })
  .strict();
export const snapshotSchema = z
  .object({
    version: z.literal("cothink-agent-sync-run-v1"),
    integration: integrationSchema,
    job: jobSchema,
    models: z.record(modelSchema),
    deadlineAt: positive,
    envFile: absolute.optional(),
    toolHash: SyncHashSchema,
    snapshotHash: SyncHashSchema
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export function parseSnapshot(raw: unknown): Snapshot {
  const snapshot = snapshotSchema.parse(raw),
    { snapshotHash, ...body } = snapshot;
  if (snapshotHash !== hashJson(body)) throw Error("SYNC_SNAPSHOT_CHANGED");
  bindings(snapshot.job, snapshot.integration);
  return snapshot;
}
