# Changelog

## 0.3.1 — 2026-11-28

**Works for apps started from the Dock, tested end to end on every change, released from GitHub.**
- Apps started from the Dock or Start menu (Claude Desktop, Cursor) get a short PATH without Homebrew, nvm or npm's folders, so `npx` / `mycel` and the `node` they need were not found. Setup now writes the absolute command plus a PATH with node's folder (also through `claude mcp add -e`).
- `npm run e2e`: an end-to-end test of what a user does, in a throwaway home: setup, the app starting Mycel, a real MCP server through it, the savings line, `mycel stats`, undo (byte-for-byte), uninstall, and the Claude Desktop extension's setup from the chat (plan, then apply). `--copy-real` adds copies of your own app configs. CI runs it on macOS, Windows and Linux, and runs both installers (forced Node download, this build) on all three.
- Releases from GitHub: pushing a version tag runs the tests and the end-to-end test, builds the extension, publishes a GitHub Release with `SHA256SUMS`, and publishes to npm with provenance (trusted publishing). Download links point to GitHub Releases.
- Homebrew: `brew tap speakquery/mycel https://github.com/SpeakQuery/mycel && brew install mycel`; the formula follows npm releases by itself.

## 0.3.0 — 2026-11-28

**No terminal needed, keys in the keychain, and Mycel keeps itself up to date.**
- **Claude Desktop extension** (`mycel.mcpb`, download from the site): double-click to install, then ask Claude "Set up Mycel". A new `mycel_setup` tool shows the plan, applies it after the user's yes (Claude Desktop also asks before the tool runs) and can undo it. Claude Desktop's own servers move under the extension; other apps are set up as before. API keys are never asked for in chat.
- **Automatic updates:** once a day Mycel checks npm; a private install (`~/.mycel/app`, used by the installer and the extension) updates itself in the background and runs the new version from the next start. `mycel update` updates now; `mycel doctor` shows when a newer version exists; `update.auto: false` turns it off. Apps set up through `npx` now start `@speakquery/mycel@latest`.
- **API keys in the system keychain:** macOS Keychain or the Linux Secret Service (`secrets.source: keychain`); values never appear on a command line. Windows, and anything the keychain refuses, keep the private file.
- **`mycel uninstall`:** restores every app to its settings from before Mycel, removes the installer's PATH line and Mycel's keychain entries, deletes `~/.mycel`. Asks first.
- **Turkish wizard:** setup, undo and uninstall speak Turkish when the system does (`MYCEL_LANG=tr|en` to choose).
- **"Mycel is active"** once at the start of a conversation, and `mycel stats` adds the last 7 days.
- Docs show only current results (no comparisons between Mycel versions); history stays here.

## 0.2.0 — 2026-11-28

**For people who have never opened a terminal before: one line, yes or no, and you can see what you save.**
- **Installer that brings Node.js:** `curl -fsSL https://mycel.speakquery.ai/install.sh | sh` (macOS, Linux) and `irm https://mycel.speakquery.ai/install.ps1 | iex` (Windows). Uses your Node 20+ if present; otherwise downloads the official Node.js 22 build, verifies its SHA-256 against nodejs.org's SHASUMS256.txt and unpacks it into `~/.mycel/node`. Mycel goes into `~/.mycel/app`; apps start it with an absolute Node path, so a short app PATH (Claude Desktop on macOS) no longer breaks it. Adds a `mycel` command on a yes. No admin rights.
- **Savings you can see:** setup turns on the savings line unless you say no. The line now shows the session's percent and an *estimated* money and time value (`ui.usdPerMTok`, default $3/M input tokens; `ui.tokensPerSecond`, default 3,000), and with `ui.tellUser` (default on) the model ends a finished task with that line for you. `mycel stats` adds the percent and a "worth" line.
- **Missing API keys are asked for** (hidden input) instead of being left as a note.
- **Claude Desktop extensions** (one-click .mcpb/.dxt installs) are imported, run through Mycel and turned off in Claude Desktop; `mycel undo` turns them back on. A Claude Desktop config that is not plain JSON is never overwritten.
- **Claude Code plugin servers** are listed and left alone (plugins manage them).
- **Setup ends with a summary:** servers working, tools, and the tool-definition reduction (estimated).

## 0.1.9 — 2026-11-28

