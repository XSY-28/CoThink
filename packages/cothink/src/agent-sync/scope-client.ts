import { randomUUID } from "node:crypto";
import type { Client } from "../../../../tools/agent-sync/client.mjs";
/** Acquisition only, before a model call. Never used to rebind a pending/late model response. */
export async function acquireTask(client: Client, taskId: string, requestId: string) {
  const current = async () => {
    const response = (await client.call("currentLease", { taskId }, randomUUID())) as {
      capability?: string;
      leaseContext?: Record<string, unknown>;
    };
    return response.capability
      ? {
          result: { kind: "granted" },
          task: client.restoreTask({ taskId, capability: response.capability, ...response.leaseContext })
        }
      : undefined;
  };
  const existing = await current();
  if (existing) return existing;
  const grant = await client.requestScope(taskId, requestId);
  // Another scope request may have drained the queue after the lookup above.
  if (!grant.task && grant.result.kind === "rejected" && grant.result.code === "task_already_active")
    return (await current()) ?? grant;
  return grant;
}
