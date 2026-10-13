/* global AbortSignal, process */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { buildMemberRequest, createPeerSession, validateMemberReply } from "@onevcat/argue";
import { loadPeerMembers } from "../packages/argue-cli/dist/peer/config.js";
import { createPeerApiRuntime } from "../packages/argue-cli/dist/runtime/peer-api.js";

const configPath = resolve(process.argv[2] ?? "packages/argue-cli/examples/peer/deepseek-glm.config.example.json");
const question = process.argv[3] ?? "What is one tradeoff of using a local file for a small project?";
const members = await loadPeerMembers(configPath);
const session = createPeerSession(
  {
    sessionId: `peer-smoke-${randomUUID()}`,
    schemaVersion: 1,
    sourceCommit: "smoke-local",
    createdAt: new Date().toISOString(),
    question,
    members: Object.values(members)
  },
  []
);
const runtime = createPeerApiRuntime();

for (const memberId of ["member-a", "member-b"]) {
  const request = buildMemberRequest(session, memberId);
  try {
    const reply = await runtime.respond(request, AbortSignal.timeout(180_000));
    validateMemberReply(session, {
      memberId,
      jobId: request.jobId,
      snapshotId: request.snapshotId,
      inputHash: request.inputHash,
      payload: reply.payload
    });
    console.log(
      JSON.stringify({
        memberId,
        status: "valid",
        modelId: reply.modelId,
        finishReason: reply.finishReason,
        usage: reply.usage,
        payload: reply.payload
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        memberId,
        status: "failed",
        code: error.peerError?.code ?? "invalid_reply",
        message: error.peerError?.message ?? error.message
      })
    );
    process.exitCode = 1;
  }
}
