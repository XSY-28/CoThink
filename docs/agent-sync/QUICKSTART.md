# Run agent-sync from a source checkout

agent-sync is a local collaboration/version tool. A trusted caller supplies a frozen project, exact file scopes, fixed members and trusted checks. The tool owns leases, immutable versions, candidate verification, atomic acceptance and explicit recovery. It does not choose models or tasks. A source checkout is the current delivery form; there is no standalone installed binary, daemon or separately published agent-sync npm package.

The deterministic example below needs no model account, key file, CoThink configuration or private acceptance directory. It uses the existing cart fixture and real disk/Git/Docker. It is a delivery smoke test, not a real user requirement or a collaboration-benefit experiment.

## Environment and build

Validated environment: Apple silicon macOS, host Node.js 24.19.0/npm 11.17.0, system Git and Docker Desktop 4.95.0 / Engine 29.8.2, Linux arm64 validator Node.js 22.23.3. Other platforms and host versions are not verified. Host checks require Node's `registerHooks`; the library's general Node >=22 package metadata alone is not a validation claim for this full example. Docker must already be running, and Git/Node/npm/Docker must be on PATH.

From the checkout root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node tools/agent-sync/build.mjs
```

The locked install does not run lifecycle scripts or install global packages. The build creates workspace `dist` directories and `tools/agent-sync/dist`; do not substitute artifacts from another checkout. Workspace dependencies and public subpath exports come from this monorepo's package manifests and lockfile.

## Build a validator without a private donor image

Image preparation is explicit and may need access to Docker Hub and the npm registry. Verification itself has no network access. Review the trusted base digest, Dockerfile and lockfile before building. The arm64 Node base used in the recorded environment is:

```sh
docker build --pull \
  --build-arg NODE_BASE_IMAGE=node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 \
  --build-arg EXPECTED_NODE_VERSION=22.23.3 \
  -f tools/agent-sync-validator/Dockerfile.source \
  -t agent-sync-validator:source .
IMAGE_ID="$(docker image inspect agent-sync-validator:source --format '{{.Id}}')"
```

`Dockerfile.source` installs the frozen toolchain directly from the lockfile, then copies the generic validator programs. Its adjacent Dockerfile-specific ignore file restricts the build context to package metadata and validator scripts. It does not need the historical `cothink-build-validator` donor, a local-only image ID or any work evidence. The original `Dockerfile` remains for historical reproduction; its default donor is local-only and is **not** the fresh-checkout path.

Use the actual `sha256:…` image ID from your build, never a mutable tag in a job. A rebuild can have a different image ID or dependency-tree identity. The example measures the new image metadata and freezes a new project/check configuration; it does not reuse old passed receipts. The image is locally built, not a published binary release. Other architectures require their own trusted base, build and validation; they are not claimed supported here.

## Complete deterministic transaction

Choose a new output directory whose parent exists. From the checkout root:

```sh
node examples/agent-sync/cart/run.mjs \
  --image "$IMAGE_ID" \
  --output "$(pwd -P)/../agent-sync-cart-smoke"
```

Optional `--docker-context NAME` explicitly selects a local Docker context. Otherwise the example captures `docker context show` and passes it in the job; the tool does not inherit arbitrary Docker/model environment settings. The output path must be canonical; `pwd -P` avoids symlink aliases. Existing output is refused, including a failed earlier run: use a new name and retain failed evidence.

The example makes a four-file project and a single fixed `cart-owner`. Two writable TypeScript files receive repository-provided deterministic reference text; trusted assertions run through the existing isolated verifier. It performs:

1. Inspect the supplied immutable image and read source-free validator metadata.
2. Freeze the project/configuration and write `job.json`; start the explicit tool from the output directory.
3. Request `complete-cart`, freeze input, read each writable file, and edit using its exact old hash.
4. Seal and run a private check; assert that a passed check has **not** changed the formal version or created a publication.
5. Explicitly finish; assert one formal publication, its actual check association and completed status.
6. Request diff/export and compare every exported file to its expected bytes.
7. Close and wait for `writerReleased:true`/exit0 and writer-lock removal.
8. Reopen using `job-reopen.json` without `sourceRoot`; explicitly recover and assert zero replay, no new checks/publications and unchanged deadline/version.
9. Close again and confirm only this example's validator containers are absent.

No candidate JavaScript runs on the host. No model/SDK/discussion is initialized. Managed Git snapshots belong to the example's new workspace; the source checkout is not the transaction target.

## Outputs and failures

Success ends with one stdout JSON summary containing `status:"verified"`, the output path, elapsed time and `modelRequests:0`; exit code is 0. Progress JSON goes to stderr; cleanup inspection may also print expected `no such object` messages for containers already removed. The final summary and recorded checks determine success. In the output directory:

| Path                          | Meaning                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result.json`                 | Step durations, environment and image metadata, project/config/source identities, publication/check IDs, exact export hashes, recovery and cleanup observations |
| `job.json`, `job-reopen.json` | Actual tool input, fixed connections and trusted configuration; the latter omits source import                                                                  |
| `source/`, `trusted/`         | Frozen fixture and trusted oracle/decoder copies                                                                                                                |
| `managed/`                    | Git/content store and private authority; retain locally, do not upload it with source                                                                           |
| `export/`                     | Four files from the formally accepted version, not a private candidate                                                                                          |
| `home/`                       | Private verification working directory owned by this example                                                                                                    |

