import { resolvePublicationChecks, type CheckSelectionPlan } from "../kernel/checks.js";
import { z } from "zod";
import { AGENT_SYNC_STATE_VERSION, FrozenAgentSyncProjectSchema, type AgentSyncProject } from "./contracts.js";
const nonnegative = z.number().int().nonnegative().safe();
import { createCoordinationKernel } from "../kernel/coordination.js";
import {
  cloneMutable,
  type KernelProtocol,
  type LeaseAllocator,
  type Transition,
  type OperationResult,
  type Schedule
} from "../kernel/types.js";
import { freezeSyncValue } from "../kernel/primitives.js";
import {
  AGENT_SYNC_LEASE_VERSION,
  AGENT_SYNC_REQUEST_VERSION,
  AgentSyncStateSchema,
  AgentSyncLeaseSchema,
  AgentSyncControlRequestSchema,
  AgentSyncCoordinationSchema,
  type AgentSyncState,
  type AgentSyncLease,
  type AgentSyncAttempt,
  type AgentSyncCoordinationRequest,
  type AgentSyncWaitReason,
  type AgentSyncControlResult
} from "./contracts.js";
const protocol: KernelProtocol<
  string,
  "pending",
  AgentSyncCoordinationRequest,
  AgentSyncLease,
  AgentSyncState,
  AgentSyncControlResult
> = {
  parseShape: (input) => freezeSyncValue(AgentSyncStateSchema.parse(input)),
  validateExtension() {},
  draft: cloneMutable,
  core: (value) => value,
  parseLease: (input) => AgentSyncLeaseSchema.parse(input),
  leaseFor: (state, attempt) =>
    freezeSyncValue(
      AgentSyncLeaseSchema.parse({
        leaseVersion: AGENT_SYNC_LEASE_VERSION,
        projectKey: state.projectKey,
        runId: state.runId,
        planHash: state.plan.planHash,
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        workerId: attempt.workerId,
        ownerEpoch: attempt.ownerEpoch,
        leaseEpoch: attempt.leaseEpoch,
        token: attempt.token
      })
    ),
  parseControl(input) {
    const request = AgentSyncControlRequestSchema.parse(input);
    return { ...request, hashPayload: request };
  },
  encodeControl: (record) =>
    AgentSyncCoordinationSchema.shape.requests.element.parse({
      ...record,
      requestVersion: AGENT_SYNC_REQUEST_VERSION,
      status: "succeeded"
    }),
  inspectRecord: (record) => ({
    hasResult: record.result !== null,
    control: record.result,
    replay: record.result,
    allowsPending: false
  }),
  taskTimeoutMs: (value) => value.plan.resources.taskTimeoutMs
};
/** Internal singleton shared with the port adapter; it is not re-exported as worker API. */
export const projectKernel = createCoordinationKernel(protocol);
export type AgentSyncLeaseAllocator = LeaseAllocator<string>;
export type AgentSyncOperationResult = OperationResult<AgentSyncLease, AgentSyncControlResult>;
export type AgentSyncTransition = Transition<AgentSyncState, AgentSyncLease, AgentSyncControlResult>;
export type AgentSyncSchedule = Schedule<AgentSyncState, AgentSyncLease>;
export const parseAgentSyncState = projectKernel.parse;
export const reserveAgentSyncScope = projectKernel.reserve;
export const releaseAgentSyncScope = projectKernel.release;
export const revokeAgentSyncScope = projectKernel.revoke;
export const cancelAgentSyncTask = projectKernel.cancel;
export const bindAgentSyncInput = projectKernel.bindInput;
export const advanceAgentSyncOwnerEpoch = projectKernel.advanceOwner;
export const expireAgentSyncState = projectKernel.expire;
export const scheduleAgentSyncTasks = projectKernel.schedule;
export const validateAgentSyncLease = projectKernel.validateLease;
export const agentSyncRequestedLocks: (state: AgentSyncState, taskId: string) => { path: string; mode: "R" | "W" }[] =
  projectKernel.requestedLocks;
export const agentSyncScopesConflict = projectKernel.scopesConflict;
export const agentSyncWaitReasons: (
  state: AgentSyncState,
  taskId: string,
  earlierEligible: readonly string[]
) => AgentSyncWaitReason[] = projectKernel.waitReasons;
export const agentSyncRequestHash = projectKernel.requestHash;
export function agentSyncLeaseFromAttempt(state: AgentSyncState, attempt: AgentSyncAttempt): AgentSyncLease {
  return projectKernel.leaseFor(state, attempt);
}

export function createAgentSyncState(options: {
  project: AgentSyncProject;
  runId: string;
  acceptedVersion: string;
  now: number;
}): AgentSyncState {
  const project = FrozenAgentSyncProjectSchema.parse(options.project);
  const now = nonnegative.parse(options.now);
  const deadlineAt = nonnegative.parse(now + project.resources.runTimeoutMs);
  return parseAgentSyncState({
    stateVersion: AGENT_SYNC_STATE_VERSION,
    projectKey: project.projectKey,
    runId: options.runId,
    revision: 0,
    ownerEpoch: 1,
    plan: project,
    acceptedVersion: options.acceptedVersion,
    status: "active",
    startedAt: now,
    deadlineAt,
    acceptedTasks: [],
    waiting: [],
    attempts: [],
    coordination: {
      lastNow: now,
      nextSequence: 0,
      taskEpochs: Object.fromEntries(project.tasks.map((task) => [task.taskId, 0])),
      taskStates: Object.fromEntries(project.tasks.map((task) => [task.taskId, "pending"])),
      locks: [],
      requests: []
    },
    checkReceipts: [],
    publishReceipts: []
  });
}

export function projectCheckSelection(state: AgentSyncState): CheckSelectionPlan {
  return {
    tasks: state.plan.tasks,
    profiles: state.plan.profiles.map((profile) => ({ profileId: profile.profileId, checks: profile.checkIds })),
    finalProfileId: state.plan.finalProfileId,
    alwaysChecks: [],
    order: [...new Set(state.plan.profiles.flatMap((profile) => profile.checkIds))]
  };
}
export function agentSyncPublicationChecks(state: AgentSyncState, taskId: string): readonly string[] {
  return resolvePublicationChecks(projectCheckSelection(state), state.acceptedTasks, taskId);
}
