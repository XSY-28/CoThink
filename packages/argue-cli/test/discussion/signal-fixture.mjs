import process from "node:process";
import { writeSync } from "node:fs";
import { DiscussionEngine } from "../../../argue/dist/index.js";
import { FileDiscussionStore } from "../../dist/discussion/file-store.js";

const [root] = process.argv.slice(2);
const config = {
  protocol: "openai-compatible",
  baseUrl: "https://offline.invalid/v1",
  modelId: "scripted-signal",
  apiKeyEnv: "UNUSED_SIGNAL_TEST_KEY",
  outputMode: "json_object",
  generationOptions: {}
};
const controller = new globalThis.AbortController();
process.once("SIGINT", () => controller.abort(new Error("Host received SIGINT")));
let calls = 0;
let aborted = 0;
const transport = {
  respond: (_call, signal) => {
    calls++;
    signal.addEventListener("abort", () => aborted++, { once: true });
    if (calls === 2) writeSync(1, "READY\n");
    // Intentionally ignores abort and never settles: the engine owns cancellation.
    return new Promise(() => {});
  }
};
await new FileDiscussionStore(root).withWriter("signal-test", async (writer) => {
  const engine = new DiscussionEngine(writer, transport, { now: () => 0 });
  const state = await engine.start(
    {
      sessionId: "signal-test",
      question: "Should an interrupted opening be retried?",
      memberIds: ["a", "b"],
      members: { a: config, b: config },
      policy: { effort: "standard" }
    },
    controller.signal
  );
  writeSync(1, `DONE:${JSON.stringify({ calls, aborted, status: state.status })}\n`);
});
