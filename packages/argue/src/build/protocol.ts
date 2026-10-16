import { z } from "zod";
import { hashJson } from "../peer/hash.js";
import {
  BUILD_ACTION_VERSION,
  BuildHashSchema,
  BuildIdSchema,
  BuildMemberSchema,
  BuildPathSchema,
  FrozenBuildPlanSchema,
  freezeBuildValue,
  type BuildPlan,
  type BuildReadonly
} from "./contracts.js";

export const BuildActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspect"), path: BuildPathSchema }).strict(),
  z
    .object({
      kind: z.literal("edit"),
      path: BuildPathSchema,
      text: z.string(),
      expectedContentHash: BuildHashSchema.nullable()
    })
    .strict(),
  z.object({ kind: z.literal("check") }).strict(),
  z.object({ kind: z.literal("finish") }).strict(),
  z.object({ kind: z.literal("abort"), reason: z.string().min(1).max(2048) }).strict()
]);
export type BuildAction = BuildReadonly<z.infer<typeof BuildActionSchema>>;
export const BuildReplySchema = z
  .object({ actionVersion: z.literal(BUILD_ACTION_VERSION), requestId: BuildIdSchema, action: BuildActionSchema })
  .strict();
export type BuildReply = BuildReadonly<z.infer<typeof BuildReplySchema>>;
export const BuildRequestContextSchema = z
  .object({
    actionVersion: z.literal(BUILD_ACTION_VERSION),
    requestId: BuildIdSchema,
    attemptId: BuildIdSchema,
    taskId: BuildIdSchema,
    workerId: BuildMemberSchema,
    inputHash: BuildHashSchema,
    planHash: BuildHashSchema,
    ownerEpoch: z.number().int().positive().safe(),
    token: z.string().min(1).max(512)
  })
  .strict();
export type BuildRequestContext = BuildReadonly<z.infer<typeof BuildRequestContextSchema>>;
export type AuthorizedBuildAction = BuildRequestContext & {
  readonly action: BuildAction;
  readonly payloadHash: string;
};

/** Reject duplicate JSON keys before JSON.parse can silently discard authority fields. */
function parseUnambiguousJson(text: string): unknown {
  let cursor = 0;
  const space = () => {
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === "\\") cursor++;
      else if (char === '"') return JSON.parse(text.slice(start, cursor)) as string;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (): void => {
    space();
    const char = text[cursor];
    if (char === '"') {
      string();
      return;
    }
    if (char === "{" || char === "[") {
      const object = char === "{";
      cursor++;
      space();
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      if (text[cursor] === end) {
        cursor++;
        return;
      }
      while (cursor < text.length) {
        if (object) {
          space();
          if (text[cursor] !== '"') throw new Error("Invalid JSON key");
          const key = string();
          if (keys.has(key)) throw new Error("Duplicate JSON key");
          keys.add(key);
          space();
          if (text[cursor++] !== ":") throw new Error("Invalid JSON object");
        }
        value();
        space();
        const next = text[cursor++];
        if (next === end) return;
        if (next !== ",") throw new Error("Invalid JSON container");
      }
      throw new Error("Unterminated JSON container");
    }
    const start = cursor;
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor]!)) cursor++;
    if (cursor === start) throw new Error("Invalid JSON value");
    JSON.parse(text.slice(start, cursor));
  };
  value();
  space();
  if (cursor !== text.length) throw new Error("Trailing JSON content");
  return JSON.parse(text) as unknown;
}
/** Decode exactly one model reply; no Markdown extraction, commands or side effects. */
export function decodeBuildReply(raw: string, context: unknown): BuildReply {
  const request = BuildRequestContextSchema.parse(context);
  const reply = BuildReplySchema.parse(parseUnambiguousJson(raw));
  if (reply.requestId !== request.requestId) throw new Error("Frozen request ID mismatch");
  return freezeBuildValue(reply);
}
/** Static authorization only. Current token/epoch/deadline, replay and hash-CAS
 * must be revalidated by the later scheduler/workspace immediately before effects. */
export function authorizeBuildAction(plan: BuildPlan, context: unknown, input: unknown): AuthorizedBuildAction {
  const frozenPlan = FrozenBuildPlanSchema.parse(plan);
  const request = BuildRequestContextSchema.parse(context);
  const reply = BuildReplySchema.parse(input);
  if (request.planHash !== frozenPlan.planHash || request.requestId !== reply.requestId)
    throw new Error("Frozen request/plan mismatch");
  const task = frozenPlan.tasks.find((item) => item.taskId === request.taskId);
  if (!task || task.workerId !== request.workerId) throw new Error("Frozen task/worker mismatch");
  const action = reply.action;
  if (action.kind === "inspect" && ![...task.scope.read, ...task.scope.write].includes(action.path))
    throw new Error("Inspect outside exact scope");
  if (action.kind === "edit" && !task.scope.write.includes(action.path))
    throw new Error("Edit outside exact write scope");
  return freezeBuildValue({ ...request, action, payloadHash: hashJson({ requestId: reply.requestId, action }) });
}
