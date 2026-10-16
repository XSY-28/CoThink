import { describe, expect, it } from "vitest";
import { normalizeTasks, oldTask } from "./harness.js";

describe("state-format", () => {
  it("status is accepted and takes priority over done", () => {
    for (const state of ["pending", "done", "cancelled"] as const) {
      for (const done of [true, false, "ignored"]) {
        expect(normalizeTasks([{ ...oldTask, status: state, done }])).toEqual([
          { id: oldTask.id, title: oldTask.title, state }
        ]);
      }
      expect(normalizeTasks([{ id: oldTask.id, title: oldTask.title, status: state }])[0]?.state).toBe(state);
    }
  });
  it("invalid status cannot fall back to a valid done", () => {
    for (const status of ["unknown", "DONE", null, 1, false, ""]) {
      expect(() => normalizeTasks([{ ...oldTask, status }])).toThrow();
    }
  });
  it("old done remains strict when status is absent", () => {
    for (const done of ["true", null, 0]) expect(() => normalizeTasks([{ ...oldTask, done }])).toThrow();
    expect(normalizeTasks([{ ...oldTask, done: true }])[0]?.state).toBe("done");
  });
});
