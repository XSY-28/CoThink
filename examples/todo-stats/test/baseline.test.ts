import { describe, expect, it } from "vitest";
import { cli, fixture, normalizeTasks, oldTask, renderReport, report } from "./harness.js";

describe("baseline/common", () => {
  it("legacy states, ids, titles and input order are preserved", () => {
    expect(normalizeTasks(fixture("legacy"))).toEqual([
      { id: 1, title: "买菜", state: "pending" },
      { id: 2, title: "写报告", state: "done" }
    ]);
    expect(normalizeTasks([{ ...oldTask, id: 7, done: true }, oldTask])).toEqual([
      { id: 7, title: oldTask.title, state: "done" },
      { id: 10, title: oldTask.title, state: "pending" }
    ]);
    expect(normalizeTasks([])).toEqual([]);
  });
  it("total includes every task and CLI wires normalizer to report", () => {
    for (const input of [fixture("legacy"), [], [oldTask]]) {
      const tasks = normalizeTasks(input);
      expect([`total: ${tasks.length}\n`, report(tasks)]).toContain(renderReport(tasks));
      expect(cli(JSON.stringify(input))).toEqual({ status: 0, stdout: renderReport(tasks), stderr: "" });
    }
  });
  it("invalid JSON and invalid old input fail atomically with fixed codes", () => {
    expect(cli("[broken")).toEqual({ status: 1, stdout: "", stderr: "E_JSON\n" });
    for (const input of [
      null,
      {},
      [null],
      [{ ...oldTask, done: "false" }],
      [{ ...oldTask, title: 9 }],
      [{ ...oldTask, id: "10" }],
      [{ id: 10, title: "ok" }],
      [oldTask, null]
    ]) {
      expect(() => normalizeTasks(input)).toThrow();
      expect(cli(JSON.stringify(input))).toEqual({ status: 1, stdout: "", stderr: "E_INPUT\n" });
    }
  });
});
