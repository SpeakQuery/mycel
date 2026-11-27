# Changelog

## 0.1.6 — 2026-11-27

- Added: a one-line savings summary after tool calls that keeps **measured** and **estimated** numbers apart. Measured is exact for what Mycel saw: raw upstream result tokens vs tokens returned to the model (`chars / 4`), per call and per session, for `mycel_call`, direct tool calls, `mycel_run` (the run, counted once) and finished async jobs. When Mycel returns more than the raw result it says `+N` and subtracts it from the session total. Estimated is the tool-definition saving, counted once per `tools/list` served, always labelled as only applying to clients that send every tool definition each turn.
- Added: a `savings` field on flight-recorder events, a **Savings** panel in the dashboard, the line on stderr in `mycel serve` (`ui.savingsLog`), `_meta["mycel/savings"]` on MCP tool results, and `mycel stats [--json]` (latest session and today, measured and estimated printed separately).
- Added: opt-in `ui.savingsLine: true` appends the line as a last text block of the tool result (default `false`; about 30-40 tokens per call).
- Changed: `tokensSaved` (flight log events, `liveStats()`/`historicalStats()`, dashboard "Tokens saved", `mycel traces`, OTLP `mycel.tokens_saved`) now means measured savings only. It no longer includes the tool-definition estimate from `tools/list` and no longer double counts `mycel_run` inner calls (the run carries the counted total). On stats it is net (saved minus added); the estimate is in `estimated`. Historical traces written by earlier versions keep their old values.
- Changed: the savings line now says what is measured: a size, with tokens approximated as chars/4 (`≈`, "measured · tokens ≈ chars/4", "−87% size"); `_meta` gains `unit: "chars/4 tokens (approx.)"`, `mycel stats` and the dashboard say the same. Docs state that real tokenizers differ (one small body: 143 estimated vs 223 by the Qwen tokenizer; the 420-tool catalog agreed within ~2% for cl100k/o200k).
- Fixed: `mycel_describe`, `mycel_ref` and `mycel_job` requests, calls to unknown tools, invalid refs and `dryRun` calls left no trace. They now record `describe`, `ref`, `job` and `call` events (ids, action and result size only), and a failing meta-tool request records an error event. README and SECURITY wording narrowed to what is recorded.
- Unchanged: the tool definitions, instructions and result text are byte-identical with the new options off (full-scale example still 1,253 tokens through Mycel).

## 0.1.5 — 2026-11-27

From the fifth independent review (manual retry of a paid job recorded 0.80 USD for one 0.40 USD provider receipt):

- Fixed (money): money is now settled per (tool, idempotency key). When a later dispatch with the same tool and key succeeds, the earlier estimate for that key is replaced by the actual charge (never both); if the later one is also unknown, there is still one estimate per key. Dispatches without a key are each charged as before. Dispatches now record the key they sent.
- Clarified (behaviour, not a change): a manual `mycel_job retry` of a job whose last paid dispatch is unresolved reuses the SAME idempotency key on purpose, so a deduplicating provider can collapse it into one receipt. The docs (and an earlier changelog claim) said a manual retry drops the key and uses a new one; that was wrong in 0.1.4 (the key was regenerated to the same value, `mycel-<jobId>`) and is now deliberate and documented.
- Known limit: jobs recorded by 0.1.3 or earlier are not re-settled on upgrade (earlier under-recorded jobs stay as recorded). Compare earlier paid jobs, whatever their status, with the provider statement.
- Docs: removed remaining over-claims in README, SECURITY and the site. "No retry, no fallback" now describes the keyed same-tool retry; "actual cost on success" is the tool's declared `costUsd`, not a provider invoice, and `charged` only means an estimate was written; "checked per call" for jobs means once at queue time against the primary tool's price (no check for fallbacks or manual retries, no reservation; token budgets included); "every call gets a span" excludes `mycel_job` status/wait reads, unknown tools and invalid refs; the secret placeholder claim and "unknown servers are untrusted" now state their scope (HTTP import marks untrusted; hand-configured servers default to trusted); reconciliation applies to paid jobs of any status.

## 0.1.4 — 2026-11-27

From the fourth independent review (free primary tool with a paid fallback; the user saw `succeeded` while the provider billed twice or once more than Mycel recorded):

- Fixed (money): job retry, resume and idempotency decisions now use the contract of the tool actually sent (`idempotent`, `retries`, `idempotencyKeyArg`, price), not the primary tool's. A paid fallback's lost reply is no longer re-sent because the free primary was idempotent with retries.
- Fixed (money): after a restart, a job whose last request went to a paid tool with no recorded outcome is resumed only if that tool is `idempotent` and has `idempotencyKeyArg` (continuing at that tool with the same key). Otherwise it is `interrupted` and the estimate is charged once; the free primary is not re-run. This also applies to a paid tool declared `idempotent: true` without a key.
- Fixed (money): a paid attempt with an unrecorded outcome is never dropped from the ledger when a later attempt (or a recovered primary) succeeds; every dispatch is charged exactly once.
- Added: per-job `dispatches` (tool, `estCostUsd`, `outcome`, `charged`), persisted and shown in the job view. Jobs persisted by 0.1.3 are migrated on load.
- Changed: an unknown outcome is never followed by a fallback, even if a later retry of the same tool is rejected; a keyed retry of the same request is charged once.
- Docs: `errorsAreRejections` needs an end-to-end "not charged" guarantee and does not mean "never retries"; jobs money safety rules rewritten.
- Docs: corrected over-broad claims from the fourth review. "Avoids automatic double submission" and "never re-run automatically" replaced by the precise rule (no automatic re-send of a paid request with an unknown outcome; restart resumes only idempotent keyed paid tools). "Everything is recorded" now means every tool call through Mycel (not client-side actions or provider-side effects). "Secrets never enter the model's context" now describes `{{secret:NAME}}` injection and scrubbing, with the unusual-encoding caveat. Budget caps are documented as per-call, not reserved before dispatch. Added "Known limits for paid jobs" (estimates may exceed charges, no reconcile tool yet, dashboard spend mixes estimates and confirmed charges); the paid-fallback config example is marked illustrative (mock provider). README test count is now 88.

