import { z } from "zod";

export type SyncReadonly<T> = T extends readonly (infer U)[]
  ? readonly SyncReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: SyncReadonly<T[K]> }
    : T;
/** Only parsed JSON values are frozen; caller objects are never retained. */
export function freezeSyncValue<T>(value: T): SyncReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSyncValue(child);
    Object.freeze(value);
  }
  return value as SyncReadonly<T>;
}
export const SyncIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const SyncHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SyncVersionIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** Exact ASCII file names, no aliases, dot segments, metadata or absolute paths. */
export const SyncPathSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/)
  .refine((path) => path.split("/").every((segment) => !segment.endsWith(".")), "Noncanonical path");
/** z.record drops the own key __proto__; preserve exact declared file names safely. */
export const SyncContentHashesSchema = z.unknown().transform((input, ctx) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    ctx.addIssue({ code: "custom", message: "Expected an exact path/hash object" });
    return z.NEVER;
  }
  const parsed = z.array(z.tuple([SyncPathSchema, SyncHashSchema.nullable()])).safeParse(Object.entries(input));
  if (!parsed.success) {
    ctx.addIssue({ code: "custom", message: "Invalid content hash path or value" });
    return z.NEVER;
  }
  return Object.fromEntries(parsed.data) as Record<string, string | null>;
});
