# CoThink

**[中文](README_CN.md) | [日本語](README_JP.md)**

CoThink is a local CLI for discussing a question with two equal model peers. Each answers independently, exchanges questions and revisions, then reviews every frozen claim version. You get a local report with both assessments, evidence requests and unresolved issues.

For example, supply a design note and ask how a reminder should recover after a crash:

```bash
cothink start --question "How should this reminder recover after a crash?" --context design.md
cothink view SESSION_ID
```

The report preserves what each member proposed and why each accepted, rejected or remained uncertain about a claim. There is no main agent, representative or winner. Agreement is a recorded outcome, not proof of correctness or an improvement over a single model.

## Requirements and installation

Use Node.js 22 or newer and npm. You need API access for two configured members, which can use OpenAI-compatible or native Anthropic-compatible endpoints. Model availability and API usage charges depend on your provider.

From this source checkout:

```bash
git clone https://github.com/XSY-28/CoThink.git
cd CoThink
npm ci
npm run build
npm pack --workspace packages/cothink --pack-destination .
npm install -g ./cothink-0.6.1.tgz
cothink --version
```

CoThink is prepared as a standalone tarball; it has not been published to the npm registry. The tarball bundles the peer CLI and core internally. See the [installation guide](docs/cothink/INSTALL.md) for local use without a global install.

## Quick start

```bash
cothink setup
cothink test
cothink start --question "What are the tradeoffs in this proposal?" --context proposal.md
cothink show SESSION_ID
cothink view SESSION_ID
cothink export SESSION_ID --format md --output report.md
```

`setup` asks for each protocol, endpoint, model and key environment variable. Optional key entry is hidden and saved separately; you can skip it and use existing environment variables. It sends no API requests and never overwrites an existing config or key file. Defaults are `.cothink/config.json`, `.cothink/keys.env` and `.cothink/sessions/` in the current directory. `cothink init` creates an editable template without prompting.

`test` checks an independent opening and a synthetic review of two frozen claim versions per selected member. It makes up to four paid API requests, or up to two with `--member member-a`. Local configuration, credentials and supported tuning are checked before any request; there are no retries. This checks connectivity and output shape, not answer quality.

## Limits and recovery

- Exactly two member slots: `member-a` and `member-b`. Both receive the same copied sources and must independently review the complete frozen version set.
- New sessions use `peer-v5`. Input snapshots and valid replies are saved; invalid or truncated output pauses the session. Retry is explicit and preserves the frozen request.
- `cothink retry SESSION_ID` resumes a paused session. After a process crash, its first invocation only recovers state without model calls; invoke it again to resume.
- `cothink continue SESSION_ID --note "Additional constraint" --rounds 1` starts another segment after the current one completes. `show`, `export` and `view` make no model calls. HTML reports open offline.
- Model requests send the question, copied context and relevant discussion history to the configured endpoints. Session files and exports contain that material; review them before sharing.
- A bounded live `cothink test` with DeepSeek Flash and GLM 5.3 Flash passed all four opening/review requests without retry. The native Anthropic adapter has controlled local HTTP tests. Real GPT/Claude accounts have not been verified. Provider compatibility does not guarantee complete structured output or factual correctness.

## Documentation

- [Discussion mode implementation plan](docs/plan/discussion-v1.md): thinking effort, participation and decision weights, version-specific consensus, early stopping and final answers with dissent. These features are planned; the current baseline produces peer reports and displays discussion output.
- [Installation](docs/cothink/INSTALL.md)
- [Configuration, diagnostics and command reference](docs/cothink/CONFIGURATION.md)
- [Release preparation and verification](docs/cothink/RELEASE.md)
- [Peer protocol and earlier validation evidence](docs/peer/VALIDATION.md)
- [Archived upstream argue documentation](docs/upstream/README.md)

CoThink builds on [onevcat/argue](https://github.com/onevcat/argue). The existing argue library, CLI and viewer remain in this monorepo; their representative-based debate flow is documented in the archive. Licensed under [MIT](LICENSE), retaining the original onevcat copyright notice.
