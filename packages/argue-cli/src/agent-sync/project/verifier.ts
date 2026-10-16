import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
  AGENT_SYNC_CHECK_VERSION,
  AgentSyncCheckReceiptSchema,
  FrozenAgentSyncProjectSchema,
  freezeSyncValue,
  hashJson,
  type AgentSyncProject,
  type AgentSyncCheckReceipt
} from "@onevcat/argue/agent-sync/project";
import { DataOracleVerifier, type OracleAdapter } from "../kernel/data-oracle-verifier.js";
import type { VerificationCandidate } from "../kernel/verification-types.js";
import type { LocalDockerOptions } from "../kernel/docker-runtime.js";
import { imageReference } from "../kernel/docker-runtime.js";
import { ProjectDockerRuntime } from "./runtime.js";
import type { FileAgentSyncWriter } from "./storage.js";
import type { AgentSyncCheckDefinition, AgentSyncVerifier } from "./backend.js";
import {
  freezeTrustedCheckConfig,
  runtimeProjection,
  validateProjectChecks,
  type TrustedCheckConfig
} from "../checks/config.js";
import { CheckEvidence } from "../checks/evidence.js";
import { byteHash, checkTime } from "../checks/measure.js";
import { executeOracle } from "../checks/oracle.js";
export interface ProjectDockerVerifierOptions extends LocalDockerOptions {
  readonly project: AgentSyncProject;
  readonly config: TrustedCheckConfig;
  readonly trustedRoot: string;
  /** Explicit directory containing the fixed agent-sync-validator and agent-sync-checks programs. */
  readonly programRoot: string;
  readonly image: string;
  readonly home: string;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
  /** Trusted, private evidence sink; never included in worker results or runtime config. */
  readonly onUsage?: (usage: unknown) => void | Promise<void>;
}
class ProjectOracleAdapter implements OracleAdapter<string, AgentSyncCheckDefinition, AgentSyncCheckReceipt> {
  readonly checkVersion = AGENT_SYNC_CHECK_VERSION;
  readonly errorPrefix = "AGENT_SYNC_";
  readonly allowMissing = true;
  readonly overallTimeout: number;
  private readonly project: AgentSyncProject;
  private readonly config: TrustedCheckConfig;
  private readonly runtime: ProjectDockerRuntime;
  private readonly evidence: CheckEvidence;
  private readonly trustedRoot: string;
  private readonly programRoot: string;
  private readonly clock: () => number;
  private readonly onUsage: ProjectDockerVerifierOptions["onUsage"];
  constructor(
    private readonly writer: FileAgentSyncWriter,
    options: ProjectDockerVerifierOptions
  ) {
    if (!imageReference.test(options.image)) throw new Error("AGENT_SYNC_IMAGE_DIGEST");
    this.project = freezeSyncValue(FrozenAgentSyncProjectSchema.parse(options.project));
    this.config = freezeTrustedCheckConfig(options.config);
    validateProjectChecks(this.config, this.project);
    const cap = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 120000) throw new Error("AGENT_SYNC_CHECK_TIMEOUT");
    this.overallTimeout = Math.min(cap, this.config.limits.checkTimeoutMs, this.project.resources.checkTimeoutMs);
    this.trustedRoot = realpathSync(options.trustedRoot);
    this.programRoot = realpathSync(options.programRoot);
    const control = realpathSync(writer.controlRoot);
    if (
      this.trustedRoot === control ||
      this.trustedRoot.startsWith(control + sep) ||
      this.programRoot === control ||
      this.programRoot.startsWith(control + sep)
    )
      throw new Error("AGENT_SYNC_TRUSTED_ROOT");
    this.clock = options.clock ?? Date.now;
    this.onUsage = options.onUsage;
    this.runtime = new ProjectDockerRuntime({
      home: options.home,
      timeoutMs: this.overallTimeout,
      ...(options.dockerEndpoint === undefined ? {} : { dockerEndpoint: options.dockerEndpoint }),
      ...(options.dockerContext === undefined ? {} : { dockerContext: options.dockerContext })
    });
    this.evidence = new CheckEvidence(
      this.runtime,
      this.config,
      this.trustedRoot,
      this.programRoot,
      options.image,
      this.overallTimeout
    );
  }
  describe(groups: readonly string[], deadline?: number) {
    return this.evidence.describe(groups, deadline);
  }
  async manifest(candidate: VerificationCandidate) {
    if (candidate.planHash !== this.project.planHash) throw new Error("AGENT_SYNC_CANDIDATE_PLAN");
    const state = await this.writer.load(),
      attempt = state.attempts.find((a) => a.attemptId === candidate.attemptId),
      now = this.clock();
    if (state.plan.planHash !== this.project.planHash || hashJson(state.plan) !== hashJson(this.project) || !attempt)
      throw new Error("AGENT_SYNC_CANDIDATE_PLAN");
    if (now >= state.deadlineAt || now >= attempt.deadlineAt) throw new Error("AGENT_SYNC_CHECK_EXPIRED");
    return this.project.manifest;
  }
  receipt(raw: unknown) {
    return freezeSyncValue(AgentSyncCheckReceiptSchema.parse(raw));
  }
  async execute(
    source: string,
    directory: string,
    definition: AgentSyncCheckDefinition,
    deadline: number | undefined,
    deadlineNs: string | undefined
  ): Promise<number> {
    if (deadline === undefined || deadlineNs === undefined) throw new Error("AGENT_SYNC_CHECK_TIMEOUT");
    const configRoot = join(directory, "runtime-config");
    await mkdir(configRoot, { mode: 0o755 });
    const bytes = JSON.stringify(runtimeProjection(this.config)),
      path = join(configRoot, "config.json");
    await writeFile(path, bytes, { mode: 0o444 });
    const exit = await this.runtime.withContainer(
      definition.imageDigest,
      { candidateRoot: source, configRoot },
      async (c) => {
        const compile = c.runFixed("compile");
        if (compile.error || compile.signal || compile.status === null) throw new Error("AGENT_SYNC_COMPILE_EXECUTION");
        if (compile.status !== 0) return 1;
        if (compile.stdout || compile.stderr) throw new Error("AGENT_SYNC_COMPILE_DATA");
        return executeOracle(
          this.config,
          this.trustedRoot,
          this.programRoot,
          directory,
          definition.groups,
          c,
          deadline,
          deadlineNs
        );
      },
      deadline
    );
    if (byteHash(await readFile(path)) !== byteHash(bytes)) throw new Error("AGENT_SYNC_RUNTIME_CONFIGURATION_CHANGED");
    if (this.onUsage) {
      try {
        const usage = JSON.parse(await readFile(join(directory, "usage.json"), "utf8"));
        await this.onUsage(usage);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    checkTime(deadline);
    return exit;
  }
}
/** Construction captures the frozen project; describe performs no writer/state I/O. */
export class ProjectDockerVerifier
  extends DataOracleVerifier<string, AgentSyncCheckDefinition, AgentSyncCheckReceipt>
  implements AgentSyncVerifier
{
  constructor(writer: FileAgentSyncWriter, options: ProjectDockerVerifierOptions) {
    super(writer, new ProjectOracleAdapter(writer, options));
  }
}
