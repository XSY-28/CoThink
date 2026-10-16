import { BUILD_RESULT_VERSION, freezeBuildValue, type BuildReadonly, type BuildCoordination } from "./contracts.js";
import { parseBuildState, type BuildState } from "./state.js";

export type BuildResult = BuildReadonly<{
  resultVersion: typeof BUILD_RESULT_VERSION;
  runId: string;
  planHash: string;
  status: "completed" | "incomplete" | "cancelled";
  acceptedVersion: string;
  tasks: { taskId: string; status: BuildCoordination["taskStates"][string]; reason: string }[];
  budget: { calls: number; allocatedOutputTokens: number; maxCalls: number; maxAllocatedOutputTokens: number };
  recovery: string;
}>;

/** Deliberately project public fields rather than redact the durable host state. */
export function buildResult(input: BuildState, reasons: Readonly<Record<string, string>> = {}): BuildResult {
  const state = parseBuildState(input);
  return freezeBuildValue({
    resultVersion: BUILD_RESULT_VERSION,
    runId: state.runId,
    planHash: state.plan.planHash,
    status: state.status === "completed" ? "completed" : state.status === "cancelled" ? "cancelled" : "incomplete",
    acceptedVersion: state.acceptedVersion,
    tasks: state.plan.tasks.map((task) => {
      const status = state.coordination.taskStates[task.taskId]!;
      return {
        taskId: task.taskId,
        status,
        reason: Object.hasOwn(reasons, task.taskId) ? reasons[task.taskId]! : status
      };
    }),
    budget: {
      calls: state.calls.length,
      allocatedOutputTokens: state.calls.reduce((total, call) => total + call.allocatedOutputTokens, 0),
      maxCalls: state.plan.budget.maxCalls,
      maxAllocatedOutputTokens: state.plan.budget.maxAllocatedOutputTokens
    },
    recovery:
      state.status === "completed"
        ? "No recovery required."
        : state.status === "cancelled"
          ? "Cancelled; no automatic retry."
          : "Recover host state without model calls; retry paused tasks explicitly. Unknown calls retain their allocation."
  });
}
