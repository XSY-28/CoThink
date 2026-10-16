import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import {
  AgentSyncService,
  FrozenAgentSyncProjectSchema,
  freezeSyncValue,
  SyncIdSchema,
  type AgentSyncProject,
  type AgentSyncState,
  type AgentSyncLeaseAllocator
} from "@onevcat/argue/agent-sync/project";
import { freezeTrustedCheckConfig, validateProjectChecks } from "../checks/config.js";
import { measureArtifacts } from "../checks/measure.js";
import { imageReference, validateLocalDockerEndpoint } from "../kernel/docker-runtime.js";
import { LocalSession } from "../kernel/local-session.js";
import { FileAgentSyncStore } from "./storage.js";
import {
  LocalAgentSyncAdapter,
  exportAcceptedVersion,
  recoverAgentSyncProject,
  type AgentSyncVerifier
} from "./backend.js";
import { ProjectDockerVerifier, type ProjectDockerVerifierOptions } from "./verifier.js";
import { initializeAgentSyncProject } from "./initialize.js";

export interface LocalAgentSyncOptions extends ProjectDockerVerifierOptions {
  workspaceRoot: string;
  runId: string;
  sourceRoot?: string;
  allocateLease?: AgentSyncLeaseAllocator;
}

function canonicalDirectory(path: string): string {
  if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isDirectory())
    throw new Error("AGENT_SYNC_LOCAL_DIRECTORY");
  return path;
}

/** Explicit callback session with strict independent project authority and trusted host configuration. */
export class LocalAgentSync {
  private readonly session: LocalSession<AgentSyncProject, AgentSyncState, AgentSyncService>;
  constructor(options: LocalAgentSyncOptions) {
    const project = freezeSyncValue(FrozenAgentSyncProjectSchema.parse(options.project));
    const config = freezeTrustedCheckConfig(options.config);
    const runId = SyncIdSchema.parse(options.runId);
    validateProjectChecks(config, project);
    if (!imageReference.test(options.image)) throw new Error("AGENT_SYNC_IMAGE_DIGEST");
    const timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error("AGENT_SYNC_CHECK_TIMEOUT");
    if (options.dockerEndpoint !== undefined && options.dockerContext !== undefined)
      throw new Error("BUILD_DOCKER_CONNECTION");
    if (options.dockerEndpoint !== undefined) validateLocalDockerEndpoint(options.dockerEndpoint);
    if (options.dockerContext !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.dockerContext))
      throw new Error("BUILD_DOCKER_CONTEXT");
    const trustedRoot = canonicalDirectory(options.trustedRoot);
    const programRoot = canonicalDirectory(options.programRoot);
    const home = canonicalDirectory(options.home);
    const control = join(options.workspaceRoot, ".agent-sync");
    if ([trustedRoot, programRoot, home].some((root) => root === control || root.startsWith(control + sep)))
      throw new Error("AGENT_SYNC_TRUSTED_ROOT");
    const clock = options.clock ?? Date.now;
    // Copy the trusted options before any await; caller mutation never replaces session authority.
    const captured = { ...options, project, config, runId, trustedRoot, programRoot, home, clock };
    const store = new FileAgentSyncStore({
      workspaceRoot: options.workspaceRoot,
      projectKey: project.projectKey,
      clock,
      expectedPlanHash: project.planHash,
      expectedRunId: runId
    });
    this.session = new LocalSession({
      store,
      project,
      runId,
      preflight: async () => {
        await measureArtifacts(config, trustedRoot);
      },
      initialize: (writer) => initializeAgentSyncProject(writer, captured),
      service: (writer, state, diff) => {
        // Construction discovers Docker context/socket. Delay it until explicit verification;
        // describe captures immutable configuration and never reenters the writer serializer.
        let instance: ProjectDockerVerifier | undefined;
        const verifier = (): ProjectDockerVerifier => (instance ??= new ProjectDockerVerifier(writer, captured));
        const lazy: AgentSyncVerifier = {
          ownsReceipt: (receipt) => instance?.ownsReceipt(receipt) ?? false,
          describe: (groups) => verifier().describe(groups),
          check: (candidate, definition) => verifier().check(candidate, definition)
        };
        const adapter = new LocalAgentSyncAdapter(writer, lazy, { clock });
        return new AgentSyncService({
          writer,
          ports: adapter.ports,
          expectedRunId: runId,
          expectedPlanHash: project.planHash,
          expectedOwnerEpoch: state.ownerEpoch,
          clock,
          allocateLease: captured.allocateLease,
          host: {
            recover: async () => {
              await recoverAgentSyncProject(writer);
            },
            exportVersion: (input) => exportAcceptedVersion(writer, input),
            diff
          }
        });
      }
    });
  }
  withSession<T>(callback: (service: AgentSyncService) => Promise<T>): Promise<T> {
    return this.session.withSession(callback);
  }
}
