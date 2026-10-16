import { expect, test } from "vitest";
import { selectedChecks, freezeTrustedCheckConfig } from "../../src/agent-sync/checks/config.js";
import { configInput } from "./trusted-checks-fixture.js";

test("trusted verifier preserves the frozen publication order instead of alphabetically reordering check IDs", () => {
  const base = configInput();
  const config = freezeTrustedCheckConfig({
    ...base,
    profiles: [{ profileId: "full", checkIds: ["zeta", "alpha"] }],
    checks: [
      { ...base.checks[0], checkId: "zeta" },
      { ...base.checks[0], checkId: "alpha" }
    ]
  });
  expect(selectedChecks(config, ["zeta", "alpha"])).toEqual(["zeta", "alpha"]);
  expect(() => selectedChecks(config, ["zeta", "zeta"])).toThrow("AGENT_SYNC_CHECK_SELECTION");
  expect(() => selectedChecks(config, ["missing"])).toThrow("AGENT_SYNC_CHECK_SELECTION");
});
