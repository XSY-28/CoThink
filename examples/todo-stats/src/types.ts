/** Frozen host contract. Worker tasks only change normalize.ts or report.ts. */
export interface NormalizedTask {
  id: number;
  title: string;
  state: "pending" | "done" | "cancelled";
}
