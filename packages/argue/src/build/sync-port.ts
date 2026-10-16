export {
  BuildVerifierRequestSchema,
  buildPublicationChecks,
  buildPublishRequestHash
} from "../agent-sync/legacy-v1/ports.js";
export type {
  WorkspacePort,
  BuildVerifierRequest,
  BuildVerifierResponse,
  VerifierPort,
  BuildPublisherResponse,
  PublisherPort,
  BuildSyncPorts
} from "../agent-sync/legacy-v1/ports.js";
import { legacyPortValidators } from "../agent-sync/legacy-v1/ports.js";
export const validateWorkspacePortResult = legacyPortValidators.workspace;
export const validateVerifierPortResult = legacyPortValidators.verifier;
export const validatePublisherPortResult = legacyPortValidators.publisher;
