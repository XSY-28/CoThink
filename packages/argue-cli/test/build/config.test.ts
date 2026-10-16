import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "vitest";
import { FrozenBuildPlanSchema } from "@onevcat/argue";
import { parseBuildConfig } from "../../src/build/config.js";

test("build configuration reuses profiles and keeps discussion weights out of permissions", async () => {
  const plan = FrozenBuildPlanSchema.parse(
    JSON.parse(await readFile(resolve("../../examples/todo-stats/build-plan.json"), "utf8"))
  );
  const models = parseBuildConfig(
    {
      configVersion: 2,
      members: {
        "member-a": { profile: "deepseek" },
        "member-b": { profile: "glm" }
      },
      discussion: {
        weights: {
          "member-a": { participationWeight: 99, decisionWeight: 1 },
          "member-b": { participationWeight: 1, decisionWeight: 99 }
        }
      }
    },
    plan
  );
  expect(Object.keys(models)).toEqual(["member-a", "member-b"]);
  expect(models["member-a"]?.modelId).toBe("deepseek-flash");
  expect(models["member-b"]?.modelId).toBe("glm-5.3-flash");
  expect(models["member-a"]).not.toHaveProperty("weights");
});

test("construction config requires version 2 and rejects arbitrary controls rather than importing discussion permissions", async () => {
  const plan = FrozenBuildPlanSchema.parse(
    JSON.parse(await readFile(resolve("../../examples/todo-stats/build-plan.json"), "utf8"))
  );
  for (const raw of [
    { members: { "member-a": { profile: "deepseek" }, "member-b": { profile: "glm" } } },
    { configVersion: 2, members: { "member-a": { profile: "deepseek", shell: true }, "member-b": { profile: "glm" } } },
    {
      configVersion: 2,
      members: { "member-a": { profile: "deepseek" }, "member-b": { profile: "glm" } },
      build: { maxCalls: 99999 }
    }
  ])
    expect(() => parseBuildConfig(raw, plan)).toThrow("BUILD_CONFIG_INVALID");
});
