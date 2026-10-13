# Configure and use CoThink

## Local files and credentials

Default paths are relative to the current working directory:

| Purpose                               | Default                |
| ------------------------------------- | ---------------------- |
| Member configuration                  | `.cothink/config.json` |
| Optional credential file              | `.cothink/keys.env`    |
| Session snapshots and default exports | `.cothink/sessions/`   |

`cothink setup` creates the configuration interactively. `cothink init` or `cothink setup --no-input` creates an editable template. No API calls are sent during setup. Key input is hidden; pressing Enter skips it. Configuration contains key **environment variable names**, never entered key values. Entered keys go into the separate environment file, which is created only when needed. New files use mode `0600` and newly created parent directories use `0700` where those POSIX permissions apply. Existing files are never overwritten by setup.

Use `--config PATH` for another config file and `--env-file PATH` for another credential file. Exported process environment values take precedence over values loaded from the file. For commands that call models, the default key file is optional; an explicitly requested file must be readable. Setup may create a new key file at the requested path. CoThink does not automatically read a generic `.env` file.

For example, a key file uses normal environment-file syntax:

```dotenv
PEER_A_API_KEY=replace-with-member-a-key
PEER_B_API_KEY=replace-with-member-b-key
```

These are placeholders. Keep actual credentials out of JSON, command-line arguments and shared reports. Session files contain copied context and model responses, so also inspect them before sharing.

## Member configuration

There are exactly two members. This example selects different protocols; replace both model placeholders with model IDs enabled for your accounts:

```json
{
  "members": {
    "member-a": {
      "profile": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "modelId": "your-openai-compatible-model",
      "apiKeyEnv": "PEER_A_API_KEY",
      "outputMode": "json_object",
      "generationOptions": {}
    },
    "member-b": {
      "profile": "anthropic-compatible",
      "baseUrl": "https://api.anthropic.com/v1",
      "modelId": "your-anthropic-compatible-model",
      "apiKeyEnv": "PEER_B_API_KEY",
      "outputMode": "prompt_json",
      "generationOptions": {}
    }
  }
}
```

The generic profiles have no implicit vendor endpoint, model or tuning defaults. Supply `baseUrl` and `modelId`, or `modelEnv` naming a nonempty environment variable. With an explicit `modelEnv`, its value takes priority and `modelId` is the fallback. With no profile or protocol, the protocol defaults to OpenAI-compatible but still requires explicit endpoint and model resolution. A supplied `protocol` must match the chosen profile.

| Field                | Meaning                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `profile`            | `openai-compatible`, `anthropic-compatible`, `deepseek` or `glm`                                      |
| `protocol`           | Optional explicit transport: `openai-compatible` or `anthropic-compatible`                            |
| `baseUrl`            | HTTP(S) API base endpoint, without embedded username/password                                         |
| `modelId`            | Provider model ID, resolved before a session starts                                                   |
| `modelEnv`           | Optional environment variable for model selection                                                     |
| `apiKeyEnv`          | Environment variable containing the API key; generic defaults are `PEER_A_API_KEY` / `PEER_B_API_KEY` |
| `outputMode`         | `json_object` or `prompt_json`; Anthropic requires `prompt_json`                                      |
| `generationOptions`  | Transport/provider tuning, frozen in the session                                                      |
| `maxInputCharacters` | Optional positive cap used when compiling the shared member inputs                                    |

OpenAI-compatible `json_object` requests API JSON-object mode. Use `prompt_json` for a compatible endpoint that does not support that mode. Both modes still require valid CoThink JSON, phase identity, frozen references and complete review coverage. Native Anthropic uses its Messages API with `prompt_json`; it does not use OpenAI's `response_format`.

### Explicit provider presets

`deepseek` and `glm` are opt-in presets. They are never selected merely because a member slot is A or B. Defaults in this version are:

