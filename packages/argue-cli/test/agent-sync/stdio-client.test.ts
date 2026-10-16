import { test, expect } from "vitest";
import { taskContext } from "../../../../tools/agent-sync/client.mjs";
test("narrow model actions cannot replace identity or context; each task object keeps its original capability", async () => {
  const calls: { method: string; params: { capability?: string }; requestId: string }[] = [];
  const client = {
    call: async (method: string, params: { capability?: string }, requestId: string) => {
      calls.push({ method, params, requestId });
      return { result: { ok: true } };
    }
  };
  const old = taskContext(client, { taskId: "task", capability: "old-cap" }),
    fresh = taskContext(client, { taskId: "task", capability: "new-cap" });
  await old.runAction({ kind: "inspect", path: "file.ts" }, "read-old");
  await fresh.runAction({ kind: "finish" }, "finish-new");
  expect(calls[0].params.capability).toBe("old-cap");
  expect(calls[1].params.capability).toBe("new-cap");
  await expect(old.runAction({ kind: "finish", ownerEpoch: 999 }, "injected")).rejects.toMatchObject({
    code: "wire_invalid_action"
  });
  expect(calls).toHaveLength(2);
});
test("check action seals then forwards existing check; it never supplies passed or a shell", async () => {
  const calls: [string, Record<string, unknown>, string][] = [];
  const task = taskContext(
    {
      call: async (method: string, params: Record<string, unknown>, requestId: string) => {
        calls.push([method, params, requestId]);
        return { result: { receipt: { passed: false } } };
      }
    },
    { taskId: "task", capability: "cap" }
  );
  await task.runAction({ kind: "check" }, "check-id");
  expect(calls.map((c) => c[0])).toEqual(["seal", "check"]);
  expect(calls[1][1]).toEqual({ taskId: "task", capability: "cap" });
});
