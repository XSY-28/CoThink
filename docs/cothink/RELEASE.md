# Prepare a CoThink release

CoThink 0.6.1 is a standalone package prepared from this monorepo, hosted at [XSY-28/CoThink](https://github.com/XSY-28/CoThink). This document covers verification and an installable artifact. The source repository does not imply that a GitHub Release or npm registry package has been published.

## Package boundary

`packages/cothink` provides the `cothink` executable. Its build bundles the peer CLI and core into `dist/cli.js`; it retains runtime SDK/schema dependencies. It does not resolve new peer functionality from the published upstream core. The package includes `dist`, its README and the MIT license.

The existing argue packages remain available separately. Their former tag-triggered publishing process is retained as historical upstream documentation. Preserve the original onevcat license notice when distributing the new tarball or source.

## Verify before distributing

Run from the source root:

```bash
npm ci
npm run format:check
npm run lint
npm run ci
npm run smoke:pack
npm run smoke:cothink
npm pack --workspace packages/cothink --pack-destination .
```

`ci` covers typechecking, tests and builds. `smoke:pack` checks the existing argue packages; `smoke:cothink` installs the CoThink tarball into a clean temporary project and exercises its executable outside the monorepo, including help/version, template creation, configuration failures and a controlled HTTP peer workflow. `npm run release:check` combines builds, CI and both packaging checks. Loopback tests establish request handling and protocol validation; they do not verify a real GPT/Claude account.

Inspect the package list before sharing:

```bash
npm pack --workspace packages/cothink --dry-run
```

Only intended runtime files, package metadata, README and license should be included. Do not include keys, `.env`, `.cothink/`, private endpoints, session snapshots or transcripts. Check the source archive separately; tarball allowlisting does not sanitize an entire checkout.

For a bounded real-provider check, run `cothink test` using your own credentials after reading its [paid request limit](CONFIGURATION.md#test-the-connection-and-response-contract). Report the provider/model, protocol, attempted call count and outcome without credentials or private transcript content. Keep controlled local tests, real-provider evidence and unanswered quality questions distinct.

## Current acceptance evidence

Local acceptance for CoThink 0.6.1 passed all 622 tests and a fresh tarball installation smoke check. The [baseline validation record](BASELINE_VALIDATION.md) records the fresh checks before the first CoThink GitHub upload and outstanding dependency audit findings. The installed CLI previously passed a bounded real `cothink test` with `deepseek-flash` and `glm-5.3-flash`: four requests, successful opening and two-version review for both members, a 60-second per-call limit and 2048 output-token cap, without retry. Real GPT/Claude accounts remain unverified. These observations establish the checked behavior, not a repeated reliability rate or answer-quality advantage.

## Validation workflow

[`.github/workflows/release.yml`](../../.github/workflows/release.yml), named **CoThink release validation**, runs on `v*` tag pushes or manual dispatch. It validates the checkout, packs CoThink and uploads the tarball as the Actions artifact **cothink-package**. It does not publish to npm or create a GitHub Release. The [CI workflow](../../.github/workflows/ci.yml) checks Node.js 22 and 24 and builds before testing.

Local validation does not establish a remote GitHub Actions result. Check the [repository's Actions runs](https://github.com/XSY-28/CoThink/actions) for each uploaded commit. A tag push is separate from a source baseline upload.

## Artifact and clean installation

The expected versioned output is `cothink-0.6.1.tgz`. After verification, install that artifact in a clean environment:

```bash
npm install -g ./cothink-0.6.1.tgz
cothink --version
cothink --help
```

Record the archive checksum and validation results alongside the artifact. A release note should state Node requirements, installation from the tarball, protocol support, migration/recovery limits and which real providers were tested. Link only to release assets that actually exist.

## Publication is a separate step

The source baseline is maintained in `XSY-28/CoThink`. Uploading a release asset, pushing tags and publishing to npm require separate authorization. The CoThink validation workflow contains no publishing step; registry publication and GitHub Release creation would require a separately configured procedure.

Keep package versions aligned with the monorepo's canonical version when preparing another release. Follow [repository instructions](../../AGENTS.md) for the existing workspaces, and update this guide whenever the actual CoThink release workflow changes.
