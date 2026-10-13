# Peer mode in this checkout

Peer mode lets two API members answer the same question independently, exchange replies in synchronized rounds, and assess every active claim. The program preserves each member's position and produces deterministic local reports. It does not appoint a winner or ask a third model to summarize. This is an unreleased local extension of argue 0.6.1; installing the published CLI does not provide these commands.

## Build and configure

Use Node.js 22 or newer in this checkout:

```bash
npm ci
npm run build
cp packages/argue-cli/examples/peer/deepseek-glm.config.example.json peer.config.json
```

The example has two fixed member slots. Each has an API key environment variable and an explicit model ID or model environment variable. Model IDs must resolve to nonempty strings before a session starts. The bundled DeepSeek and GLM profile defaults are examples for the current provider APIs; confirm model availability and account access with each provider. Keep real keys outside the config file. Node's `--env-file=.env` loads keys into the process for the following commands; peer code does not read `.env` itself. Do not commit `.env` or `peer.config.json` if you customize it with private endpoints.

For new GLM 5.3 Flash sessions, the example freezes `thinking: enabled` with `reasoning_effort: low`; an explicit `generationOptions.reasoning_effort` overrides `low`. The [GLM chat completion API reference](https://docs.bigmodel.cn/api-reference/模型-api/对话补全) documents `low`, `high` and `max` for this model family. This controls the provider request, not the protocol's assessment rules. Existing sessions retain their frozen generation options when retried.

```bash
node --env-file=.env packages/argue-cli/dist/cli.js peer start \
  --question "How should this local reminder handle a crash after notification?" \
  --goal "Identify a safe first implementation" \
  --context examples/peer/scenarios/omitted-condition.md \
  --config peer.config.json \
  --max-output-tokens 8192
```

`--max-output-tokens` is a positive per-call cap frozen for both members in a new session. Its default is 4096. The 8192 setting gives models that spend output tokens on reasoning more room; it does not ensure a complete response and it is unavailable as a retry override. Initial discussion runs 2–3 rounds by default. `--rounds 2` caps the initial segment at two. Other optional start flags are `--session-id`, `--root`, repeated `--constraint`, and `--max-calls`. The CLI displays both members, copied source scope and limits before dispatch, and prints a session ID to reuse below.

## Inspect, recover and continue

By default snapshots and exports live under `.argue-peer/<session-id>/`. The root is ignored by Git; `--root DIR` can place sessions elsewhere. Source files are copied into the immutable session snapshot with line numbers, so later edits to the original file do not silently change a running discussion.

```bash
node packages/argue-cli/dist/cli.js peer show SESSION_ID
node --env-file=.env packages/argue-cli/dist/cli.js peer retry SESSION_ID
node --env-file=.env packages/argue-cli/dist/cli.js peer retry SESSION_ID --extra-calls 2 --extend-seconds 600
node --env-file=.env packages/argue-cli/dist/cli.js peer continue SESSION_ID --note "The process may exit immediately after notifying" --rounds 1
```

`show` reads the saved state without a model call. After an unexpected process exit leaves a session marked active, the first `peer retry` only recovers the saved state: it marks in-flight attempts unknown, keeps sealed replies and frozen inputs, saves a pause, makes zero model calls and exits with code 2. Run `peer retry` again to authorize any missing calls. If you supplied `--extra-calls` or `--extend-seconds` during recovery, repeat those flags on the second command; recovery does not apply them. An active snapshot with no in-flight attempt also pauses on the first retry rather than dispatching. For an ordinarily paused session, one `peer retry` resumes it. A valid sealed reply from one member is reused. Retry keeps each frozen input and model/output cap unchanged. If the call budget or deadline is exhausted, extension must be explicit. `continue` requires a completed segment; it starts a new segment with the same two members. It can also take a new `--context` `.md` or `.txt` file. Ctrl+C requests cancellation, waits for saved pause and call cleanup, and exits with a partial session. A paused run exits with code 2; ordinary command errors exit with code 1.

## Local reports

```bash
node packages/argue-cli/dist/cli.js peer export SESSION_ID --format md
node packages/argue-cli/dist/cli.js peer export SESSION_ID --format json --output report.json
node packages/argue-cli/dist/cli.js peer view SESSION_ID
node packages/argue-cli/dist/cli.js peer view SESSION_ID --no-open
```

`export` and `view` are read-only with respect to model calls. JSON uses `resultVersion: "peer.v1"`; Markdown and HTML arrange the same signed records. Markdown puts copied sources in literal code blocks and encodes other supplied markup so it displays as text. `view` writes a standalone HTML file and opens it locally. Its text is escaped and it has no remote scripts, fonts, images, or viewer upload. `--no-open` prints the local file path. The existing Preact viewer can import a peer JSON export through its local file drop area; it still recognizes older argue reports separately.

Reports preserve original claim versions, member conclusions, the two assessment reasons, messages, outstanding replies, evidence requests and uncommitted diagnostic attempts. A sealed single-member reply is marked uncommitted and cannot create a claim, message or assessment until the pair commits. A paused or incomplete review remains labeled incomplete. Usage sums cover observed token fields only and display the number of attempts with usage; an absent field is unknown, not zero. Cost is not inferred. Supplied sources and member responses are not external fact checks; the user decides what to do with the result.

New sessions use prompt version `peer-v5`. Its JSON guidance lists only frozen IDs usable by the current member: pending messages addressed to that member for replies, peer-authored messages and versions for questions, and the member's own latest active versions for revision or withdrawal. A program-generated `responseContract` follows the long history in the user message. It lists the required top-level fields, a concrete phase-specific JSON template and a short completion checklist. Review templates include the exact frozen hash and one slot per version, with stance and rationale set to deliberately invalid null placeholders so each member must supply their own judgment. Discussion contracts list pending reply IDs separately for both members; they do not permit either member to answer for the other. The v5 review schema also states the exact position count. These are generation instructions, not synthesized judgments or automatic response repairs. Shared question/history and the contract are identical for both members; actor-scoped permissions remain in their individual system schemas. `peer-v1` through `peer-v4` sessions retain their exact original prompt, schema and input hash on retry. The schema guidance cannot force a model to follow it.

At the model-response boundary, omitted `assumptions`, `sourceRefs` and `evidenceRequests` arrays become `[]`, and unrelated extra commentary fields are discarded locally without another call. This does not invent evidence or assumptions. Raw content and the original decoded payload remain in the attempt record; the sealed reply uses the canonical payload. Saved-state schemas stay strict and existing frozen prompts remain unchanged. Known fields in the wrong location, identity/authority overrides, null or incorrectly typed arrays, missing phase/hash/claims/actions/positions, invalid actions, incorrect source/version references and incomplete or duplicate review coverage still fail. Both members pass exactly the same normalization and protocol checks against their shared frozen snapshot. Invalid output is saved as a failed attempt and requires explicit retry.

CoThink now adds neutral OpenAI-compatible and native Anthropic-compatible configuration, setup and diagnostics. DeepSeek/GLM have live evidence; the native Anthropic adapter has controlled HTTP tests, while real GPT/Claude accounts still require live verification. See the [current CoThink configuration guide](../cothink/CONFIGURATION.md) and [validation](VALIDATION.md) for the test and live-evidence boundary.
