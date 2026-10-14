import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PeerSessionDriver, type ModelCall, type ModelTransport } from "@onevcat/argue";
import { FilePeerStore } from "../../src/peer/file-store.js";
import { peerRuntimeFromTransport } from "../../src/runtime/peer-api.js";
import paused from "../../../argue/test/discussion/fixtures/peer-v5-paused.json" with { type: "json" };

it("loads and explicitly resumes a captured af34aac paused snapshot with identical frozen transport inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-stage0-"));
  const id = paused.config.sessionId;
  try {
    await mkdir(join(root, id));
    const bytes = JSON.stringify(paused);
    await writeFile(join(root, id, "session.json"), bytes);
    const store = new FilePeerStore(root);
    expect(await store.load(id)).toEqual(paused);
    expect(await readFile(join(root, id, "session.json"), "utf8")).toBe(bytes);
    const seen: ModelCall[] = [];
    const transport: ModelTransport = {
      respond: async (call) => {
        seen.push(call);
        const context = JSON.parse(call.messages[1]!.content);
        const template = context.responseContract.template;
        const payload = {
          ...template,
          conclusion: "Offline restored position",
          ...(context.phase === "opening"
            ? { claims: [{ statement: "Offline claim", rationale: "Offline reason", assumptions: [], sourceRefs: [] }] }
            : context.phase === "discussion"
              ? { actions: [], readyToReview: true }
              : {
                  positions: template.positions.map((item: { versionId: string }) => ({
                    ...item,
                    stance: "uncertain",
                    rationale: "Offline assessment"
                  }))
                })
        };
        return {
          modelId: call.modelId,
          protocol: call.protocol,
          generationOptions: call.generationOptions,
          usage: {},
          finishReason: "stop",
          payload,
          rawContent: JSON.stringify(payload)
        };
      }
    };
    const runtime = peerRuntimeFromTransport(transport);
    await store.withWriter(id, async (writer) => {
      const driver = new PeerSessionDriver(
        writer,
        { "member-a": runtime, "member-b": runtime },
        { now: () => new Date("2026-10-13T00:00:02.000Z") }
      );
      const ended = await driver.retry(id);
      expect(ended.status).toBe("completed");
      for (const original of paused.jobs) {
        const frozen = original.frozenInput!;
        const { outputSchema: _schema, ...expectedCall } = frozen;
        expect(_schema).toBeDefined();
        expect(seen.find((call) => call.modelId === frozen.modelId)).toEqual(expectedCall);
        expect(ended.jobs.find((job) => job.jobId === original.jobId)!.inputHash).toBe(original.inputHash);
      }
    });
    expect(seen).toHaveLength(2 * (2 + paused.config.limits.minDiscussionRounds));
    expect((await store.load(id)).status).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
