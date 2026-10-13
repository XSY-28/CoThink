import { buildMemberRequest, createPeerSession } from "@onevcat/argue";
import { describe, expect, it } from "vitest";
import { normalizePeerMembers } from "../../src/peer/config.js";

describe("peer provider configuration", () => {
  it("materializes both provider defaults and model environment overrides before session creation", () => {
    const members = normalizePeerMembers(
      { members: { "member-a": {}, "member-b": {} } },
      { DEEPSEEK_MODEL_ID: "account-deepseek", GLM_MODEL_ID: "account-glm" }
    );
    expect(members["member-a"]).toEqual({
      id: "member-a",
      protocol: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      modelId: "account-deepseek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      outputMode: "json_object",
      generationOptions: { thinking: { type: "disabled" } }
    });
    expect(members["member-b"]).toEqual({
      id: "member-b",
      protocol: "openai-compatible",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "account-glm",
      apiKeyEnv: "GLM_API_KEY",
      outputMode: "json_object",
      generationOptions: { thinking: { type: "enabled" }, reasoning_effort: "low" }
    });
  });

  it("accepts explicit prompt-json and tuning but rejects protected transport fields", () => {
    const members = normalizePeerMembers(
      {
        members: {
          "member-a": { outputMode: "prompt_json", generationOptions: { temperature: 0.4 } },
          "member-b": { modelId: "glm-account-model" }
        }
      },
      {}
    );
    expect(members["member-a"].generationOptions).toEqual({ temperature: 0.4, thinking: { type: "disabled" } });
    expect(members["member-a"].outputMode).toBe("prompt_json");
    expect(members["member-b"].modelId).toBe("glm-account-model");
    expect(() =>
      normalizePeerMembers(
        {
          members: {
            "member-a": { generationOptions: { maxRetries: 4 } },
            "member-b": {}
          }
        },
        {}
      )
    ).toThrow();
  });

  it("allows an explicit GLM reasoning effort override in a new session", () => {
    const members = normalizePeerMembers(
      {
        members: {
          "member-a": {},
          "member-b": { generationOptions: { reasoning_effort: "high" } }
        }
      },
      {}
    );
    expect(members["member-b"].generationOptions).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  });

  it("rejects an unset explicit model environment variable", () => {
    expect(() =>
      normalizePeerMembers(
        {
          members: {
            "member-a": { modelEnv: "MY_MODEL" },
            "member-b": {}
          }
        },
        {}
      )
    ).toThrow(/MY_MODEL/u);
  });

  it("lets an explicit model environment variable supersede the example model ID", () => {
    const members = normalizePeerMembers(
      {
        members: {
          "member-a": { modelId: "deepseek-flash", modelEnv: "ACCOUNT_DEEPSEEK_MODEL" },
          "member-b": {}
        }
      },
      { ACCOUNT_DEEPSEEK_MODEL: "next-account-model" }
    );
    expect(members["member-a"].modelId).toBe("next-account-model");
  });

  it("passes normalized members into the core session as its accepted member array", () => {
    const members = normalizePeerMembers({ members: { "member-a": {}, "member-b": {} } }, {});
    const session = createPeerSession(
      {
        sessionId: "config-integration",
        schemaVersion: 1,
        question: "Should we use a local file?",
        sourceCommit: "smoke-local",
        createdAt: "2026-10-13T00:00:00.000Z",
        members: Object.values(members)
      },
      []
    );
    const request = buildMemberRequest(session, "member-a");
    expect(request.modelId).toBe("deepseek-flash");
    expect(request.generationOptions).toEqual({ thinking: { type: "disabled" } });
  });
});
