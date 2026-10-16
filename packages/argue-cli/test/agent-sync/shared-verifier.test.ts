import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { hashJson } from "@onevcat/argue/agent-sync/project";
import { DataOracleVerifier } from "../../src/agent-sync/kernel/data-oracle-verifier.js";
import { byteHash } from "../../src/agent-sync/checks/measure.js";
const H = byteHash("basis"),
  file = { text: "export const x=1;", contentHash: byteHash("export const x=1;"), blobId: "a".repeat(40) };
const candidate = {
  attemptId: "probe",
  baseVersion: "a".repeat(40),
  version: "b".repeat(40),
  planHash: H,
  candidateHash: hashJson({ baseVersion: "a".repeat(40), files: [{ path: "x.ts", contentHash: file.contentHash }] })
};
const definition = { groups: ["one"], checksHash: H, toolchainHash: H, isolationHash: H, imageDigest: H };
describe("one actual verification algorithm freshness", () => {
  it.each(["changed", "extra", "definition", "timeout"])("rejects %s and mints no owned result", async (mode) => {
    let descriptions = 0;
    const writer = { assertOwner: async () => {}, git: { readFiles: async () => ({ "x.ts": file }) } };
    const verifier = new DataOracleVerifier(writer, {
      checkVersion: "fixture",
      errorPrefix: "FIXTURE_",
      allowMissing: false,
      overallTimeout: mode === "timeout" ? 15 : 1000,
      describe: async () => {
        descriptions++;
        return mode === "definition" && descriptions > 1
          ? { ...definition, checksHash: byteHash("changed") }
          : definition;
      },
      manifest: async () => [{ path: "x.ts", access: "writable", contentHash: file.contentHash }],
      execute: async (source) => {
        if (mode === "changed") {
          await chmod(join(source, "x.ts"), 0o644);
          await writeFile(join(source, "x.ts"), "changed");
        }
        if (mode === "extra") await writeFile(join(source, "extra.ts"), "extra");
        if (mode === "timeout") await new Promise((r) => setTimeout(r, 30));
        return 0;
      },
      receipt: (raw) => raw as object
    });
    await expect(verifier.check(candidate, definition)).rejects.toThrow(
      mode === "definition" ? "DEFINITION_CHANGED" : mode === "timeout" ? "CHECK_TIMEOUT" : "CANDIDATE_CHANGED"
    );
    expect(verifier.ownsReceipt({ passed: true })).toBe(false);
  });
});
