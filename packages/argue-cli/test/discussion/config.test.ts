import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeDiscussionPolicy } from "@onevcat/argue";
import { loadDiscussionConfig, parseDiscussionConfig } from "../../src/discussion/config.js";

const members = { "member-a": { profile: "deepseek" }, "member-b": { profile: "glm" } };
const weights = {
  "member-a": { participationWeight: 1, decisionWeight: 1 },
  "member-b": { participationWeight: 1, decisionWeight: 1 }
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("loads v2 presets and default policy while leaving effort-derived resource caps composable", () => {
  const config = parseDiscussionConfig({ configVersion: 2, members });
  expect(config).toMatchObject({ configVersion: 2, discussion: { effort: "standard", weights } });
  expect(config.members["member-a"].modelId).toBe("deepseek-flash");
  expect(config.members["member-b"].modelId).toBe("glm-5.3-flash");
  expect(Object.keys(config.discussion).sort()).toEqual(["effort", "weights"]);
  const high = normalizeDiscussionPolicy({ ...config.discussion, effort: "high" }, Object.keys(config.members));
  expect(high.maxCalls).toBe(26);
  expect(high.maxAllocatedOutputTokens).toBe(262144);
});

it.each([undefined, 1])("applies defaults to legacy version %s without writing the source file", async (version) => {
  const root = await mkdtemp(join(tmpdir(), "discussion-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  const content = JSON.stringify({ ...(version === undefined ? {} : { configVersion: version }), members });
  await writeFile(path, content);
  expect(await loadDiscussionConfig(path)).toMatchObject({
    configVersion: 2,
    discussion: { effort: "standard", weights }
  });
  expect(await readFile(path, "utf8")).toBe(content);
});

it("preserves explicit limits and independent weights and resolves supplied model environment values", () => {
  const config = parseDiscussionConfig(
    {
      configVersion: 2,
      members: { ...members, "member-a": { profile: "deepseek", modelEnv: "CUSTOM_MODEL" } },
      discussion: {
        effort: "high",
        weights: { "member-a": { participationWeight: 2 }, "member-b": { decisionWeight: 3 } },
        maxRounds: 5,
        maxCalls: 20,
        maxAllocatedOutputTokens: 200000,
        maxDurationMs: 500000,
        callTimeoutMs: 50000
      }
    },
    { CUSTOM_MODEL: "custom-model" }
  );
  expect(config.members["member-a"].modelId).toBe("custom-model");
  expect(config.discussion).toEqual({
    effort: "high",
    weights: {
      "member-a": { participationWeight: 2, decisionWeight: 1 },
      "member-b": { participationWeight: 1, decisionWeight: 3 }
    },
    maxRounds: 5,
    maxCalls: 20,
    maxAllocatedOutputTokens: 200000,
    maxDurationMs: 500000,
    callTimeoutMs: 50000
  });
});

it.each([
  { configVersion: 3, members },
  { configVersion: "2", members },
  { configVersion: null, members },
  { configVersion: undefined, members },
  { members, discussion: {} },
  { configVersion: 1, members, discussion: {} },
  { configVersion: 2, members, extra: "INTERNAL_DISCUSSION_SENTINEL" },
  { configVersion: 2, members: { ...members, third: {} } },
  { configVersion: 2, members: { "member-a": members["member-a"] } },
  { configVersion: 2, members, discussion: null },
  { configVersion: 2, members, discussion: { policyVersion: "discussion-policy-v1" } },
  { configVersion: 2, members, discussion: { effort: "INTERNAL_DISCUSSION_SENTINEL" } },
  { configVersion: 2, members, discussion: { weights: { "member-a": {} } } },
  { configVersion: 2, members, discussion: { weights: { ...weights, unknown: {} } } },
  { configVersion: 2, members, discussion: { weights: { ...weights, "member-a": { participationWeight: 0 } } } },
  { configVersion: 2, members, discussion: { maxCalls: 19 } },
  { configVersion: 2, members, discussion: { maxRounds: 0 } },
  { configVersion: 2, members, discussion: { maxDurationMs: 100, callTimeoutMs: 101 } },
  { configVersion: 2, members: { ...members, "member-a": { profile: "deepseek", apiKey: "SECRET_KEY_SENTINEL" } } },
  { configVersion: 2, members: { ...members, "member-a": { profile: "INTERNAL_DISCUSSION_SENTINEL" } } }
])("rejects malformed/unknown configuration safely: %#", (raw) => {
  let thrown: unknown;
  try {
    parseDiscussionConfig(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).not.toMatch(/SENTINEL|SECRET_KEY|issues|unrecognized_keys/);
});

it("does not include invalid JSON source or filesystem details in load errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "discussion-config-"));
  roots.push(root);
  const path = join(root, "SECRET_KEY_SENTINEL.json");
  await writeFile(path, '{ "SECRET_KEY_SENTINEL": INTERNAL_DISCUSSION_SENTINEL }');
  await expect(loadDiscussionConfig(path)).rejects.toThrow();
  await expect(loadDiscussionConfig(path)).rejects.not.toThrow(/SENTINEL/);
  await expect(loadDiscussionConfig(join(root, "SECRET_KEY_SENTINEL-missing.json"))).rejects.not.toThrow(/SENTINEL/);
});
