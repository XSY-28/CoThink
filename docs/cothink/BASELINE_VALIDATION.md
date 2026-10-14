# CoThink source baseline validation

Date: 2026-10-13. Baseline: CoThink 0.6.1, `peer-v5`. Local environment: Node.js 24.19.0, npm 11.17.0 on macOS.

This snapshot preserves the existing equal-peer discussion CLI before the [discussion mode plan](../plan/discussion-v1.md) is implemented. Thinking effort, participation weights, decision weights, answer consensus, early stopping and hidden discussion are planned features. The current CLI produces peer reports and displays committed discussion output.

## Fresh local checks

| Check                   | Result                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                | Passed with the committed lockfile; audit findings below remain                                                               |
| `npm run build`         | Passed for all four workspaces                                                                                                |
| `npm run check`         | Passed for all four workspaces                                                                                                |
| `npm run lint`          | Passed                                                                                                                        |
| `npm run format:check`  | Passed                                                                                                                        |
| `npm run test`          | 622 passed: core 131, CLI 400, viewer 85, CoThink 6                                                                           |
| `npm run smoke:pack`    | Passed: upstream library and CLI can install outside the monorepo                                                             |
| `npm run smoke:cothink` | Passed: fresh tarball install, help/version/init, four-call diagnostics, eight-call peer discussion, show/export/offline view |

The packaging tests use controlled local HTTP endpoints. They made no paid model requests. These checks do not establish real GPT/Claude account compatibility or an answer-quality improvement over one model.

## Publication scope

The source tree retains argue's Git history and original MIT copyright notice. CoThink's standalone package points to `XSY-28/CoThink`; the inherited packages retain their upstream identities.

Before upload, candidate source files and reachable historical blobs were checked against the configured local API credential values and common credential/private-key shapes. No matches were found. Private configuration, `.env`, `.cothink/`, `.argue-peer/`, session transcripts, build output, dependency directories and tarballs are excluded from the source commit. This is a scoped credential check, not a comprehensive security audit.

## Outstanding dependency findings

At baseline validation time, `npm audit` reported 23 dependency findings: 7 low, 3 moderate, 8 high and 5 critical. Development dependencies include high and critical findings. `npm audit --omit=dev` reported 5 low findings and no moderate, high or critical findings in the production dependency graph.

The lockfile is preserved for a reproducible baseline; these findings have not been fixed in this snapshot. Dependency remediation needs a separate scoped change and the same build, test and package checks. Test success does not establish that dependencies are free of vulnerabilities. Audit output can change as advisories are updated.

## Remote verification

The source CI workflow checks Node.js 22 and 24 on Ubuntu, including lint, formatting, typechecking, build, tests and both packaging checks. Its definition alone is not a successful run. Inspect the [Actions results](https://github.com/XSY-28/CoThink/actions) for the uploaded commit.

No npm publication, GitHub Release or deployment is part of this baseline upload.

## Stage 0 revalidation

On 2026-10-13, the uploaded `af34aac` baseline was cloned with a clean working tree and rechecked on the same Node.js 24.19.0 / npm 11.17.0 macOS environment. Install, build, check, lint, formatting and both package smoke checks passed. The first test run had 621 passing tests and one existing random request-ID collision (999 distinct IDs out of 1000); a full rerun before source changes passed all 622. The collision remains unresolved, rather than being counted as fixed by a rerun.

Stage 0 captures synthetic frozen requests and a paused peer-v5 snapshot for compatibility tests. The extraction and its fresh validation evidence are recorded in [discussion-progress.md](../plan/discussion-progress.md). No real model API, push, publication or deployment was performed.
