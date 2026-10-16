import type { AgentSyncProject, AgentSyncStatus } from "@onevcat/argue/agent-sync/project";
import type { ModelCall, ModelTransport } from "@onevcat/argue";
import type { SyncAction } from "./protocol.js";
export interface Inspected {
  path: string;
  text: string | null;
  contentHash: string | null;
  baseVersion: string;
}
export interface TaskContext {
  freezeInput(
    requestId: string
  ): Promise<{ baseVersion: string; inputHash: string; contentHashes: Readonly<Record<string, string | null>> }>;
  read(path: string, requestId: string): Promise<Inspected>;
  runAction(action: SyncAction, requestId: string): Promise<unknown>;
}
export interface WorkerClient {
  requestScope(
    taskId: string,
    requestId: string
  ): Promise<{ result: { kind: string; code?: string }; task?: TaskContext }>;
  call(method: string, params: Record<string, unknown>, requestId: string): Promise<{ result: unknown }>;
}
export interface SyncHost {
  ready: Promise<{ status: AgentSyncStatus }>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  client(connectionId: string): WorkerClient;
  child: { kill(signal: string): boolean };
  closed: boolean;
}
export type ModelProfile = Omit<ModelCall, "messages" | "maxOutputTokens"> & { maxInputCharacters: number };
export interface SyncBudget {
  maxCalls: number;
  maxOutputTokensPerCall: number;
  maxAllocatedOutputTokens: number;
  maxDurationMs: number;
  callTimeoutMs: number;
}
export interface CallerOptions {
  project: AgentSyncProject;
  clients: Readonly<Record<string, WorkerClient>>;
  profiles: Readonly<Record<string, ModelProfile>>;
  instructions: Readonly<Record<string, string>>;
  transport: ModelTransport;
  budget: SyncBudget;
  usedCalls: number;
  deadlineAt: number;
  signal: AbortSignal;
  record(event: Record<string, unknown>): void;
  status(): Promise<AgentSyncStatus>;
}
