# Changelog

## 0.1.1 — 2026-11-26

Found by running Mycel in front of 8 real open-source MCP servers ([field test](examples/field-test)).

- **Search ranking across many servers.** Server-damped IDF (a term used by 40 tools of one server counts as a few documents), synonyms keyed by surface word and weighted 0.3, and a bonus when a tool name is fully explained by the query. A 44-tool server no longer drowns git/fetch/duckduckgo.
- **OAuth sign-in for remote MCP servers** (Canva, Higgsfield, Notion, Linear, …). `mycel login <server>` handles discovery, dynamic client registration, PKCE and refresh. Tokens are stored with mode 0600. `doctor` and `serve` tell you when a sign-in is missing.
- **`annotations: balanced | strict`** per server. Playwright marks even `hover` as destructive, which made every browser step ask for approval. In balanced mode (the default), a destructive annotation needs the tool's name to agree.
- Big text results wrapped in JSON (`{content: "…"}`) are stored as text, so a CSV gets a table digest and grep works line by line.
- `mycel_ref` grep shows a window around the match on very long lines instead of the whole line.
- Verified with the real Canva MCP server: `mycel login canva`, 44 tools, read calls through Mycel. With Canva, 126 tools cost 44.5k tokens direct and 1.05k through Mycel.
- Shell and process execution (`start_process`, `run_command`, …) is always classified `destructive`. Fixes a gap where balanced mode demoted it to `external`.
- `mycel_search` with `server` and no hits lists that server's tools. `mycel_describe` accepts `tool: "x"` and gives a clear error otherwise.
- At full scale: 15 servers and 414 tools cost about 204k tokens direct vs 1.2k through Mycel.
- Better search synonyms (shell/terminal/command, web, edit, list/search, remember, save, history, uncommitted, open/visit → navigate, …). Field-test top-3 accuracy is now 16/16.
- Install with `npm install -g github:SpeakQuery/mycel`. `mycel init` now writes client snippets that call the installed `mycel` command.
- CI runs on Linux, macOS and Windows.
- New: a "Do you need Mycel?" guide with measured break-even numbers, plus the `examples/field-test` suite.

## 0.1.0 — 2026-11-26

Initial release. All 20 features:

1. Smart Tool Router: BM25 search with `meta`, `hybrid` and `passthrough` modes.
2. Code Mode: QuickJS/WASM sandbox for one-script multi-tool workflows.
3. Ref Store: content-addressed `ref://` storage with model-sized digests.
4. Job Queue: progress, cancel, retries, provider fallback chains and resume.
5. Cost and Budget: per-tool contracts, `dryRun` estimates and spend caps.
6. Tool Contracts: effect classes with idempotency, cost, latency and async.
7. Policy Firewall: ordered allow/deny/approve rules with safe defaults.
8. Provenance and Taint: untrusted output labelled, taint follows the data.
9. Secret Vault: `{{secret:NAME}}` injection and output scrubbing.
10. Manifest Pinning: `mycel.lock` hashes and rug-pull blocking.
11. Flight Recorder: JSONL traces, OpenTelemetry export and replay.
12. Live Dashboard: local web UI, token-protected.
13. A2A Bridge: Mycel as an A2A agent and as an A2A client.
14. Capability Tokens: attenuable, expiring delegation tokens.
15. Model Router: `mycel_ask` with fast, balanced and deep tiers.
16. Universal import: `mycel init` reads Claude, Cursor, VS Code, Windsurf and Gemini CLI configs.
17. Both transports: stdio and Streamable HTTP, upstream and downstream.
18. Python client: zero-dependency client package.
19. Benchmark: reproducible `mycel bench`.
20. Adapter SDK: `defineAdapter` for in-process and standalone providers.