**Setup is now a wizard: you only answer yes or no.**
- API keys found in your app configs are moved into `~/.mycel/secrets.env` (permissions 600) and the config points at it. No environment variables to set.
- Two servers that use the same variable name (for example `API_KEY`) with different values now get separate secrets; before, one could silently use the other's key.
- Project files shared with a team are offered with a yes/no question instead of needing `--projects`.
- After applying, every server is started through Mycel and checked; servers that need OAuth open the browser for a one-time sign-in.
- On macOS, Claude Desktop, Cursor, Windsurf and VS Code are restarted on a yes (never the app setup runs inside). Elsewhere the one remaining step is printed.
- `--no-check` skips testing, sign-ins and restarts. `mycel undo` also restores the secrets file, or keeps one it created and says so.
- `mycel login` now shares the wizard's sign-in code.

## 0.1.8 — 2026-11-27

- Added: `mycel setup` (`npx -y @speakquery/mycel setup`): finds your MCP client configs (Claude Desktop, Claude Code incl. per-project lists, Cursor, VS Code, Windsurf, Gemini CLI), imports their servers into `~/.mycel/mycel.yaml` (merges into an existing file, never overwrites it), shows exactly what will change and asks y/N (`--yes` skips; without a terminal it is a dry run), backs up every file it touches to `~/.mycel/backups/<timestamp>/` with a manifest, then leaves each client with a single `mycel` entry. Files with comments (JSONC) are skipped, not rewritten. Project-level files are left alone unless `--projects`. Claude Code user scope uses the `claude mcp` CLI when it is installed. Secrets stay `{{secret:NAME}}` placeholders.
- Added: `mycel undo [--list] [--id <ts>] [--yes]` restores the files from a setup backup, checks checksums first and asks before overwriting anything you changed since.
- Added: docs/getting-started.md (three steps for non-experts).

## 0.1.7 — 2026-11-27

Fewer model turns (from the Stitch case study: 13 turns direct vs 27 through Mycel; 6 of the 14 extra turns were `mycel_job` waits):

- Changed: `mycel_call` now waits inline for async tools (names like generate/render/export, or `async: true` in the contract) up to `jobs.inlineWaitMs` (default **120000**; it was 20000 as `asyncThresholdMs`, which still works as an alias when `inlineWaitMs` is not set). A job id comes back only if the tool is still running after that. While waiting, Mycel sends an MCP progress notification every `jobs.heartbeatMs` (default 10000) when the client asked for progress, so clients that reset their request timeout on progress keep the call alive. Clients with a fixed ~60 s limit and no reset on progress should set a smaller `inlineWaitMs`. Money handling is unchanged (same job, same ledger; a job that outlives the wait is the same job as before).
- Added: `mycel_call` argument `wait` (seconds, 0-1800; `0` = return the job at once) overrides the inline wait for one call. `mode: "async"` still returns the job immediately. Calls made inside `mycel_run` keep waiting at most 20 s.
- Added: `mycel_search` with `limit` of 3 or less returns each of the top 3 hits' compact input schema (types, enums, required list, short descriptions; capped) instead of the one-line `params`, so the model can call directly without `mycel_describe`. Added `queries: [...]` (up to 6 searches in one call, merged and de-duplicated).
- Changed: the one-line `params` now shows array item types and small nested objects (`screenIds?: string[]`, `options?: { dark?: boolean, size: integer }`) instead of `array` / `any`.
- Added: when a call fails with an argument-looking error (invalid, required, validation, -32602, ...) or required arguments are missing, the error result includes `missingRequired` and the tool's compact `inputSchema`, so the fix takes one turn. Other errors (rate limits, outages) do not carry it.
- Added: `mycel_job` `status` / `wait` accept `ids: [...]` and return one view per job.
- Added: a JSON digest gains `keys` (up to 10 `id` / `name` / `title` / `uri` / `url` / `slug` strings by JSON path, 1,000 chars at most) for values deeper than the depth-limited `sample` shows. The next call usually needs exactly those (e.g. a screen's file name), and without them the model re-read the ref in 3-7 extra turns. Only present when there is something deeper to show; shallow data and big arrays of rows are unchanged.
- Cost, measured: the always-present tool definitions plus instructions grow from 1,253 to 1,338 tokens on the 420-tool full-scale example (+85, chars/4); a `limit: 3` search on that catalog costs about 430 tokens instead of about 220, a default search about 600 instead of 590.
- Unchanged: policy, approvals, taint, budgets and job ledger behaviour; the README/site headline figures (1.2k, 99.4%) are 0.1.6 numbers, the current build counts 1,338 (99.3%) in examples/full-scale.

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
