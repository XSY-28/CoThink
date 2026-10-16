import { hashJson } from "@onevcat/argue/agent-sync/project";
import type { GitSnapshotFile } from "./git-snapshots.js";
export interface VerificationCandidate {
  attemptId: string;
  baseVersion: string;
  version: string;
  candidateHash: string;
  planHash: string;
}
export interface VerificationDefinition<G extends string = string> {
  groups: readonly G[];
  checksHash: string;
  toolchainHash: string;
  isolationHash: string;
  imageDigest: string;
  configurationHash?: string;
  programsHash?: string;
  argumentsHash?: string;
}
export interface Verifier<G extends string, C, D extends VerificationDefinition<G> = VerificationDefinition<G>> {
  ownsReceipt(receipt: C): boolean;
  describe(groups: readonly G[]): Promise<D>;
  check(candidate: VerificationCandidate, definition: D): Promise<C>;
}
export function hashVerificationSource(files: Readonly<Record<string, GitSnapshotFile>>): string {
  return hashJson(
    Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, file]) => ({ path, contentHash: file.contentHash }))
  );
}
