# Mycel: product spec (internal reference)

> **Mycel** is the connective layer for AI agents: a drop-in, MCP-compatible gateway that
> makes every tool faster, cheaper and safer, and an agent-to-agent mesh (A2A-compatible)
> on top of it. Named after mycelium, the underground network that links trees and lets
> them share resources and signals.

Tagline: **"One layer between your agents and everything they touch."**
Secondary: **"Your MCP setup, minus the context bloat."**

CLI: `npx mycel init` → imports existing Claude / Cursor / VS Code / Windsurf MCP configs.
Language: TypeScript (Node ≥ 20). License: Apache-2.0. Repo: github.com/SpeakQuery/mycel

## The problem (today's MCP pain)
1. **Context bloat**: every connected server dumps its full tool schemas into the model's context up front. 30 servers ≈ tens of thousands of tokens before the first word.
2. **Everything flows through the model**: moving 10k rows from tool A to tool B means 10k rows in the context window.
3. **Round-trip storms**: a 10-step task = 10 inference turns.
4. **Security bolted on**: tool output can smuggle instructions (prompt injection); tool descriptions can be silently changed (rug pull); API keys sit in prompts.
5. **Tools don't describe their cost**: no latency, price, reversibility.
6. **Long-running AI work (video, render, training) has no home**: calls time out.
7. **Agents can't safely delegate**: sub-agents inherit full credentials.
8. **No black box**: nobody can see what an agent did or why.

## Feature set (all shipped in v1)
| # | Feature | What it does | Meta-tool / surface |
|---|---|---|---|
| 1 | **Smart Tool Router** | Model sees 8 meta-tools instead of 300 tools. BM25 search over the catalog, schemas loaded on demand. | `mycel_search`, `mycel_describe`, `mycel_call` |
| 2 | **Code Mode** | Model writes a short JS script that chains many tool calls; runs in a QuickJS WebAssembly sandbox; only the final result returns. | `mycel_run` |
| 3 | **Ref Store** | Large / binary results are stored content-addressed (`ref://sha256…`) and replaced with a model-sized *digest* (JSON shape, table schema + sample rows, text outline, image/video/audio metadata + keyframes via ffmpeg). Refs pass directly between tools. | `mycel_ref` |
| 4 | **Job Queue** | Long-running calls become jobs: id, progress, cancel, resume, retries, provider fallback. | `mycel_job` |
| 5 | **Cost & Budget** | Per-tool cost/latency contracts; estimate before running; per-task / per-day budget caps. | in `mycel_describe`, `mycel_call` (`dryRun`) |
| 6 | **Tool Contracts** | Every tool gets an effect class (`read`, `write`, `destructive`, `external`), idempotency, cost, latency – inferred from MCP annotations + overridable in config. | `mycel_describe` |
| 7 | **Policy Firewall** | YAML rules: allow / deny / require approval by tool glob or effect. Approvals via MCP elicitation or `mycel approve <id>`. | `policy:` in `mycel.yaml` |
| 8 | **Provenance / Taint** | Content from untrusted sources (web, email, unknown servers) is labelled; destructive actions with tainted inputs require approval. | automatic |
| 9 | **Secret Vault** | Model only sees `{{secret:GITHUB_TOKEN}}`; Mycel injects real values at call time and scrubs them from outputs. | `secrets:` |
| 10 | **Manifest Pinning** | Tool definitions are hashed; silent changes (rug pulls) are detected and blocked until re-approved. | `mycel.lock` |
| 11 | **Flight Recorder** | Every call traced: timing, tokens saved, cost, policy decisions. JSONL + OpenTelemetry (OTLP) export. Replay any task. | `mycel dashboard`, `mycel replay` |
| 12 | **Live Dashboard** | Local web UI: timeline, token savings, cost, jobs, approvals. | `http://localhost:4747` |
| 13 | **A2A Bridge** | Mycel is an A2A agent (Agent Card at `/.well-known/agent-card.json`, JSON-RPC `message/send`, `tasks/get`, `tasks/cancel`) and can call remote A2A agents as tools. MCP + A2A in one layer. | `mycel_delegate` |
| 14 | **Capability Tokens** | Attenuable, expiring, macaroon-style delegation tokens: a sub-agent can only narrow its permissions (tools, effects, budget, expiry), never widen. | `mycel token mint/attenuate` |
| 15 | **Model Router** | Tiered model routing (`fast` / `balanced` / `deep`) to any OpenAI-compatible or Anthropic endpoint, for sub-tasks and digests. | `mycel_ask` |
| 16 | **Universal import** | Reads Claude Desktop, Claude Code, Cursor, VS Code, Windsurf configs. | `mycel init` |
| 17 | **Both transports** | Serve over stdio (desktop clients) or Streamable HTTP (remote / teams). Upstreams over stdio or HTTP. | `mycel serve [--http]` |
| 18 | **Python client** | `pip install mycel-client`: call tools, refs, jobs and A2A from Python. | `python/` |
| 19 | **Benchmark** | Reproducible: same tool catalog, direct MCP vs Mycel – context tokens and round trips. | `mycel bench` |
| 20 | **Plugin adapters** | A provider adapter (e.g. a new video model) is ~50 lines. | `examples/` |

## Architecture
```
 Claude / Cursor / ChatGPT / local LLM           Remote agents (A2A)
                 │  MCP (stdio | HTTP)                 │  A2A JSON-RPC
                 ▼                                     ▼
 ┌──────────────────────────── MYCEL ────────────────────────────┐
 │ Meta-tools: search · describe · call · run · ref · job ·      │
 │             delegate · ask                                    │
 │ ┌────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ┌──────────────┐ │
 │ │ Router │ │Code Mode │ │RefStore│ │ Jobs │ │ Model Router │ │
 │ └────────┘ └──────────┘ └────────┘ └──────┘ └──────────────┘ │
 │ ┌──────────────── Trust layer ───────────────────────────────┐│
 │ │ Policy · Taint · Secrets · Pinning · Capability tokens     ││
 │ └────────────────────────────────────────────────────────────┘│
 │ ┌──────────────── Flight Recorder → Dashboard / OTLP ────────┐│
 └─┴────────────────────────────────────────────────────────────┴┘
        │ MCP            │ MCP            │ MCP          │ A2A
   GitHub server   Video model     Database      Other agents
```

## Benchmark headline (measured by `npm run bench`, fill in real numbers)
Direct MCP with 12 servers / 180 tools vs Mycel meta-tools: tool-definition tokens, a 6-step task's round trips, and bytes through context.

## Design principles
- **Drop-in**: standard MCP clients need zero changes.
- **Local-first**: no account, no cloud, no telemetry.
- **Optional depth**: a 10-line config works; every advanced feature is opt-in.
- **Honest security**: Mycel reduces and exposes risk; it doesn't claim to "solve" prompt injection.
