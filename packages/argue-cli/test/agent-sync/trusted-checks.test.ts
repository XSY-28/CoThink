import { describe, it, expect } from "vitest";
import {
  freezeTrustedCheckConfig,
  configurationHash,
  runtimeProjection,
  validateProjectChecks
} from "../../src/agent-sync/checks/config.js";
import { freezeAgentSyncProject } from "@onevcat/argue/agent-sync/project";
import { configInput } from "./trusted-checks-fixture.js";
const hash = `sha256:${"a".repeat(64)}`;
describe("trusted checks configuration", () => {
  it("copies/freezes complete config and mounts only public runtime/limits", () => {
    const input = configInput();
    const config = freezeTrustedCheckConfig(input);
    input.checks[0]!.expectedCaseIds.push("changed");
    expect(config.checks[0]!.expectedCaseIds).toEqual(["result"]);
    expect(Object.isFrozen(config.checks[0])).toBe(true);
    expect(JSON.stringify(runtimeProjection(config))).not.toMatch(/oracle|expected|caseIds|decoder|socket|parameters/);
    expect(configurationHash(config)).not.toBe(
      configurationHash(
        freezeTrustedCheckConfig({
          ...configInput(),
          checks: [{ ...configInput().checks[0]!, parameters: { expected: 4 } }]
        })
      )
    );
  });
  it.each(["command", "shell", "passed"])("rejects extra %s authority", (key) =>
    expect(() => freezeTrustedCheckConfig({ ...configInput(), [key]: true })).toThrow()
  );
  it("rejects unknown checks, duplicate identities, edges escaping declared files and decoder omissions", () => {
    const a = configInput();
    a.profiles[0]!.checkIds = ["missing"];
    expect(() => freezeTrustedCheckConfig(a)).toThrow();
    const b = configInput();
    b.checks.push(b.checks[0]!);
    expect(() => freezeTrustedCheckConfig(b)).toThrow();
    const c = configInput();
    Object.assign(c.runtime, {
      runtimeModules: [{ from: "lib/value.ts", specifier: "../../evil.js", to: "lib/value.ts" }]
    });
    expect(() => freezeTrustedCheckConfig(c)).toThrow();
    const d = configInput();
    d.decoders = [];
    expect(() => freezeTrustedCheckConfig(d)).toThrow();
  });
  it("binds project manifest, exact profile registry and final mapping without a hash cycle", () => {
    const config = freezeTrustedCheckConfig(configInput());
    const input = {
      projectVersion: "agent-sync-project-v1",
      projectKey: "test",
      memberIds: ["author"],
      manifest: [{ path: "lib/value.ts", access: "writable", contentHash: null }],
      tasks: [
        {
          taskId: "change",
          workerId: "author",
          scope: { read: [], write: ["lib/value.ts"] },
          dependsOn: [],
          checkProfileId: "full"
        }
      ],
      profiles: config.profiles,
      finalProfileId: "full",
      checkConfigurationHash: configurationHash(config)
    };
    expect(() => validateProjectChecks(config, freezeAgentSyncProject(input))).not.toThrow();
    expect(() =>
      validateProjectChecks(config, freezeAgentSyncProject({ ...input, checkConfigurationHash: hash }))
    ).toThrow();
    expect(() =>
      validateProjectChecks(
        config,
        freezeAgentSyncProject({ ...input, profiles: [{ profileId: "full", checkIds: ["other"] }] })
      )
    ).toThrow();
  });
});
