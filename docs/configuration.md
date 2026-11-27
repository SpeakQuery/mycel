# Configuration reference

Mycel is configured with a single file, `mycel.yaml` (`mycel.yml` and `mycel.json` also work). The schema is defined with [zod](https://zod.dev) in [`src/config.ts`](../src/config.ts); this page mirrors it. Every top-level key is optional, so an empty file (or no file) is valid.

- [File discovery and state](#file-discovery-and-state)
- [`servers`](#servers)
- [`policy`](#policy)
- [`budget`](#budget)
- [`refs`](#refs)
- [`router`](#router)
- [`sandbox`](#sandbox)
- [`jobs`](#jobs)
- [`secrets`](#secrets)
- [`pinning`](#pinning)
- [`recorder`](#recorder)
- [`ui`](#ui)
- [`dashboard`](#dashboard)
- [`a2a`](#a2a)
- [`models`](#models)
- [Full example](#full-example)

## File discovery and state

Mycel looks for the config in this order:

1. `MYCEL_CONFIG` environment variable (path to the file).
2. `mycel.yaml`, `mycel.yml` or `mycel.json` in the current directory, then each parent directory up to the filesystem root.
3. `~/.mycel/mycel.yaml`.

If none is found, defaults are used. Files ending in `.json` are parsed as JSON, everything else as YAML.

**State directory.** Mycel stores refs, traces, jobs and approvals in `.mycel/` next to the config file. Set `MYCEL_HOME` to put it somewhere else. With no config file at all, state goes to `~/.mycel/`.

**Lock file.** Pinned tool hashes are stored in `mycel.lock`, next to the `.mycel/` directory (so next to the config file by default). Commit it if you want drift detection to be shared across a team.

## Secret placeholders

Any string value that is passed to an upstream server or peer can contain `{{secret:NAME}}` (`NAME` matches `[A-Za-z_][A-Za-z0-9_]*`). Mycel replaces the placeholder with the real value at call time and scrubs the value from anything returned to the model. A placeholder whose secret is not available causes an error. Typical places: `servers.*.env`, `servers.*.headers`, `a2a.tokenSecret`, `a2a.peers.*.token`, `models.*.apiKey`. See [`secrets`](#secrets) for where values come from.

## `servers`

Type: map of server name to server entry. Default: `{}`. The server name becomes the prefix of tool ids (`<server>.<tool>`).

A server is either a **stdio** server (has `command`) or an **HTTP** server (has `url`), plus the common fields.

### Stdio form

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | required | Executable to spawn. |
| `args` | string[] | `[]` | Arguments for the command. |
| `env` | map string to string | `{}` | Extra environment variables. Values may use `{{secret:NAME}}`. |
| `cwd` | string | none | Working directory for the process. |

### HTTP form (Streamable HTTP)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string (valid URL) | required | MCP endpoint of the remote server. |
| `headers` | map string to string | `{}` | Extra HTTP headers. Values may use `{{secret:NAME}}`. An `Authorization` header turns OAuth off for this server. |
| `oauth` | `false` or object | on | OAuth 2.1 sign-in per the MCP authorization spec: discovery, dynamic client registration, PKCE and refresh. Run `mycel login <name>` once. Tokens are stored in `<home>/oauth/<name>.json` with mode 0600. Optional fields: `clientId`, `clientSecret` (may be `{{secret:NAME}}`) for servers without dynamic registration, `scope`, `callbackPort` (default `33418`). Set `false` to disable. |

```yaml
servers:
  canva:
    url: https://mcp.canva.com/mcp        # then: mycel login canva
```

If a server needs a sign-in and you haven't done it, `mycel doctor` and `mycel serve` say so (`Run: mycel login canva`) instead of failing silently.

### Common fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `trust` | `trusted` or `untrusted` | `trusted` | Output of `untrusted` servers is labelled and taints downstream calls. |
| `enabled` | boolean | `true` | Set `false` to skip connecting to the server. |
| `description` | string | none | Free-text note about the server. |
| `annotations` | `balanced` or `strict` | `balanced` | How far to believe the server's MCP tool annotations. Some servers mark every non-read tool `destructiveHint: true` (Playwright marks `hover`). In `balanced` mode, such a tool is classed `external` unless its name looks like it writes, deletes or runs code. `strict` takes annotations at face value. |
| `tools` | map tool name to contract override | `{}` | Per-tool contract overrides (below). |

### Tool contract overrides (`servers.<name>.tools.<tool>`)

All fields are optional. Declared values win over values inferred from MCP annotations and tool names.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `effect` | `read`, `write`, `external` or `destructive` | inferred | Effect class used by the policy engine. |
| `idempotent` | boolean | inferred | Safe to retry or resume without double effects. |
| `costUsd` (alias: `cost`) | number >= 0 | none | Estimated cost per call, used for budgets and `dryRun`. |
| `latencyMs` | number >= 0 | none | Expected latency in milliseconds. |
| `async` | boolean | inferred | Always run as a background job. |
| `fallback` | string[] | none | Ordered tool ids to try when this tool fails (for example `["backup.generate_video"]`). |
| `retries` | integer 0 to 10 | none | Retry count with backoff. |
| `errorsAreRejections` | boolean | `false` | Only matters when `costUsd` > 0. By default a paid tool's `isError` result is treated as "outcome unknown" (the provider may have accepted and charged the call, e.g. a lost HTTP reply): Mycel charges the `costUsd` estimate, marks the job `unknown` and does not fall back; it retries only if this tool is `idempotent: true` and has an `idempotencyKeyArg`. Set `true` only if this provider's error results guarantee nothing was charged end to end (not merely that the backend sometimes does not charge: an adapter that turns a lost connection into `isError` does not give that guarantee); they are then treated as rejected and `fallback` / `retries` apply. Free tools (`costUsd` 0 or unset) always treat `isError` as rejected. |
| `idempotencyKeyArg` | string | none | Name of a tool argument that carries an idempotency key. For jobs, Mycel generates one stable key per job (`mycel-<jobId>`, persisted) and sends it under this name on every attempt, including retries and after a restart, so a provider that dedups by key charges once. A value you pass in `args` is never overwritten. Pair with `idempotent: true` to resume the job after a restart. Whether a provider actually dedups on the key is the provider's behaviour; Mycel cannot verify it. |

Unknown keys in a tool contract override are an error; `cost` is an alias of `costUsd`.

Money safety for jobs: every money decision uses the contract of the tool that was actually sent, not the job's primary tool. In a `fallback` chain the contract of each tool (`costUsd`, `idempotent`, `retries`, `errorsAreRejections`, `idempotencyKeyArg`) governs its own attempts: a free, idempotent primary with `retries: 2` does not make its paid fallback retryable.

- Every attempt is recorded on the job (`dispatches`: tool, `estCostUsd` in force at dispatch, `outcome` = `succeeded` / `rejected` / `unknown` / `interrupted`, `charged`) and shown in the job view. A paid attempt whose result never arrived (unknown, interrupted by a restart, or cancelled after dispatch) is charged its stored estimate exactly once (marked `costEstimated`), including when a later attempt succeeds. The estimate stays on the ledger until you reconcile with the provider; Mycel cannot tell "accepted" from "never reached the provider" for these.
- After an unknown outcome Mycel never falls back. It re-sends to the same tool only if that tool is `idempotent: true` and, when `costUsd` > 0, also has `idempotencyKeyArg` (the same key is re-sent).
- After a restart, a job whose last request to a paid tool has no recorded outcome is resumed only if that tool has `idempotent: true` and `idempotencyKeyArg` (it continues at that tool with the same key). Otherwise nothing is re-dispatched, the job is `interrupted` and the estimate is charged once; check the provider before re-submitting. A manual `mycel_job retry` after a possibly accepted request deliberately reuses the same key, so a deduplicating provider can collapse it into the original request. Mycel keeps one estimate per (tool, key): a later success replaces the earlier estimate with the actual charge (never both), and a later unknown adds nothing. A provider that ignores the key may bill again. Dispatches without a key are each charged. Jobs recorded by 0.1.3 or earlier are not re-settled on upgrade.

## `policy`

Type: list of rules. Default: `[]`.

Rules are evaluated **top to bottom and the first match wins**. A rule matches when every field present in its `match` matches; an empty `match` matches every call.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `match.tool` | glob string | any | Matches the full tool id `<server>.<tool>`. `*` matches any run of characters, `?` one character; case-insensitive. |
| `match.server` | glob string | any | Matches the server name. |
| `match.effect` | `read`, `write`, `external` or `destructive` | any | Matches the tool's effect class. |
| `match.tainted` | boolean | any | Matches whether the call's inputs derive from untrusted content. |
| `action` | `allow`, `deny` or `approve` | required | `allow` runs the call, `deny` rejects it, `approve` asks a human first. |
| `reason` | string | `policy rule #N` | Message shown with the decision. |

If no rule matches, two built-in defaults apply, in this order:

1. If the inputs are tainted and the tool's effect is `destructive` or `external`, the call requires approval.
2. If the tool's effect is `destructive`, the call requires approval.

Everything else is allowed. Capability tokens held by delegated agents are checked before the rules and can only narrow what is permitted. Because user rules run first, a rule such as `{ match: { effect: destructive }, action: allow }` overrides the defaults; use it with care.

In non-interactive clients (no MCP elicitation) nobody can approve inline. Pre-approve with a rule above the approving rule, e.g. `policy: [{ match: { tool: "github.add_label" }, action: allow }]` or `{ match: { server: "github", effect: write }, action: allow }`. Rules are first-match-wins.

## `budget`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `perTaskUsd` | number | none (no cap) | Spend cap per task. |
| `perDayUsd` | number | none (no cap) | Spend cap per day. |

## `refs`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `inlineLimitBytes` | positive integer | `8000` | Results larger than this are stored as `ref://` handles with a digest. |
| `dir` | string | `<home>/refs` | Directory for the ref store. |

## `router`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `auto`, `meta`, `hybrid` or `passthrough` | `auto` | `auto` resolves to compact (every tool directly + `mycel_run`/`mycel_ref`/`mycel_job`) while tool definitions stay under `autoThresholdTokens`, otherwise `meta`. `meta` exposes only Mycel meta-tools; `hybrid` also exposes the top N most-used tools directly; `passthrough` exposes everything with no meta-tools. |
| `autoThresholdTokens` | integer > 0 | `4000` | Size of the tool catalog (estimated tokens) at which `auto` switches to `meta`. |
| `hybridTop` | integer >= 0 | `10` | Number of directly exposed tools in `hybrid` mode. |

## `sandbox`

Limits for Code Mode scripts (QuickJS/WASM).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `timeoutMs` | positive integer | `30000` | Wall-clock limit per script. |
| `memoryMb` | positive integer | `64` | Memory limit. |
| `maxToolCalls` | positive integer | `200` | Maximum tool calls a script may make. |

## `jobs`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `inlineWaitMs` | integer >= 0 | `120000` | How long `mycel_call` waits inline for an async tool before it returns a job id (which costs the model a `mycel_job` turn). While waiting, Mycel sends an MCP progress notification every `heartbeatMs`. A call can override it with `wait` (seconds; `0` = return the job at once). Clients that give up after ~60 s and do not reset their timeout on progress need a smaller value (e.g. `50000`), or raise their tool timeout (Claude Code: `MCP_TOOL_TIMEOUT`). |
| `asyncThresholdMs` | positive integer | unset | Deprecated alias of `inlineWaitMs`, used only when `inlineWaitMs` is not set. (Before 0.1.7 the default was `20000`.) |
| `heartbeatMs` | positive integer | `10000` | Interval of the progress notifications sent while a call waits inline (only when the client asked for progress). |
| `concurrency` | positive integer | `4` | Jobs running at the same time. |

## `secrets`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `source` | `env` or `file` | `env` | `env` reads from the process environment; `file` also reads a dotenv-style file (`NAME=value` per line; values may be quoted). Process env is still used as a fallback. |
| `file` | string | none | Path of the dotenv-style file when `source: file`. |
| `allow` | string[] | none (all names) | If set, only these secret names can be resolved. |

## `pinning`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Hash tool definitions into `mycel.lock` and detect changes. |
| `onDrift` | `block` or `warn` | `block` | `block` disables changed tools until `mycel pin --accept`; `warn` only records the drift. |

## `recorder`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Write JSONL traces to `<home>/traces`. |
| `otlpEndpoint` | string | none | OpenTelemetry OTLP/HTTP collector, for example `http://localhost:4318`. |
| `redact` | boolean | `true` | Redact sensitive values in recorded spans. |

## `ui`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `savingsLine` | boolean | `false` | Append the one-line savings summary (`Mycel · this call: ≈13,240 → ≈1,710 tokens (−87% size, measured · tokens ≈ chars/4) · session: ≈−48,300 · tool definitions: ~−202k/turn (estimated)`) to each tool result as a final text block, so the model and you can see it. It costs about 30-40 tokens per call. The same data is always attached to MCP results as `_meta["mycel/savings"]` and recorded in the flight log. See [See what you save](../README.md#-see-what-you-save). |
| `savingsLog` | boolean | `true` | Log the same line to stderr in `mycel serve`. |

## `dashboard`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `port` | integer | `4747` | HTTP port for the dashboard, `/mcp` and A2A. |
| `host` | string | `127.0.0.1` | Bind address. |

## `a2a`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `mycel` | Agent name in the Agent Card. |
| `description` | string | `A Mycel gateway exposing tools as an A2A agent.` | Agent Card description. |
| `peers` | map name to peer | `{}` | Remote agents Mycel can delegate to. |
| `tokenSecret` | string | none | Root key for capability tokens (may be `{{secret:NAME}}`). Falls back to the `MYCEL_TOKEN_SECRET` environment variable. |
| `requireToken` | boolean | `true` | Require a token for A2A requests. |

Peer entry (`a2a.peers.<name>`):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string (valid URL) | required | Base URL of the peer agent. |
| `description` | string | none | Free-text note. |
| `token` | string | none | Bearer token sent to the peer (may be `{{secret:NAME}}`). |
| `trust` | `trusted` or `untrusted` | `untrusted` | Trust level of the peer's output. |

## `models`

Type: map of tier name to model tier. Default: `{}`. Enables `mycel_ask`. The names `fast`, `balanced` and `deep` get fallback ordering; other names are allowed.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `openai` or `anthropic` | `openai` | API style. `openai` works with any OpenAI-compatible endpoint. |
| `model` | string | required | Model name. |
| `baseUrl` | string | provider default | Endpoint base URL (for Ollama, vLLM, LM Studio, OpenRouter and so on). |
| `apiKey` | string | none | API key (may be `{{secret:NAME}}`). Falls back to `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. |
| `costPer1kTokensUsd` | number | none | Cost used for accounting. |

## Full example

```yaml
servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_TOKEN: "{{secret:GITHUB_TOKEN}}" }
    description: GitHub issues and pull requests
    tools:
      delete_repository: { effect: destructive }
  studio:
    url: https://studio.example.com/mcp
    headers: { Authorization: "Bearer {{secret:STUDIO_KEY}}" }
    tools:
      generate_video:
        effect: external
        async: true
        idempotent: false
        costUsd: 0.40
        latencyMs: 60000
        fallback: ["backup.generate_video"]
        retries: 1
  web:
    command: node
    args: ["./web-server.mjs"]
    cwd: ./tools
    trust: untrusted
  old-server:
    command: ./legacy
    enabled: false

policy:
  - match: { tool: "github.*delete*" }
    action: deny
  - match: { effect: destructive }
    action: approve
  - match: { tainted: true, effect: external }
    action: approve
    reason: Untrusted content is trying to send something out.
  - match: { server: "web" }
    action: allow

budget: { perTaskUsd: 5, perDayUsd: 50 }
refs: { inlineLimitBytes: 8000 }
router: { mode: hybrid, hybridTop: 10 }
sandbox: { timeoutMs: 30000, memoryMb: 64, maxToolCalls: 200 }
jobs: { inlineWaitMs: 120000, concurrency: 4 }
secrets: { source: file, file: ./.env.mycel, allow: [GITHUB_TOKEN, STUDIO_KEY, ANTHROPIC_API_KEY, MYCEL_TOKEN_SECRET, RESEARCHER_TOKEN] }
pinning: { enabled: true, onDrift: block }
recorder: { enabled: true, otlpEndpoint: "http://localhost:4318", redact: true }
ui: { savingsLine: false, savingsLog: true }
dashboard: { port: 4747, host: 127.0.0.1 }

a2a:
  name: my-mycel
  description: Tools of my team, behind one policy.
  requireToken: true
  tokenSecret: "{{secret:MYCEL_TOKEN_SECRET}}"
  peers:
    researcher:
      url: https://research.example.com
      token: "{{secret:RESEARCHER_TOKEN}}"
      trust: untrusted

models:
  fast: { provider: openai, baseUrl: "http://localhost:11434/v1", model: llama3.2 }
  balanced: { provider: anthropic, model: claude-haiku-5-5, apiKey: "{{secret:ANTHROPIC_API_KEY}}" }
```
