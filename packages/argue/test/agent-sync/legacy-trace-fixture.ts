import {
  createBuildState,
  bindBuildInput,
  cancelBuildTask,
  advanceBuildOwnerEpoch,
  admitBuildAction,
  settleBuildAction,
  expireBuildState,
  type BuildTransition
} from "../../src/build/state.js";
import { reserveBuildScope, releaseBuildScope, revokeBuildScope } from "../../src/build/scope.js";
import { scheduleBuildTasks } from "../../src/build/scheduler.js";
import { hashJson, sha256 } from "../../src/peer/hash.js";
import { runInput } from "../build/fixtures.js";
/** Captured against the untouched pre-Task2 source; serialized bytes include all legacy metadata. */
export function legacyTrace() {
  let state = createBuildState(runInput());
  const trace: unknown[] = [];
  function record(step: BuildTransition) {
    state = step.state;
    trace.push({
      result: step.result,
      serializedHash: sha256(JSON.stringify(state)),
      canonicalHash: hashJson(state),
      revision: state.revision,
      requestHashes: state.coordination.requests.map((r) => r.payloadHash)
    });
    return step;
  }
  const allocate = ({ taskId, leaseEpoch }: { taskId: string; leaseEpoch: number }) => ({
    attemptId: `${taskId}-${leaseEpoch}`,
    token: `token-${taskId}-${leaseEpoch}`
  });
  const a = record(
    reserveBuildScope(
      state,
      { ownerEpoch: 1, taskId: "T-A", workerId: "member-a", requestId: "reserve-a" },
      1000,
      allocate
    )
  );
  if (a.result.kind !== "granted") throw Error("grant");
  const lease = a.result.lease;
  record(
    bindBuildInput(
      state,
      lease,
      "bind",
      {
        baseVersion: state.acceptedVersion,
        inputHash: hashJson("input"),
        contentHashes: { "SPEC.md": null, "src/normalize.ts": null }
      },
      1001
    )
  );
  record(admitBuildAction(state, lease, "action", hashJson("input"), { kind: "inspect", path: "SPEC.md" }, 1002));
  record(settleBuildAction(state, lease, "action", hashJson("output"), 1003));
  record(
    reserveBuildScope(state, { ownerEpoch: 1, taskId: "T-B2", workerId: "member-b", requestId: "wait" }, 1004, allocate)
  );
  record(releaseBuildScope(state, lease, "release", 1005));
  const scheduled = scheduleBuildTasks(state, { ownerEpoch: 1 }, 1006, allocate);
  state = scheduled.state;
  trace.push({ scheduled, serializedHash: sha256(JSON.stringify(state)) });
  record(revokeBuildScope(state, scheduled.grants[0]!, "revoke", 1007));
  record(cancelBuildTask(state, { ownerEpoch: 1, taskId: "T-B1", workerId: "member-b", requestId: "cancel" }, 1008));
  record(advanceBuildOwnerEpoch(state, { ownerEpoch: 1 }, "epoch", 1009));
  record(
    reserveBuildScope(
      state,
      { ownerEpoch: 1, taskId: "T-A", workerId: "member-a", requestId: "reserve-a" },
      1010,
      allocate
    )
  );
  record(expireBuildState(state, { ownerEpoch: 2 }, state.deadlineAt));
  return trace;
}
