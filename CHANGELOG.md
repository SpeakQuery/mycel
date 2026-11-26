# Changelog

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
