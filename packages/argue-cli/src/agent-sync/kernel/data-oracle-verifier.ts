import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashJson, SyncPathSchema } from "@onevcat/argue/agent-sync/project";
import {
  hashVerificationSource,
  type VerificationCandidate,
  type VerificationDefinition
} from "./verification-types.js";
import type { GitSnapshotFile } from "./git-snapshots.js";
export interface OracleWriter {
  assertOwner(): Promise<void>;
  git: { readFiles(version: string): Promise<Readonly<Record<string, GitSnapshotFile>>> };
}
export interface OracleAdapter<G extends string, D extends VerificationDefinition<G>, C extends object> {
  readonly checkVersion: string;
  readonly errorPrefix: string;
  readonly overallTimeout?: number;
  readonly allowMissing: boolean;
  describe(groups: readonly G[], deadline?: number): Promise<D>;
  manifest(
    candidate: VerificationCandidate
  ): Promise<readonly { path: string; access: string; contentHash: string | null }[]>;
  execute(
    source: string,
    directory: string,
    definition: D,
    deadline: number | undefined,
    deadlineNs: string | undefined
  ): Promise<number>;
  receipt(raw: unknown): C;
}
const sha = (bytes: string | Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
/** The one actual candidate/check lifecycle; adapters supply format and trusted oracle policy only. */
export class DataOracleVerifier<G extends string, D extends VerificationDefinition<G>, C extends object> {
  private readonly receipts = new WeakSet<C>();
  constructor(
    private readonly writer: OracleWriter,
    private readonly adapter: OracleAdapter<G, D, C>
  ) {}
  ownsReceipt(receipt: C): boolean {
    return this.receipts.has(receipt);
  }
  describe(groups: readonly G[]): Promise<D> {
    return this.adapter.describe(groups);
  }
  async check(candidate: VerificationCandidate, definition: D): Promise<C> {
    const deadline =
      this.adapter.overallTimeout === undefined ? undefined : performance.now() + this.adapter.overallTimeout;
    const deadlineNs =
      this.adapter.overallTimeout === undefined
        ? undefined
        : String(process.hrtime.bigint() + BigInt(this.adapter.overallTimeout) * 1000000n);
    const fail = (suffix: string): never => {
      throw new Error(this.adapter.errorPrefix + suffix);
    };
    const time = () => {
      if (deadline !== undefined && performance.now() >= deadline) fail("CHECK_TIMEOUT");
    };
    await this.writer.assertOwner();
    time();
    const fresh = await this.adapter.describe(definition.groups, deadline);
    if (hashJson(fresh) !== hashJson(definition)) fail("CHECK_DEFINITION_CHANGED");
    const files = await this.writer.git.readFiles(candidate.version);
    time();
    const records = Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, file]) => ({ path, contentHash: file.contentHash }));
    if (candidate.candidateHash !== hashJson({ baseVersion: candidate.baseVersion, files: records }))
      fail("CANDIDATE_HASH");
    const sourceHashBefore = hashVerificationSource(files);
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cothink-docker-check-"))),
      source = join(directory, "candidate");
    let exitCode: number, sourceHashAfter: string;
    try {
      await mkdir(source, { mode: 0o755 });
      await chmod(directory, 0o755);
      const manifest = await this.adapter.manifest(candidate);
      time();
      if (records.length !== manifest.length || records.some((r) => !manifest.some((m) => m.path === r.path)))
        fail("CANDIDATE_MANIFEST");
      for (const entry of manifest) {
        SyncPathSchema.parse(entry.path);
        const file = files[entry.path];
        if (!file || (entry.access === "read-only" && file.contentHash !== entry.contentHash)) fail("CANDIDATE_FROZEN");
        if (file!.text === null) {
          if (!this.adapter.allowMissing || file!.contentHash !== null || entry.access === "read-only")
            fail("CANDIDATE_FROZEN");
          continue;
        }
        if (sha(file!.text!) !== file!.contentHash) fail("CANDIDATE_FROZEN");
        await mkdir(dirname(join(source, entry.path)), { recursive: true, mode: 0o755 });
        await writeFile(join(source, entry.path), file!.text!, { mode: 0o444 });
      }
      time();
      exitCode = await this.adapter.execute(source, directory, definition, deadline, deadlineNs);
      time();
      if (!Number.isSafeInteger(exitCode) || exitCode < 0) fail("ORACLE_EXECUTION");
      const after = await this.writer.git.readFiles(candidate.version);
      sourceHashAfter = hashVerificationSource(after);
      for (const record of records) {
        if (record.contentHash === null) {
          try {
            await lstat(join(source, record.path));
            fail("CANDIDATE_CHANGED");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } else if (sha(await readFile(join(source, record.path))) !== record.contentHash) fail("CANDIDATE_CHANGED");
      }
      const materialized: Record<string, string> = {};
      const scan = async (relative: string): Promise<void> => {
        for (const name of await readdir(join(source, relative))) {
          const path = relative ? relative + "/" + name : name,
            stat = await lstat(join(source, path));
          if (stat.isDirectory()) await scan(path);
          else if (stat.isFile() && stat.nlink === 1) materialized[path] = sha(await readFile(join(source, path)));
          else fail("CANDIDATE_CHANGED");
        }
      };
      await scan("");
      if (
        hashJson(materialized) !==
        hashJson(Object.fromEntries(records.filter((r) => r.contentHash !== null).map((r) => [r.path, r.contentHash])))
      )
        fail("CANDIDATE_CHANGED");
      if (sourceHashAfter !== sourceHashBefore) fail("CANDIDATE_CHANGED");
      if (hashJson(await this.adapter.describe(definition.groups, deadline)) !== hashJson(definition))
        fail("CHECK_DEFINITION_CHANGED");
      await this.writer.assertOwner();
      time();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    time();
    const receipt = this.adapter.receipt({
      checkVersion: this.adapter.checkVersion,
      receiptId: `check-${randomUUID()}`,
      attemptId: candidate.attemptId,
      candidateHash: candidate.candidateHash,
      ...definition,
      groups: [...definition.groups],
      exitCode,
      passed: exitCode === 0,
      baseVersion: candidate.baseVersion,
      version: candidate.version,
      planHash: candidate.planHash,
      sourceHashBefore,
      sourceHashAfter
    });
    Object.freeze((receipt as { groups?: unknown }).groups);
    Object.freeze(receipt);
    this.receipts.add(receipt);
    return receipt;
  }
}
