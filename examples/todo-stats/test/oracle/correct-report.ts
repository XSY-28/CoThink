import type { NormalizedTask } from "../../src/types.js";

/** Independent host reference for T-B1. It never calls the normalizer. */
export function renderReport(tasks: NormalizedTask[]): string {
  return `total: ${tasks.length}\npending: ${tasks.filter((task) => task.state === "pending").length}\ndone: ${tasks.filter((task) => task.state === "done").length}\ncancelled: ${tasks.filter((task) => task.state === "cancelled").length}\n`;
}
