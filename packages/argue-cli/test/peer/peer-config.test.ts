import { readFile } from "node:fs/promises";
import { buildMemberRequest, createPeerSession } from "@onevcat/argue";
import { describe, expect, it } from "vitest";
import { normalizePeerMembers } from "../../src/peer/config.js";

describe("peer provider configuration", () => {
  it("materializes both provider defaults and model environment overrides before session creation", () => {
    const members = normalizePeerMembers(
      { members: { "member-a": { profile: "deepseek" }, "member-b": { profile: "glm" } } },
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
          "member-a": { profile: "deepseek", outputMode: "prompt_json", generationOptions: { temperature: 0.4 } },
          "member-b": { profile: "glm", modelId: "glm-account-model" }
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
            "member-a": { profile: "deepseek", generationOptions: { maxRetries: 4 } },
            "member-b": { profile: "glm" }
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
          "member-a": { profile: "deepseek" },
          "member-b": { profile: "glm", generationOptions: { reasoning_effort: "high" } }
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
            "member-a": { profile: "deepseek", modelEnv: "MY_MODEL" },
            "member-b": { profile: "glm" }
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
          "member-a": { profile: "deepseek", modelId: "deepseek-flash", modelEnv: "ACCOUNT_DEEPSEEK_MODEL" },
          "member-b": { profile: "glm" }
        }
      },
      { ACCOUNT_DEEPSEEK_MODEL: "next-account-model" }
    );
    expect(members["member-a"].modelId).toBe("next-account-model");
  });

  it("passes normalized members into the core session as its accepted member array", () => {
    const members = normalizePeerMembers(
      { members: { "member-a": { profile: "deepseek" }, "member-b": { profile: "glm" } } },
      {}
    );
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

const genericMember = { baseUrl: "https://example.com/v1", modelId: "account-model" };
const inputWithMember = (member: Record<string, unknown>) => ({
  members: { "member-a": member, "member-b": genericMember }
});

describe("generic peer configuration", () => {
  it("uses neutral OpenAI defaults for both slots without injecting provider tuning", () => {
    const members = normalizePeerMembers(
      { members: { "member-a": genericMember, "member-b": genericMember } },
      { DEEPSEEK_MODEL_ID: "vendor-a", GLM_MODEL_ID: "vendor-b" }
    );
    expect(members["member-a"]).toEqual({
      id: "member-a",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      modelId: "account-model",
      apiKeyEnv: "PEER_A_API_KEY",
      outputMode: "json_object",
      generationOptions: {}
    });
    expect(members["member-b"]).toEqual({
      id: "member-b",
      protocol: "openai-compatible",
      baseUrl: "https://example.com/v1",
      modelId: "account-model",
      apiKeyEnv: "PEER_B_API_KEY",
      outputMode: "json_object",
      generationOptions: {}
    });
  });

  it.each(["openai-compatible", "anthropic-compatible"])("accepts the generic %s profile", (profile) => {
    const members = normalizePeerMembers(inputWithMember({ ...genericMember, profile }), {});
    expect(members["member-a"].protocol).toBe(profile);
    expect(members["member-a"].generationOptions).toEqual({});
  });

  it("selects native Anthropic through protocol and defaults to prompt JSON", () => {
    const members = normalizePeerMembers(
      inputWithMember({ ...genericMember, protocol: "anthropic-compatible", generationOptions: { temperature: 0.4 } }),
      {}
    );
    expect(members["member-a"].protocol).toBe("anthropic-compatible");
    expect(members["member-a"].outputMode).toBe("prompt_json");
    expect(members["member-a"].generationOptions).toEqual({ temperature: 0.4 });
  });

  it("accepts matching profile and protocol", () => {
    expect(
      normalizePeerMembers(
        inputWithMember({ ...genericMember, profile: "anthropic-compatible", protocol: "anthropic-compatible" }),
        {}
      )["member-a"].protocol
    ).toBe("anthropic-compatible");
  });

  it.each([
    ["openai-compatible", "anthropic-compatible"],
    ["anthropic-compatible", "openai-compatible"],
    ["deepseek", "anthropic-compatible"],
    ["glm", "anthropic-compatible"]
  ])("rejects profile %s with conflicting protocol %s", (profile, protocol) => {
    expect(() => normalizePeerMembers(inputWithMember({ ...genericMember, profile, protocol }), {})).toThrow(
      /profile.*protocol/iu
    );
  });

  it.each([
    {},
    { modelId: "model" },
    { baseUrl: "https://example.com/v1" },
    { baseUrl: "https://example.com/v1", modelEnv: "UNSET_MODEL" }
  ])("rejects incomplete neutral configuration %j", (member) => {
    expect(() => normalizePeerMembers(inputWithMember(member), {})).toThrow();
  });

  it("rejects a blank model ID", () => {
    expect(() => normalizePeerMembers(inputWithMember({ ...genericMember, modelId: "  " }), {})).toThrow();
  });

  it("uses only an explicitly configured model environment variable", () => {
    const members = normalizePeerMembers(
      inputWithMember({ baseUrl: "https://example.com/v1", modelEnv: "ACCOUNT_MODEL" }),
      { ACCOUNT_MODEL: "  environment-model  " }
    );
    expect(members["member-a"].modelId).toBe("environment-model");
  });

  it("lets explicit modelEnv override modelId but falls back to modelId when unset", () => {
    const input = inputWithMember({ ...genericMember, modelEnv: "ACCOUNT_MODEL" });
    expect(normalizePeerMembers(input, { ACCOUNT_MODEL: "new-model" })["member-a"].modelId).toBe("new-model");
    expect(normalizePeerMembers(input, { ACCOUNT_MODEL: "  " })["member-a"].modelId).toBe("account-model");
  });

  it("keeps an explicit preset modelId ahead of its default environment variable", () => {
    const members = normalizePeerMembers(inputWithMember({ profile: "deepseek", modelId: "explicit-model" }), {
      DEEPSEEK_MODEL_ID: "default-env-model"
    });
    expect(members["member-a"].modelId).toBe("explicit-model");
  });

  it("rejects Anthropic JSON-object mode before a request can be constructed", () => {
    expect(() =>
      normalizePeerMembers(
        inputWithMember({ ...genericMember, profile: "anthropic-compatible", outputMode: "json_object" }),
        {}
      )
    ).toThrow(/prompt_json/u);
  });

  it.each([
    "file:///tmp/model",
    "ftp://example.com",
    "https://name:password@example.com/v1",
    "https://name@example.com/v1",
    "https://@example.com/v1",
    " https://example.com/v1",
    "https:example.com",
    "https://example.com/ space"
  ])("rejects unsafe endpoint %s", (baseUrl) => {
    expect(() => normalizePeerMembers(inputWithMember({ ...genericMember, baseUrl }), {})).toThrow();
  });

  it("accepts an explicit local HTTP endpoint", () => {
    expect(
      normalizePeerMembers(inputWithMember({ ...genericMember, baseUrl: "http://127.0.0.1:8080/v1" }), {})["member-a"]
        .baseUrl
    ).toBe("http://127.0.0.1:8080/v1");
  });

  it.each(["apiKeyEnv", "modelEnv"])("validates %s as an environment variable name", (field) => {
    for (const value of ["", "  KEY  ", "1KEY", "API-KEY", "KEY=secret", "KEY\nVALUE"]) {
      expect(() => normalizePeerMembers(inputWithMember({ ...genericMember, [field]: value }), {})).toThrow();
    }
    expect(
      normalizePeerMembers(inputWithMember({ ...genericMember, [field]: "_ACCOUNT_KEY2" }), { _ACCOUNT_KEY2: "model" })[
        "member-a"
      ].apiKeyEnv
    ).toBe(field === "apiKeyEnv" ? "_ACCOUNT_KEY2" : "PEER_A_API_KEY");
  });

  it("rejects raw API keys and nested credential/transport overrides", () => {
    expect(() => normalizePeerMembers(inputWithMember({ ...genericMember, apiKey: "test-secret" }), {})).toThrow();
    expect(() =>
      normalizePeerMembers(
        inputWithMember({ ...genericMember, generationOptions: { nested: { api_key: "test-secret" } } }),
        {}
      )
    ).toThrow();
  });

  it("rejects disabling the explicit GLM thinking preset", () => {
    expect(() =>
      normalizePeerMembers(
        inputWithMember({ profile: "glm", generationOptions: { thinking: { type: "disabled" } } }),
        {}
      )
    ).toThrow(/thinking enabled/u);
  });

  it("freezes generic Anthropic settings into a session request", () => {
    const members = normalizePeerMembers(inputWithMember({ ...genericMember, profile: "anthropic-compatible" }), {});
    const session = createPeerSession(
      {
        sessionId: "generic-config-integration",
        schemaVersion: 1,
        question: "Should we use a local file?",
        sourceCommit: "smoke-local",
        createdAt: "2026-10-13T00:00:00.000Z",
        members: Object.values(members)
      },
      []
    );
    const request = buildMemberRequest(session, "member-a");
    expect(request.protocol).toBe("anthropic-compatible");
    expect(request.modelId).toBe("account-model");
    expect(request.outputMode).toBe("prompt_json");
    expect(request.generationOptions).toEqual({});
  });

  it("loads the public generic example without provider-specific defaults", async () => {
    const example = JSON.parse(
      await readFile(new URL("../../examples/peer/generic.config.example.json", import.meta.url), "utf8")
    );
    const members = normalizePeerMembers(example, {});
    expect(members["member-a"].protocol).toBe("openai-compatible");
    expect(members["member-b"].protocol).toBe("anthropic-compatible");
    expect(members["member-a"].generationOptions).toEqual({});
    expect(members["member-b"].generationOptions).toEqual({});
  });
});
