import type { NormalizedTask } from "./types.js";

/** V0 only: legitimate legacy done inputs. T-A and T-B2 remain unimplemented. */
export function normalizeTasks(input: unknown): NormalizedTask[] {
  if (!Array.isArray(input)) throw new Error("E_INPUT");
  return input.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("E_INPUT");
    const task = item as Record<string, unknown>;
    if (
      typeof task.id !== "number" ||
      !Number.isFinite(task.id) ||
      typeof task.title !== "string" ||
      typeof task.done !== "boolean" ||
      Object.hasOwn(task, "status")
    )
      throw new Error("E_INPUT");
    return { id: task.id, title: task.title, state: task.done ? "done" : "pending" };
  });
}