A check can return `passed:false` with a successful wire response: that is valid failed-check data, not acceptance. A successful finish includes `status:"accepted"` and a publication/check binding. Wire `ok:false` carries a stable `error.code`; the thin client rejects with that code. Missing Docker/image, bad configuration, expired permissions/deadline, failed oracle or changed evidence fail closed. The example records `status:"failed"` and exits1 after entering its recorded setup; invalid CLI input or an existing output path is rejected before a run exists. A failed smoke is not a passed release gate, and is never overwritten or automatically retried.

Review `result.json` and `export/`; no patch is automatically applied to another repository. Outputs can contain source and local paths and should not be published wholesale. Keep API/private configs, logs, managed state, node_modules and dist out of a source upload; rebuild from the declared source and lockfile instead.

## Other callers, cancel and recover

The example is a caller, not an alternate coordinator. Replace its fixture preparation and deterministic text source with your own trusted project/check preparation; keep the same public interfaces:

- Pure contract/service: `@onevcat/argue/agent-sync/project`.
- Local disk/Git/Docker host and config measurement: `@onevcat/argue-cli/agent-sync/project`.
- Explicit JSONL tool: `node /checkout/tools/agent-sync/dist/stdio.mjs --config /absolute/job.json`.
- Thin client: `/checkout/tools/agent-sync/client.mjs`, exporting `ToolHost`, stream clients and task contexts.

The example contains the complete preparation of `options` plus `connections`. `project.mjs` defines the manifest, checks, profiles and oracle artifacts; runtime scripts are in `tools/agent-sync-validator/` and host-side trusted checks in `tools/agent-sync-checks/`. A new project's oracle is a trusted host responsibility, not model-provided shell or a passed flag.

For a granted task, the relevant thin-client calls are:

```js
const grant = await worker.requestScope(taskId, "scope-1");
if (grant.result.kind === "granted") {
  const task = grant.task;
  await task.freezeInput("input-1");
  // read/edit/seal/check/finish as demonstrated in cart/run.mjs
}
// Cancellation is the bound worker's explicit operation; it revokes authority.
await worker.call("cancel", { taskId }, "cancel-1");
await admin.call("close", {}, "close-1");
await host.exited;
// Start a new ToolHost for the same frozen job, await ready, then:
await reopenedAdmin.call("recover", {}, "recover-1");
```

`waiting` grants no task context: pause work and later explicitly request/query the lease, then freeze the latest input. Do not poll models while waiting. `cancel`/`release` revoke permission; a cancellation ACK does not prove a model, Git subprocess or container stopped. `close` releases the writer after pending backend work drains, and cannot undo earlier effects. Disconnecting a client is not cancellation. Recovery validates state and invalidates old permissions with zero automatic model/tool-action replay; explicitly decide what to do next. Never rebind a late result to a newer lease.

Boundaries: ordinary UTF-8 text, exact ASCII file paths/scopes, fixed declared members, trusted local host and a single writer. No arbitrary shell, AST merge, dynamic membership, distributed lock or exactly-once guarantee for failed/unknown work across crashes. Docker and its daemon/base image are trusted; this is not protection against a malicious local administrator.

See [PROTOCOL](PROTOCOL.md) for state/authority/check semantics, [USAGE](USAGE.md) for wire methods and error behavior, [VALIDATION](VALIDATION.md) for evidence and limits, and [PERFORMANCE](PERFORMANCE.md) for measured cost boundaries. CoThink integration and strategy-effect evaluation are separate from this tool's checkout delivery gate.
