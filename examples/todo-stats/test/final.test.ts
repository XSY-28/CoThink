import { describe, expect, it } from "vitest";
import { cli, cliChunks, fixture, normalizeTasks, oldTask, report } from "./harness.js";

describe("final", () => {
  it("joint CLI produces 4/1/2/1 with trimmed normalized titles", () => {
    expect(normalizeTasks(fixture("mixed"))).toEqual(fixture("normalized"));
    expect(cli(JSON.stringify(fixture("mixed")))).toEqual({
      status: 0,
      stdout: "total: 4\npending: 1\ndone: 2\ncancelled: 1\n",
      stderr: ""
    });
  });
  it("handles empty, alternative distribution and reversed order", () => {
    const alternate = [
      { id: 12, title: " one ", status: "cancelled" },
      { id: 8, title: "two", done: false },
      { id: 7, title: "three", status: "pending" }
    ];
    for (const input of [[], alternate, [...alternate].reverse()]) {
      const tasks = normalizeTasks(input);
      expect(cli(JSON.stringify(input))).toEqual({ status: 0, stdout: report(tasks), stderr: "" });
      expect(tasks.map((task) => task.id)).toEqual(input.map((task) => task.id));
    }
  });
  it("CLI honors every status even with conflicting or nonboolean done", () => {
    for (const status of ["pending", "done", "cancelled"] as const) {
      for (const done of [true, false, "ignored"]) {
        const tasks = [{ id: 3, title: "keep", state: status }];
        expect(cli(JSON.stringify([{ id: 3, title: " keep ", status, done }]))).toEqual({
          status: 0,
          stdout: report(tasks),
          stderr: ""
        });
      }
    }
  });
  it("decodes UTF-8 across chunks before title validation", () => {
    const blankInput = JSON.stringify([{ id: 3, title: "\u3000", done: false }]);
    const blankByte = Buffer.from(blankInput).indexOf(Buffer.from("\u3000"));
    expect(cli(blankInput)).toEqual({ status: 1, stdout: "", stderr: "E_INPUT\n" });
    expect(cliChunks(blankInput, blankByte + 1)).toEqual({ status: 1, stdout: "", stderr: "E_INPUT\n" });
    const legalInput = JSON.stringify([{ id: 3, title: "买菜", done: false }]);
    const legalByte = Buffer.from(legalInput).indexOf(Buffer.from("买"));
    expect(cliChunks(legalInput, legalByte + 1)).toEqual({
      status: 0,
      stdout: "total: 1\npending: 1\ndone: 0\ncancelled: 0\n",
      stderr: ""
    });
  });
  it("fails entire batch on every single invalid condition", () => {
    const invalidCases = [
      ...(fixture("invalid") as unknown[]),
      null,
      [],
      true,
      ...["DONE", null, 1, false, ""].map((status) => ({ ...oldTask, id: 13, status })),
      ...[null, 0].map((done) => ({ ...oldTask, id: 13, done })),
      ...["3", null, true].map((id) => ({ ...oldTask, id })),
      { ...oldTask, id: 13, title: "" },
      { ...oldTask, id: 13, title: "\u3000" }
    ];
    for (const invalid of invalidCases) {
      expect(cli(JSON.stringify([oldTask, invalid]))).toEqual({ status: 1, stdout: "", stderr: "E_INPUT\n" });
    }
    expect(cli(JSON.stringify([oldTask, oldTask]))).toEqual({ status: 1, stdout: "", stderr: "E_INPUT\n" });
    expect(cli("null")).toEqual({ status: 1, stdout: "", stderr: "E_INPUT\n" });
    expect(cli("not JSON")).toEqual({ status: 1, stdout: "", stderr: "E_JSON\n" });
  });
});