| Profile    | Endpoint                               | Model fallback   | Key variable       | Tuning                                                   |
| ---------- | -------------------------------------- | ---------------- | ------------------ | -------------------------------------------------------- |
| `deepseek` | `https://api.deepseek.com`             | `deepseek-flash` | `DEEPSEEK_API_KEY` | `thinking: {type: "disabled"}`                           |
| `glm`      | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash`  | `GLM_API_KEY`      | `thinking: {type: "enabled"}`, `reasoning_effort: "low"` |

Their model environment variables are `DEEPSEEK_MODEL_ID` and `GLM_MODEL_ID`. An explicit `modelId` takes priority over the preset's implicit model environment variable; adding `modelEnv` explicitly changes that priority as described above. The GLM preset requires thinking enabled. Availability, allowed tuning and account permissions remain provider-dependent.

See the [generic example](../../packages/argue-cli/examples/peer/generic.config.example.json) and [DeepSeek/GLM example](../../packages/argue-cli/examples/peer/deepseek-glm.config.example.json).

### Native Anthropic tuning

The native adapter rejects unknown `generationOptions` before a request. Supported fields are:

| Field            | Accepted local shape                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `temperature`    | Number from 0 to 1                                                                                    |
| `top_p`          | Number from 0 to 1                                                                                    |
| `top_k`          | Nonnegative integer                                                                                   |
| `stop_sequences` | Array of strings                                                                                      |
| `effort`         | `low`, `medium`, `high` or `max`                                                                      |
| `thinking`       | `{ "type": "disabled" }`, `{ "type": "adaptive" }`, or `{ "type": "enabled", "budget_tokens": 1024 }` |

For enabled thinking, `budgetTokens` is also accepted; both budget spellings must agree if supplied. The budget defaults to 1024, must be at least 1024, and must be smaller than `--max-output-tokens`. That output limit remains the total provider output cap; the adapter does not silently increase it for thinking. Do not combine `temperature` with `top_p`, or enabled/adaptive thinking with `temperature`, `top_p` or `top_k`. Local acceptance does not guarantee that a particular model accepts `effort`, adaptive thinking or every tuning value.

For OpenAI-compatible APIs, generation options are forwarded through the compatible adapter; `reasoning_effort` is mapped to the SDK field that sends it. Supported settings depend on the endpoint. Keep tuning minimal when diagnosing a new provider.

## Test the connection and response contract

```bash
cothink test
cothink test --member member-a --timeout-ms 30000 --max-output-tokens 2048
cothink doctor --json
```

`doctor` is an alias for `test`. Both accept `--config`, `--env-file`, `--member member-a|member-b`, `--timeout-ms`, `--max-output-tokens` and `--json`.

Each selected member receives an independent synthetic opening request and, if opening succeeds, a separate review request against two synthetic frozen versions, one authored by each member. Actual opening output is not inserted into the review fixture. The checks validate transport, final JSON, phase fields, the exact snapshot hash and complete independent review coverage. They send no user context and create no saved discussion session.

At most four paid requests are attempted for both members, or two for a single member. There are no retries or repair calls. Defaults are 30 seconds per call and 2048 output tokens per call. All selected credentials, protocol and supported native tuning are validated before any call; one preflight failure blocks all selected calls. An opening failure skips that member's review, while the other selected member can still be checked.

A successful check establishes that this configuration passed these small requests at that time. It does not establish factual accuracy, long-session reliability or superior answer quality. Failures distinguish missing credentials, invalid configuration/tuning, authentication, rate limits, timeout/cancellation, provider/transport errors, truncation, malformed JSON and protocol validation. Correct the reported cause and rerun explicitly. Increase the output cap when the response is truncated, keeping thinking budgets below that cap.

## Discuss, inspect and recover

```bash
cothink start --question "Review this proposal" --context proposal.md --rounds 2 --max-calls 8 --max-output-tokens 8192
cothink show SESSION_ID
cothink retry SESSION_ID
cothink retry SESSION_ID --extra-calls 2 --extend-seconds 600
cothink continue SESSION_ID --note "A new constraint" --rounds 1
cothink export SESSION_ID --format json --output report.json
cothink view SESSION_ID --no-open
```

| Command               | Options and behavior                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`               | Required `--question`; optional `--goal`, repeated `--constraint` and `--context` (`.md`/`.txt`), `--session-id`, `--rounds`, `--max-calls`, `--max-output-tokens`, `--config`, `--env-file`, `--root` |
| `show SESSION_ID`     | Saved state; `--root`; zero model calls                                                                                                                                                                |
| `retry SESSION_ID`    | Resume a pause; `--extra-calls`, `--extend-seconds`, `--env-file`, `--root`                                                                                                                            |
| `continue SESSION_ID` | New segment after completion; `--note`, repeated `--context`, `--rounds`, `--env-file`, `--root`                                                                                                       |
| `export SESSION_ID`   | Required `--format md\|json\|html`; `--output`, `--root`; zero model calls                                                                                                                             |
| `view SESSION_ID`     | Offline HTML; `--output`, `--no-open`, `--root`; zero model calls                                                                                                                                      |

Initial `--rounds` is 2 or 3, default 3; the driver may enter review after two discussion rounds when both members are ready. Default initial limits are 12 calls and 4096 output tokens per call. Limits are saved with the session. Copied source text and line references stay fixed even if the original file changes.

Invalid output, timeouts or cancellation preserve a paused state. A sealed valid reply from one member is reused on retry, but cannot become a committed claim or assessment until the pair commits. Retry preserves the original model, output cap and frozen input. If the saved budget or deadline is exhausted, extend it explicitly with the retry flags.

After an unexpected process exit leaves an active session, the first `retry` recovers it without calling a model and exits with code 2. Invoke `retry` again to resume. Any requested budget extensions must be repeated on that second command. Ctrl+C requests cancellation and a saved pause. Completed commands exit 0, paused discussions exit 2 and ordinary command failures exit 1.

HTML is generated locally without remote scripts, fonts or uploads. JSON uses `resultVersion: "peer.v1"`. Reports preserve both member conclusions and assessment reasons, claim history, evidence requests and outstanding messages. Observed usage fields are reported with coverage; missing usage is unknown, not zero. CoThink does not infer a price from token counts.

## Compatibility evidence

Setup creates files exclusively and refuses existing paths. If a filesystem failure occurs after writing new private credentials but before saving configuration, the key file is retained for recovery rather than deleted by pathname; inspect the reported path and repair the configuration explicitly.

The CoThink 0.6.1 acceptance run used the source-built `cothink test` with `deepseek-flash` and `glm-5.3-flash`: all four opening/review requests passed, with a 60-second per-call limit and 2048 output-token cap, without retry. This is one bounded live check, not a reliability rate. Earlier OpenAI-compatible DeepSeek/GLM `peer-v5` sessions also completed paired review; see the [validation ledger](../peer/VALIDATION.md). Native Anthropic transport and exact output coverage have controlled local HTTP tests. Real GPT/Claude accounts have not been verified. Neither the protocol tests nor model agreement proves factual quality, and no matched-cost superiority study is claimed.

When running inside your own Git project, add `.cothink/` and any custom credential-file path to that project's `.gitignore`. This repository already ignores its own local data; the CLI does not edit another project's ignore rules.
