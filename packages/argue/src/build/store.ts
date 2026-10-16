import type { BuildState } from "./state.js";

/** A project writer serializes complete host transactions; no filesystem API enters core. */
export interface BuildStateWriter {
  load(): Promise<BuildState>;
  commit(expectedRevision: number, state: BuildState): Promise<void>;
  transaction<T>(
    operation: (
      current: BuildState
    ) => Promise<{ state?: BuildState; value: T; beforeCommit?: (latest: BuildState) => void | Promise<void> }>
  ): Promise<T>;
}
export interface BuildStateStore {
  load(): Promise<BuildState>;
  withWriter<T>(callback: (writer: BuildStateWriter) => Promise<T>): Promise<T>;
}
