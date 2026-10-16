/** Thin JSONL client. Tool authority and runtime validation remain in protocol.mjs. */
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
export interface Client {
  call(
    method: string,
    params?: Record<string, unknown>,
    requestId?: string
  ): Promise<{ result: unknown; timing?: unknown }>;
  requestScope(
    taskId: string,
    requestId?: string
  ): Promise<{ result: { kind: string; code?: string }; task?: TaskContext }>;
  restoreTask(descriptor: unknown): TaskContext;
  disconnect(): void;
}
export interface TaskContext {
  descriptor(): Record<string, unknown>;
  freezeInput(
    requestId?: string
  ): Promise<{ baseVersion: string; inputHash: string; contentHashes: Record<string, string | null> }>;
  read(
    path: string,
    requestId?: string
  ): Promise<{ path: string; text: string | null; contentHash: string | null; baseVersion: string }>;
  edit(
    edits: readonly { path: string; text: string; expectedContentHash: string | null }[],
    requestId?: string
  ): Promise<unknown>;
  seal(requestId?: string): Promise<unknown>;
  check(requestId?: string): Promise<unknown>;
  finish(requestId?: string): Promise<unknown>;
  release(requestId?: string): Promise<unknown>;
  runAction(action: unknown, requestId?: string): Promise<unknown>;
}
export function taskContext(client: Pick<Client, "call">, descriptor: unknown): TaskContext;
export function createClient(send: (request: unknown) => Promise<unknown>): Client;
export function createStreamClient(input: Readable, output: Writable): Client & { reader: Promise<void> };
export function safeChildEnvironment(): Record<string, string>;
export class ToolHost {
  constructor(options: {
    entry: string;
    configFile: string;
    cwd: string;
    trace?: boolean;
    execArgv?: string[];
    onDiagnostic?: (event: unknown) => void;
  });
  ready: Promise<unknown>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  child: ChildProcess;
  closed: boolean;
  client(connectionId: string): Client;
  attachProcess(child: ChildProcess, connectionId: string): Promise<void>;
}
