import process from "node:process";
import { writeSync } from "node:fs";
import { DiscussionEngine } from "../../../argue/dist/index.js";
import { FileDiscussionStore } from "../../dist/discussion/file-store.js";

const [root, boundary] = process.argv.slice(2);
const configuration = {
  protocol: "openai-compatible",
  baseUrl: "https://offline.invalid/v1",
  modelId: "scripted",
  apiKeyEnv: "UNUSED_TEST_KEY",
  outputMode: "json_object",
  generationOptions: {}
};
function halt() {
  writeSync(1, `BOUNDARY:${boundary}\n`);
  process.kill(process.pid, "SIGSTOP");
}
function response(call) {
  const identity = /Your identity: (.+?)\. Output quota:/.exec(call.messages[0].content)[1];
  const snapshot = JSON.parse(call.messages.find((message) => message.role === "user").content);
  const contract = snapshot.responseContract.byMember[identity];
  const turn = JSON.parse(JSON.stringify(contract.template));
  if (turn.phase === "opening") {
    turn.claims[0].statement = "Use the local proposal";
    turn.claims[0].rationale = "Independent supporting evidence";
    turn.answer.body = "An independent initial answer";
    turn.complexity = "simple";
    turn.complexityRationale = "One exchange can assess the proposal";
  } else if (turn.phase === "discussion") {
    turn.answer.body = "Use the local proposal after checking both viewpoints";
    turn.answer.basisVersionIds = contract.referenceSlots.activeBasisVersionIds;
    turn.readyToReview = true;
  } else {
    for (const position of turn.positions) {
      position.stance = "accept";
      position.rationale = "Reviewed the exact frozen version";
    }
  }
  return {
    modelId: call.modelId,
    protocol: call.protocol,
    generationOptions: call.generationOptions,
    usage: {},
    finishReason: "stop",
    rawContent: JSON.stringify(turn),
    payload: turn
  };
}
const transport = {
  respond: async (call) => {
    if (boundary === "dispatch") halt();
    return response(call);
  }
};
const disk = new FileDiscussionStore(root);
await disk.withWriter("crash-test", async (writer) => {
  const engine = new DiscussionEngine(writer, transport, {
    now: () => 0,
    onSaved: (_state, event) => {
      if (
        event.type === boundary ||
        (boundary === "sealed" && event.type === "settled" && event.outcome === "succeeded")
      )
        halt();
    }
  });
  await engine.start({
    sessionId: "crash-test",
    question: "Should we use the local proposal?",
    memberIds: ["a", "b"],
    members: { a: configuration, b: configuration },
    policy: { effort: "standard", maxRounds: 1 }
  });
});
throw new Error(`Boundary not encountered: ${boundary}`);