## 0.1.3 — 2026-11-27

From the third independent review (mock paid provider, $0.40 per accepted job; provider receipts now match or are below Mycel's ledger in every scenario):

- Fixed (money): a paid tool (`costUsd > 0`) that returns `isError` is treated as "outcome unknown": charged the estimate once, marked `unknown`, never retried or sent to a fallback. Stdio MCP servers wrapping paid HTTP APIs report a lost provider reply this way. Set `errorsAreRejections: true` only if the provider's error results guarantee nothing was charged. Free tools are unchanged.
- Fixed: the price at dispatch is stored on the job (`estCostUsd`), so jobs interrupted by a restart are charged even when their tool is no longer in the catalog. Cancelling after dispatch charges the estimate once.
- Added: contract key `idempotencyKeyArg` — one stable key per job, sent on every attempt including after a restart, so a deduplicating provider charges once.
- Fixed: `mycel doctor` exits 1 when the config is invalid.
- Added: `mycel_search` with `query: "*"` lists all tools (filter by `server`/`effect`). The full-scale gate is now two-way (fails on missing and on extra tool ids).
- Improved: `mycel_ref` given a path or glob explains what a ref looks like.
- Docs: removed "never pay twice" claims; automatic fallback across paid providers is not yet recommended; persona badges updated from the review (researcher: measured with caveat; others partial); example policies require approval for external effects; headless-client approval note.

## 0.1.2 — 2026-11-27

- `examples/full-scale`: the 15-server figure (420 tools, 203.5k → 1.2k tokens) is now reproducible offline from recorded tool lists; runs in CI.
- Docs: corrected client claims (Claude Code and Cursor load tools on demand), round-trip framing, overhead range, English-only search note, film disclosure; mycel_search asks for English queries.
- Fixed: jobs resumed after a restart no longer run before the tool catalog is built. A resumed job whose server is not connected fails with a message naming the server and tool.
- Fixed: a lost provider reply (timeout, connection closed or reset after sending, abort) is no longer treated as a rejection. Fallback providers are tried only after a definite rejection (could not connect, MCP error response, tool error result); otherwise the job ends as `unknown`.
- Added: job status `unknown`; `costUsd` and `costEstimated` on jobs. The contract cost is charged to the budget as an estimate for `unknown` jobs and for non-idempotent jobs interrupted by a restart after dispatch.
- Changed: `approval_required` says whether an approver is available and shows how to pre-approve via `policy:`; a decline is reported as "Denied by the user".
- Fixed: `mycel init` skipped any server whose path or args contained "mycel"; it now skips only Mycel itself and prints each skipped entry with the reason.
- Fixed: tool contract `cost` was silently ignored. `cost` is now an alias of `costUsd`, and unknown contract keys are an error.
- Changed: `mycel doctor` exits 1 when any upstream fails to start.
- Fixed: the full-scale gate now fails if any server or tool from the recorded dumps is not loaded by the gateway.
- Docs: who-it's-for personas with status badges; real Claude Code session (n=1); single-user trust boundary in SECURITY.md; docs/benchmark-protocol.md (draft 0.1).

## 0.1.1 — 2026-11-26

- Published on npm as `@speakquery/mycel` (the command is still `mycel`): `npm install -g @speakquery/mycel`.

Found by running Mycel in front of 8 real open-source MCP servers ([field test](examples/field-test)).

- **Search ranking across many servers.** Server-damped IDF (a term used by 40 tools of one server counts as a few documents), synonyms keyed by surface word and weighted 0.3, and a bonus when a tool name is fully explained by the query. A 44-tool server no longer drowns git/fetch/duckduckgo.
- **OAuth sign-in for remote MCP servers** (Canva, Higgsfield, Notion, Linear, …). `mycel login <server>` handles discovery, dynamic client registration, PKCE and refresh. Tokens are stored with mode 0600. `doctor` and `serve` tell you when a sign-in is missing.
- **`annotations: balanced | strict`** per server. Playwright marks even `hover` as destructive, which made every browser step ask for approval. In balanced mode (the default), a destructive annotation needs the tool's name to agree.
- Big text results wrapped in JSON (`{content: "…"}`) are stored as text, so a CSV gets a table digest and grep works line by line.
- `mycel_ref` grep shows a window around the match on very long lines instead of the whole line.
- Verified with the real Canva MCP server: `mycel login canva`, 44 tools, read calls through Mycel. With Canva, 126 tools cost 44.5k tokens direct and 1.05k through Mycel.
- Shell and process execution (`start_process`, `run_command`, …) is always classified `destructive`. Fixes a gap where balanced mode demoted it to `external`.
- `mycel_search` with `server` and no hits lists that server's tools. `mycel_describe` accepts `tool: "x"` and gives a clear error otherwise.
- At full scale: 15 servers and 420 tools cost about 204k tokens direct vs 1.2k through Mycel.
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
