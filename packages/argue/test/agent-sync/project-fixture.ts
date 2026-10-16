import * as api from "../../src/agent-sync/project/index.js";
import { sha256 } from "../../src/peer/hash.js";
const version = "a".repeat(40);
export function projectState(count = 3) {
  return api.createAgentSyncState({
    project: api.freezeAgentSyncProject({
      projectVersion: api.AGENT_SYNC_PROJECT_VERSION,
      projectKey: "project",
      memberIds: Array.from({ length: count }, (_, i) => `custom${i}`),
      manifest: [
        { path: "shared.ts", access: "writable", contentHash: null },
        { path: "other.ts", access: "writable", contentHash: null }
      ],
      tasks: Array.from({ length: count }, (_, i) => ({
        taskId: `task${i}`,
        workerId: `custom${i}`,
        scope: { read: [], write: [i === 2 ? "other.ts" : "shared.ts"] },
        dependsOn: [],
        checkProfileId: "quality"
      })),
      profiles: [{ profileId: "quality", checkIds: ["types"] }],
      finalProfileId: "quality",
      checkConfigurationHash: sha256("config")
    }),
    runId: "run",
    acceptedVersion: version,
    now: 1000
  });
}
export const control = (operation: "reserve" | "cancel", index: number, requestId = `${operation}${index}`) => ({
  requestVersion: api.AGENT_SYNC_REQUEST_VERSION,
  operation,
  requestId,
  ownerEpoch: 1,
  taskId: `task${index}`,
  workerId: `custom${index}`
});
export const allocate = ({ taskId, leaseEpoch }: { taskId: string; leaseEpoch: number }) => ({
  attemptId: `${taskId}-${leaseEpoch}`,
  token: `token-${taskId}-${leaseEpoch}`
});
