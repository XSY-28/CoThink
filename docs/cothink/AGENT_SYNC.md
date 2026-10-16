# Build with the independent agent-sync tool

`cothink build sync` runs CoThink's configured models against a frozen agent-sync project. CoThink supplies task goals, calls models and keeps a shared model budget. The external tool owns file scopes, leases, immutable versions, trusted checks and formal acceptance. The tool is usable independently; it receives no model keys or discussion configuration.

This is a construction entry point. It does not turn a discussion's agreement into a passed check, automatically invent trusted tests, or apply an export to your original repository. Existing `cothink build start|show|retry|cancel|export` sessions keep their original format and commands.

## Prepare the tool and project

Follow [agent-sync's source-checkout quickstart](../agent-sync/QUICKSTART.md) to build the tool and a validator. A local checkout with `tools/agent-sync/dist/stdio.mjs`, Git and running Docker is required even when CoThink itself is installed from its tarball. The tool checkout may be a different directory from CoThink. It is explicitly supplied, never downloaded or started as a hidden global daemon.

Prepare a new trusted `job.json` using the [job and protocol reference](../agent-sync/USAGE.md). Its frozen project declares exact paths, workers, task dependencies, check profiles and resource bounds. Host-owned check artifacts and a fixed image digest are mandatory. CoThink consumes this job; it does not generate check authority from model output. Review the project's `planHash` before approving it. The deterministic [cart preparation](../../examples/agent-sync/cart/project.mjs) illustrates the complete data shape.

Create an integration JSON. Every project worker must have exactly one worker connection in the job and a mapping to a configured CoThink member. Every task must have a goal. Names below illustrate a two-worker project; replace them with your actual frozen IDs and canonical absolute paths:

```json
{
  "integrationVersion": "cothink-agent-sync-v1",
  "toolEntry": "/absolute/tool-checkout/tools/agent-sync/dist/stdio.mjs",
  "jobFile": "/absolute/trusted/job.json",
  "members": {
    "state-owner": "member-a",
    "report-owner": "member-b"
  },
  "instructions": {
    "normalize-status": "Implement the declared state normalization contract; preserve existing behavior.",
    "report-lines": "Implement the report contract using the types in the read scope."
  },
  "budget": {
    "maxCalls": 12,
    "maxOutputTokensPerCall": 4096,
    "maxAllocatedOutputTokens": 49152,
    "maxDurationMs": 600000,
    "callTimeoutMs": 60000
  }
}
```

These are shared construction limits, separate from discussion policy. A call reserves its whole output allowance before dispatch; reported usage is recorded separately. Failed, cancelled and unknown requests stay charged. There is no provider retry or automatic model substitution. Task/tool deadlines may be earlier than the caller deadline and still apply. A source project cannot be restarted with a new caller directory to silently reset the existing run.

Use an existing [CoThink model configuration](CONFIGURATION.md), normally `.cothink/config.json`. Both fixed member profiles are parsed, and the worker mappings choose which profile to use. Several workers may map to the same member. Keys remain in the caller's environment or separate key file. Process environment overrides key-file values. The new caller snapshots profiles, task goals, job and budget; later edits to the input files do not change that run.

## Start and inspect

```sh
cothink build sync start \
  --integration /absolute/integration.json \
  --approve-plan sha256:YOUR_REVIEWED_PROJECT_HASH \
  --config /absolute/models.json \
  --env-file /absolute/private/keys.env \
  --root /absolute/new-caller-directory --json

cothink build sync show --root /absolute/new-caller-directory --json
```

The parent of `--root` must exist and the directory itself must be new. Without explicit model config/key-file flags, CoThink uses its normal config path and an existing default key file. The run directory contains local private snapshots, `events.jsonl`, `result.json`, and, on completion, `diff.json`. It contains source-related material and local paths; review before sharing. `show` reads the last saved caller status and current journal count; it does not attach to the writer or contact a model.

Independent tasks can run concurrently. A task waiting on a lock, busy worker or dependency makes zero model requests. When other work finishes, the caller queries the tool for its current permission and freezes the latest accepted input. A request made for one task may have granted another queued task; the caller retrieves that existing lease rather than trying to replace it. RPC traffic is bounded below the tool's in-flight window.

The model receives only its goal, scope, copied current files, content hashes and projected tool feedback. It returns `inspect`, `edit`, `check`, `finish` or `abort`, associated with the exact request ID. Edits contain full text and the expected old content hash. Unknown fields, stale request IDs, writes outside scope and model-supplied authority/check results are rejected. An invalid response pauses the caller; it is not silently repaired or retried. The tool independently validates every operation. A private passed `check` is not a formal accepted version; `finish` requests the tool's current-composition checks and acceptance.

## Cancel, recover and explicitly resume

```sh
cothink build sync cancel --root /absolute/caller-directory --json
cothink build sync show --root /absolute/caller-directory --json

cothink build sync recover --root /absolute/caller-directory --json
# Only after reviewing recovery, and only within the original remaining budget/deadline:
cothink build sync resume --root /absolute/caller-directory --json
```

While a model-free `recover` or `export` owns the caller lock, a new cancel is rejected with `SYNC_CONTROL_BUSY`; retry cancellation after that operation finishes. For an active model caller, `cancel` first returns `cancel-requested` with `acknowledged:false`. The owner observes the marker, aborts local model requests, explicitly cancels every task through its original tool connections, verifies revocation and waits for tool closure. Only its final `result.json` establishes acknowledgement and writer release. Model output arriving after cancellation cannot be applied through a replacement task context. Cancellation cannot undo versions already formally accepted. A cancellation acknowledgement is not proof that a remote provider stopped billing. Explicit cancellation is terminal for this caller and cannot be resumed.

`recover` acquires the caller lock, validates the frozen snapshot and original journal, reopens the tool without source reimport and calls its explicit recovery operation. It loads no credentials and dispatches no model calls. An active owner blocks recovery; an explicit recover may remove a caller lock only when the recorded local PID demonstrably no longer exists. An ambiguous lock, or a recovery guard left by a crashed recovery process, needs manual inspection. If initialization failed before a formal session existed, recovery may complete the original source import; it never reimports an existing session. Agent-sync's own writer lock/recovery rules remain authoritative; CoThink never deletes its locks.

`resume` is a separate human action after `recover`. It reuses the original profiles, goals, budget reservations and absolute deadline. It never replays saved model actions; unfinished tasks get fresh authority and fresh input. Completed tasks are skipped. Unknown earlier effects must be reviewed in recovery evidence. Expired or exhausted runs cannot be extended by this command. Tool startup is bounded at 120 seconds; RPC and total revocation acknowledgement at 150 seconds. Normal closure drains for up to 150 seconds, then only this caller's own child is signalled and, if necessary, killed. Unconfirmed revocation/closure is reported as paused, never acknowledged as success. Cleanup can therefore outlast the model deadline. Close and recovery may leave an accepted partial version; caller completion and accepted partial progress are separate facts.

## Export accepted code

```sh
cothink build sync export \
  --root /absolute/caller-directory \
  --output /absolute/new-export-directory --json
```

Export starts the external tool with the frozen job, requests its formal accepted version and waits for writer release. It makes no model calls, including for partial runs. It never exports an unaccepted private candidate. Compare the exported files and `diff.json`, then decide how to integrate them into your repository; this command does not stage, commit, push or overwrite the original source.

## Reproduce the integration check

Build the workspace and tool, then run:

```sh
npm run build
node tools/agent-sync/build.mjs
node scripts/smoke-cothink-agent-sync.mjs \
  --image sha256:YOUR_LOCAL_VALIDATOR_IMAGE_ID \
  --output /absolute/new-smoke-directory
```

This script prepares the existing cart fixture, packs/installs CoThink into a fresh project and uses a local HTTP server as two deterministic models. It exercises two independent tasks plus a conflicting task, exact edits, private checks, three formal publications, export, close and model-free recovery with the original budget/deadline. It requires real disk/Git/Docker and retains failed output. The fake models emit reference text: this verifies wiring and transaction behavior, not real-model code quality or multi-model benefit. Paid experiments need a separately agreed task and budget.

Current integration scope follows agent-sync: ordinary UTF-8 text, exact ASCII file paths, fixed members, trusted local host/check configuration and one writer. Automatic project planning, discussion-to-build conversion, arbitrary shell actions, AST merge, distributed coordination and automatic repository application are outside this entry point.
