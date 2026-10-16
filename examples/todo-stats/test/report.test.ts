import type { NormalizedTask } from "../src/types.js";
import { describe, expect, it } from "vitest";
import { fixture, renderReport, report } from "./harness.js";

describe("report", () => {
  it("counts frozen normalized fixture in fixed order including cancelled", () => {
    const tasks = fixture("normalized") as NormalizedTask[];
    expect(renderReport(tasks)).toBe("total: 4\npending: 1\ndone: 2\ncancelled: 1\n");
  });
  it("counts empty and other distributions without normalizer", () => {
    for (const states of [
      [],
      ["pending"],
      ["done", "cancelled", "cancelled"],
      ["cancelled", "pending", "done", "pending", "pending"]
    ] as NormalizedTask["state"][][]) {
      const tasks = states.map((state, index) => ({ id: index + 21, title: `item ${index}`, state }));
      expect(renderReport(tasks)).toBe(report(tasks));
      expect(renderReport([...tasks].reverse())).toBe(report(tasks));
    }
  });
});
