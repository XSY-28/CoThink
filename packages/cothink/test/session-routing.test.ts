import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCoThink } from "../src/index.js";
import paused from "../../argue/test/discussion/fixtures/peer-v5-paused.json" with { type: "json" };
let root: string;
let errors: string[];
let calls: ReturnType<typeof vi.fn>;
let io: { log: (s: string) => void; error: (s: string) => void };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cothink-route-"));
  errors = [];
  calls = vi.fn(() => {
    throw Error("must not call a model");
  });
  vi.stubGlobal("fetch", calls);
  io = { log: () => {}, error: (s) => errors.push(s) };
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
async function snapshot(sessionId: string, state: unknown) {
  await mkdir(join(root, sessionId));
  const bytes = JSON.stringify(state);
  await writeFile(join(root, sessionId, "session.json"), bytes);
  return bytes;
}
const header = {
  schemaVersion: 2,
  promptVersion: "peer-v6",
  codecVersion: "discussion-json-v1",
  policyVersion: "discussion-policy-v1",
  sessionId: "new",
  revision: 0
};
it("routes af34aac sessions through legacy read commands, also with options before the ID", async () => {
  const id = paused.config.sessionId,
    bytes = await snapshot(id, paused);
  expect(await runCoThink(["show", "--root", root, id], io, { env: {} })).toEqual({ ok: true, code: 0 });
  expect(await readFile(join(root, id, "session.json"), "utf8")).toBe(bytes);
  expect(calls).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
});
it.each(["show", "retry", "continue", "export", "view"])(
  "routes recognized v2 %s to an explicit unavailable handler with no calls or writes",
  async (command) => {
    const bytes = await snapshot("new", header);
    const extra =
      command === "continue"
        ? ["--note", "note"]
        : command === "export"
          ? ["--format", "json"]
          : command === "view"
            ? ["--no-open"]
            : [];
    expect(await runCoThink([command, "new", "--root", root, ...extra], io, { env: {} })).toEqual({
      ok: false,
      code: 1
    });
    expect(errors.join("\n")).toContain("not implemented in stage 0");
    expect(calls).not.toHaveBeenCalled();
    expect(await readFile(join(root, "new", "session.json"), "utf8")).toBe(bytes);
    expect(await readdir(join(root, "new"))).toEqual(["session.json"]);
  }
);
it.each([
  { ...header, schemaVersion: 99 },
  { ...header, schemaVersion: "2" },
  { ...header, promptVersion: "peer-v5" },
  { ...header, codecVersion: "unknown" },
  { ...header, policyVersion: "unknown" },
  { ...header, config: paused.config },
  { config: { schemaVersion: 99 } },
  { ...paused, config: { ...paused.config, sessionId: "new", promptVersion: "peer-v6" } }
])("rejects invalid versions before retry, network or writer lease", async (state) => {
  const bytes = await snapshot("new", state);
  expect(await runCoThink(["retry", "new", "--root", root], io, { env: {} })).toEqual({ ok: false, code: 1 });
  expect(errors.join("\n")).toMatch(/version|format|snapshot/i);
  expect(calls).not.toHaveBeenCalled();
  expect(await readFile(join(root, "new", "session.json"), "utf8")).toBe(bytes);
  expect(await readdir(join(root, "new"))).toEqual(["session.json"]);
});
