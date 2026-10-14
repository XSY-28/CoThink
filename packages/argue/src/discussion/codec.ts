import type { ModelCall, ModelJsonValue } from "../transport/contracts.js";
import type { DiscussionSemanticSnapshot, DiscussionSession } from "./contracts.js";
import { discussionSnapshotId, sharedDiscussionSnapshot } from "./context.js";
import { discussionHash, freezeDiscussionValue } from "./state-utils.js";

/** Representation boundary only. Every decoded turn still requires domain validation. */
export interface ProtocolCodec {
  readonly codecVersion: string;
  encode(
    snapshot: DiscussionSemanticSnapshot,
    memberContext: { memberId: string; maxOutputTokens: number }
  ): {
    messages: ModelCall["messages"];
    outputSchema: Record<string, ModelJsonValue>;
  };
  decode(raw: unknown): unknown;
}
export interface DiscussionMemberRequest {
  readonly memberId: string;
  readonly snapshotId: string;
  readonly codecVersion: string;
  readonly maxOutputTokens: number;
  readonly messages: ModelCall["messages"];
  readonly outputSchema: Record<string, ModelJsonValue>;
  readonly inputHash: string;
}

export function buildDiscussionMemberRequest(
  state: DiscussionSession,
  memberId: string,
  maxOutputTokens: number,
  codec: ProtocolCodec
): DiscussionMemberRequest {
  if (!state.memberIds.includes(memberId)) throw new Error("Unknown discussion member");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
    throw new Error("Output quota must be a positive safe integer");
  if (codec.codecVersion !== state.codecVersion) throw new Error("Codec does not match frozen session version");
  const snapshot = sharedDiscussionSnapshot(state);
  const encoded = codec.encode(snapshot, { memberId, maxOutputTokens });
  if (encoded.messages.reduce((size, message) => size + message.content.length, 0) > 100_000)
    throw new Error("Compiled input exceeds 100000 character limit");
  const request = {
    memberId,
    snapshotId: discussionSnapshotId(state),
    codecVersion: codec.codecVersion,
    maxOutputTokens,
    messages: structuredClone(encoded.messages),
    outputSchema: structuredClone(encoded.outputSchema)
  };
  return freezeDiscussionValue({ ...request, inputHash: discussionHash(request) });
}
