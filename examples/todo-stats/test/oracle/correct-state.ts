import type { NormalizedTask } from "../../src/types.js";

/** Host reference for T-A only. Never an Agent construction result. */
export function normalizeTasks(input: unknown): NormalizedTask[] {
  if (!Array.isArray(input)) throw new Error("E_INPUT");
  return input.map((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("E_INPUT");
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "number" || !Number.isFinite(item.id) || typeof item.title !== "string")
      throw new Error("E_INPUT");
    let state: NormalizedTask["state"];
    if (Object.hasOwn(item, "status")) {
      if (item.status !== "pending" && item.status !== "done" && item.status !== "cancelled")
        throw new Error("E_INPUT");
      state = item.status;
    } else {
      if (typeof item.done !== "boolean") throw new Error("E_INPUT");
      state = item.done ? "done" : "pending";
    }
    return { id: item.id, title: item.title, state };
  });
}
