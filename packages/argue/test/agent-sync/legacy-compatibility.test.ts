import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { legacyTrace } from "./legacy-trace-fixture.js";
test("legacy serialized states, results and request hashes match the pre-extraction source exactly", () => {
  const expected: unknown = JSON.parse(readFileSync(new URL("./legacy-trace-golden.json", import.meta.url), "utf8"));
  expect(legacyTrace()).toEqual(expected);
});
