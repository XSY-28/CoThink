import type { NormalizedTask } from "./types.js";

/** V0 only: T-B1's four-field report remains unimplemented. */
export function renderReport(tasks: NormalizedTask[]): string {
  return `total: ${tasks.length}\n`;
}
