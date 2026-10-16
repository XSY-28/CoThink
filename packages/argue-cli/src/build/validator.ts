import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildCheckGroup, BuildCheckReceipt } from "@onevcat/argue/agent-sync";
import type { FileBuildWriter } from "./file-store.js";
import type { BuildCheckDefinition, BuildVerifier } from "../agent-sync/legacy-v1/backend.js";
import { DataOracleVerifier } from "../agent-sync/kernel/data-oracle-verifier.js";
import { LegacyTodoOracleAdapter } from "../agent-sync/legacy-v1/todo-oracle.js";
export { decodeDockerData } from "../agent-sync/legacy-v1/todo-oracle.js";
export { DockerUnavailable, validateDockerIsolation } from "../agent-sync/legacy-v1/runtime.js";
export { hashVerificationSource } from "../agent-sync/kernel/verification-types.js";
export type {
  BuildVerificationCandidate,
  BuildCheckDefinition,
  BuildVerifier
} from "../agent-sync/legacy-v1/backend.js";
export class DockerVerifier
  extends DataOracleVerifier<BuildCheckGroup, BuildCheckDefinition, BuildCheckReceipt>
  implements BuildVerifier
{
  constructor(writer: FileBuildWriter, options: { image: string; repoRoot?: string; timeoutMs?: number }) {
    super(
      writer,
      new LegacyTodoOracleAdapter({
        ...options,
        repoRoot: options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
      })
    );
  }
}
