# Contributing to Mycel

Thanks for helping. Mycel is a TypeScript MCP gateway and A2A mesh; small, focused PRs are easiest to review.

## Dev setup

Requires Node 20 or newer. `ffmpeg` is needed for the video keyframe tests.

```bash
npm install
npm run build      # compile to dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run bench      # reproducible benchmark (needs a build first)
```

The Python client lives in `python/` and is tested with `python -m unittest discover -s python/tests`.

## Project layout

| File | Purpose |
|---|---|
| `src/a2a-client.ts` | A2A (Agent2Agent) types and the client used to delegate to peers. |
| `src/a2a-server.ts` | A2A server: exposes Mycel's tools to other agents under the same policy. |
| `src/adapter.ts` | `defineAdapter` SDK for writing providers that run in-process or as MCP servers. |
| `src/bench.ts` | Reproducible benchmark comparing direct MCP with Mycel. |
| `src/catalog.ts` | Tool catalog, token estimation and the BM25 search index. |
| `src/cli.ts` | The `mycel` command-line interface. |
| `src/config.ts` | The zod config schema and config/state discovery. |
| `src/contracts.ts` | Tool contracts: effect classes inferred from annotations and names. |
| `src/core.ts` | Core object that owns upstreams and every subsystem. |
| `src/http.ts` | HTTP server for the dashboard, its API, `/mcp` and A2A. |
| `src/importer.ts` | Imports MCP servers from Claude, Cursor, VS Code, Windsurf and Gemini configs. |
| `src/index.ts` | Public API for embedding Mycel. |
| `src/jobs.ts` | Job queue for long-running work, plus cost and budget enforcement. |
| `src/meta.ts` | The small meta-tool surface the model sees. |
| `src/models.ts` | Model router for `mycel_ask` tiers. |
| `src/policy.ts` | Policy firewall, approval queue and manifest pinning. |
| `src/recorder.ts` | Flight recorder: JSONL traces and OTLP export. |
| `src/refs.ts` | Content-addressed ref store with digests. |
| `src/sandbox.ts` | QuickJS/WASM sandbox for Code Mode. |
| `src/secrets.ts` | Secret vault: `{{secret:NAME}}` injection and scrubbing. |
| `src/server.ts` | The MCP server that clients connect to. |
| `src/tokens.ts` | Attenuable capability tokens for delegation. |
| `src/upstream.ts` | Connections to upstream MCP servers (stdio and HTTP). |

Tests are in `tests/`, examples in `examples/`, docs in `docs/`.

## Adding an adapter

Adapters are defined in [`src/adapter.ts`](src/adapter.ts) with `defineAdapter`. An adapter declares tools (name, description, JSON-schema `input`, `effect`, optional `async` and `costUsd`) and a `run` function. Return `file(buffer, mimeType, name)` for binary output. The same definition works in-process (`.provider`) and as a standalone stdio MCP server (`.serve()`). See the README section "Write an adapter" and `examples/adapters` for working code, and add a test for new built-in adapters.

## Pull request checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, with new tests for new behavior.
- [ ] `npm run build` succeeds.
- [ ] `node dist/cli.js bench` still runs if you touched the router, refs or catalog.
- [ ] Docs updated (`docs/configuration.md` for config changes, README for user-facing features).
- [ ] `CHANGELOG.md` updated.
- [ ] No secrets, tokens or personal data in code, tests or fixtures.
- [ ] Security-relevant changes (policy, secrets, tokens, sandbox) are called out in the PR description.

## Code style

- TypeScript in `strict` mode.
- ESM only; relative imports use the `.js` extension.
- Do not add new runtime dependencies without opening an issue to discuss first.
- Keep the config schema in `src/config.ts` the single source of truth.
- Prefer small functions and comments that explain why, not what.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
