import { describe, expect, it } from "vitest";
import { runCoThink } from "../src/index.js";

describe("agent-sync command boundary", () => {
  it("exposes the integration and rejects missing explicit inputs before model dispatch", async () => {
    const logs: string[] = [],
      errors: string[] = [];
    let calls = 0;
    const dependencies = {
      env: {},
      transport: {
        respond: async () => {
          calls++;
          throw Error("unexpected");
        }
      }
    };
    await runCoThink(["help"], { log: (s) => logs.push(s), error: (s) => errors.push(s) }, dependencies);
    expect(logs.join("\n")).toContain("build sync");
    expect(
      await runCoThink(["build", "sync", "start"], { log: () => {}, error: (s) => errors.push(s) }, dependencies)
    ).toEqual({ ok: false, code: 1 });
    expect(calls).toBe(0);
    expect(errors).toContain("SYNC_ARGUMENT_INVALID");
  });
});
