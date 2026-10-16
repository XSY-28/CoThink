# Fixed Docker validation toolchain

`DockerVerifier` validates the frozen `examples/todo-stats` construction sample. It never installs host dependencies, builds or pulls an image, executes candidate JavaScript on the host, or falls back to the stage 0 host executor. Missing Docker, a stopped daemon or an absent fixed image raises `DockerUnavailable`; it produces no passed receipt.

The operator must first select a trusted **digest-pinned Node 22+ base image** and its exact Node version. No image digest is supplied by this repository. From the repository root, explicitly build using your verified values:

```sh
docker build --build-arg NODE_BASE_IMAGE="$VERIFIED_NODE_BASE_IMAGE" \
  --build-arg EXPECTED_NODE_VERSION="$VERIFIED_NODE_VERSION" \
  -f tools/build-validator/Dockerfile -t cothink-build-validator .
docker image inspect cothink-build-validator --format '{{.Id}}'
```

`NODE_BASE_IMAGE` must contain `@sha256:` and 64 lowercase hex digits. `EXPECTED_NODE_VERSION` must exactly match the base image's actual Node version, and must be 22 or later. The toolchain build uses the existing repository `package-lock.json` and `npm ci --ignore-scripts`; it copies only package metadata and frozen sample compiler/wiring files. Its final scratch stage retains the frozen filesystem and removes inherited environment metadata. Runtime image IDs (`sha256:…`) and repository digest references (`repository@sha256:…`) are accepted; mutable tags are rejected. Record the actual image ID from `describe`, not a tag.

`describe` inspects and starts a restricted, source-free container to read actual Node/toolchain/script hashes. It compares the frozen compiler configuration, CLI wiring, lockfile, TypeScript bytes and embedded worker programs to the trusted checkout. Its hashes bind those observations, actual image ID, host Node/Vitest tools, frozen tests/fixtures, generated data bridge, groups, parameters and isolation policy. A stage 0 `host-stage0` checksHash is never Docker evidence.

`check` reads an immutable candidate version through the current writer and verifies its content hash. It materializes only the eleven manifest files into a fresh directory. Docker receives that single read-only bind mount; the host oracle workspace and coordination metadata are never mounted. The runtime is nonroot, read-only, network `none`, private PID/IPC namespaces, all capabilities dropped, no new privileges, bounded memory/CPU/processes and two separate tmpfs directories for compilation/output and cache. Actual daemon inspection before and after execution rejects deviations or additional mounts. The image environment is an exact allowlist; neither the Docker socket nor model credentials are exposed.

A fixed image compiler copies frozen configuration into tmpfs, validates the sample's import policy, and compiles candidate TypeScript there. The fixed supervisor never imports candidates. Fixed workers invoke candidate functions or CLI in separate child processes, under a four-second timeout and output bound. Candidate stdout is **data**, never test status or a receipt. Strict JSON envelopes carry normalizer arrays, report strings or raw CLI output; tagged input encoding preserves NaN/Infinity and the oracle's byte-chunk probes.

The original trusted sample Vitest tests and harness run on the host against generated proxy modules. Those proxies contain only trusted Docker bridge code; they never import, evaluate or transpile candidate JavaScript on the host. Host assertions decide success. A candidate can hardcode behavior that satisfies tested fixtures, so a passing result does not prove correctness on every input or resistance to every adversarial program. Container isolation relies on Docker, its daemon and the operator's trusted base image; it is not an OS-independent sandbox proof.

A receipt is emitted only after observed compiler/oracle exit, unchanged candidate source fingerprints, stable check definition, current writer ownership and successful container cleanup. Concrete receipts are frozen and tracked by verifier object identity; a copied or caller-fabricated object fails `ownsReceipt`. Publication still requires Publisher's live identity/lease/profile/CAS checks.

To exercise the **actual container gate**, supply the inspected fixed image ID and run:

```sh
COTHINK_BUILD_VALIDATOR_IMAGE="$VERIFIED_VALIDATOR_IMAGE_ID" \
  npm run test --workspace @onevcat/argue-cli -- test/build/isolation.test.ts
```

The gate runs V0 common, expected V0 final failure, a manually prepared correct final candidate, forbidden source/formal-directory/metadata writes, external network and secret/socket probes, plus forged candidate stdout. It uses real managed Git objects and the real Docker binary. No image means an explicit `NOT VERIFIED` result with no skipped test and no passed isolation receipt; a supplied but unusable image fails the gate. Adapter unit tests use a clearly named simulated Docker transport and cannot establish actual isolation. Stage 3 remains incomplete until the real gate has evidence, including its actual image digest and source hashes.

## Local verification record — 2026-10-15

The actual Apple silicon acceptance environment uses Docker Desktop 4.95.0 / Engine 29.8.2 and an arm64 Node 22.23.3 base:

- Base reference: `node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`.
- Locally built validator image: `sha256:5879132a5e9a30001eb3aff1655af70bc2681d80cba7666e66d12a21d726d1ce`.

The image remains local; it was not pushed to a registry. A fresh build may have a different image ID due to build metadata. Always inspect and record the actual resulting ID. This run built from a minimal context containing only the Dockerfile's ten explicit COPY inputs plus the Dockerfile, excluding credentials, source Git metadata and editable normalize/report candidate code. Frozen types/CLI are trusted toolchain wiring.

With a verified image supplied, run both real gates:

```sh
COTHINK_BUILD_VALIDATOR_IMAGE="$VERIFIED_VALIDATOR_IMAGE_ID" \
  npm run test --workspace @onevcat/argue-cli -- \
  test/build/isolation.test.ts test/build/publisher-isolation.test.ts
```

The isolation gate records complete program receipts and creates additional non-running containers with a wrong network, an extra dummy credential environment entry, or an unexpected metadata mount. All deviations must be refused before candidate execution. Docker may reorder environment entries; validation compares the complete sorted allowlist, still rejecting duplicates, extra entries and changed values.

The Publisher gate uses manually prepared oracle fixtures with actual disk/Git/Docker, including expected V0 rejection, after-check/pre-CAS faults, concurrent private staging, full combination profiles, successful receipt replay, export failure and recovery. This is host-prepared mechanism evidence, with zero model calls. Other fault-matrix tests use clearly identified trusted verifier adapters. Neither category proves physical power-cut reliability or actual model performance.

Structured artifacts and command logs for this run are outside the source checkout, under `../work/construction-stage3/docker-acceptance/`. Gate status must be read from the actual receipts/results; these reproduction instructions alone do not establish completion.
