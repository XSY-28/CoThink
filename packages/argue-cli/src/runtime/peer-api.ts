import {
  PeerRuntimeFailure,
  ModelTransportFailure,
  type MemberRequest,
  type MemberRuntime,
  type ModelCall,
  type ModelTransport
} from "@onevcat/argue";
import { createApiModelTransport, validateModelCall } from "./model-api.js";

/** Explicit projection keeps legacy domain state out of provider adapters. */
export function peerModelCall(request: MemberRequest): ModelCall {
  return {
    protocol: request.protocol,
    baseUrl: request.baseUrl,
    modelId: request.modelId,
    apiKeyEnv: request.apiKeyEnv,
    messages: request.messages,
    outputMode: request.outputMode,
    maxOutputTokens: request.maxOutputTokens,
    generationOptions: request.generationOptions
  };
}
function peerFailure(error: unknown): never {
  if (error instanceof ModelTransportFailure) throw new PeerRuntimeFailure(error.error, error.details);
  throw error;
}
export function validatePeerApiRequest(request: MemberRequest): void {
  try {
    validateModelCall(peerModelCall(request));
  } catch (error) {
    peerFailure(error);
  }
}
export function peerRuntimeFromTransport(transport: ModelTransport): MemberRuntime {
  return {
    async respond(request, signal) {
      try {
        return await transport.respond(peerModelCall(request), signal);
      } catch (error) {
        peerFailure(error);
      }
    }
  };
}
export function createPeerApiRuntime(
  env: Record<string, string | undefined> = process.env,
  credentialEnvNames: readonly string[] = []
): MemberRuntime {
  return peerRuntimeFromTransport(createApiModelTransport(env, credentialEnvNames));
}
