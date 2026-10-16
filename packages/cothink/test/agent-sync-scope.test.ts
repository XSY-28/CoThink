import { expect, it } from "vitest";
import { acquireTask } from "../src/agent-sync/scope-client.js";
import { createClient } from "../../../tools/agent-sync/client.mjs";
it("retrieves a queued lease granted between currentLease and requestScope without replacing it", async () => {
  const methods: string[] = [];
  let currentQueries = 0;
  const client = createClient(async (raw) => {
    const request = raw as { method: string; params: Record<string, unknown> };
    methods.push(request.method);
    if (request.method === "currentLease") {
      currentQueries++;
      return currentQueries === 1
        ? { ok: true, result: { current: false } }
        : {
            ok: true,
            result: { current: true },
            capability: "already-granted",
            leaseContext: { attemptId: "same-attempt", ownerEpoch: 1, leaseEpoch: 1 }
          };
    }
    if (request.method === "requestScope")
      return { ok: true, result: { kind: "rejected", code: "task_already_active" } };
    expect(request.params.capability).toBe("already-granted");
    return { ok: true, result: {} };
  });
  const granted = await acquireTask(client, "queued", "scope-request");
  await granted.task!.runAction({ kind: "finish" }, "finish");
  expect(methods).toEqual(["currentLease", "requestScope", "currentLease", "finish"]);
  expect(granted.task!.descriptor().attemptId).toBe("same-attempt");
});
