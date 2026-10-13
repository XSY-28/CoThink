# CoThink

A local CLI for discussions between two equal model peers. Members independently propose claims, exchange questions and revisions, then review every frozen claim version. Local reports preserve both assessments and unresolved issues; no representative or winner is selected.

Requires Node.js 22 or newer and API credentials. Version 0.6.1 is prepared as a standalone source-built tarball; npm registry availability is not claimed.

From the source root:

```bash
git clone https://github.com/XSY-28/CoThink.git
cd CoThink
npm ci
npm run build
npm pack --workspace packages/cothink --pack-destination .
npm install -g ./cothink-0.6.1.tgz
cothink setup
cothink test
cothink start --question "What are the tradeoffs in this proposal?" --context proposal.md
cothink view SESSION_ID
```

`setup` sends no requests and never overwrites existing files. Keys are optional, entered without echo and stored separately; exported environment values take precedence. Defaults are `.cothink/config.json`, `.cothink/keys.env` and `.cothink/sessions/`. `init` creates an editable template. `test` (`doctor`) makes up to four paid requests to check opening/review JSON, with no retries; it is not a model quality test.

The package bundles the peer CLI and core internally, with declared runtime dependencies. Supports explicit OpenAI-compatible and native Anthropic-compatible endpoints/models, plus opt-in DeepSeek/GLM presets. A live DeepSeek Flash / GLM 5.3 Flash connection test passed all four opening/review requests without retry; real GPT/Claude accounts remain unverified. Questions and copied context are sent to the configured APIs. Reports stay local, and HTML opens offline. Agreement is not proof of correctness.

Use `cothink --help` for commands. Full guides are in the [CoThink source repository](https://github.com/XSY-28/CoThink/tree/main/docs/cothink). Built on [onevcat/argue](https://github.com/onevcat/argue), under MIT with the original onevcat copyright notice retained in `LICENSE`.
