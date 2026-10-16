import { describe, expect, it } from "vitest";
import { normalizeTasks, oldTask } from "./harness.js";

describe("identity", () => {
  it("trims only outer title whitespace and preserves order and ids", () => {
    expect(
      normalizeTasks([
        { ...oldTask, id: 21, title: " \t甲 内 部\n" },
        { ...oldTask, id: 11 }
      ])
    ).toEqual([
      { id: 21, title: "甲 内 部", state: "pending" },
      { id: 11, title: oldTask.title, state: "pending" }
    ]);
  });
  it("rejects blank titles one condition at a time", () => {
    for (const title of ["", " \t\n", "\u3000"]) expect(() => normalizeTasks([{ ...oldTask, title }])).toThrow();
  });
  it("requires positive integer ids and batch uniqueness", () => {
    for (const id of [0, -1, 1.5, NaN, Infinity]) expect(() => normalizeTasks([{ ...oldTask, id }])).toThrow();
    expect(() => normalizeTasks([oldTask, { ...oldTask, title: "different" }])).toThrow();
    expect(() =>
      normalizeTasks([
        { ...oldTask, id: 2 },
        { ...oldTask, id: 3 },
        { ...oldTask, id: 2 }
      ])
    ).toThrow();
  });
});
