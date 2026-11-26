# Mock MCP servers

Four small stdio MCP servers written with `defineAdapter(...).serve()`. Plain `.mjs`, no dependencies beyond
the built package (`../../dist/index.js`), no network. They work with any MCP client, with or without Mycel.

| Server | Tools | What it demonstrates |
|---|---|---|
| `github-mock.mjs` | `list_issues` (40 issues, 20 not updated in 45+ days), `get_issue`, `add_label`, `close_issue`, `delete_branch` (destructive) | code mode, policy deny / approve, capability tokens |
| `studio-mock.mjs` | `generate_image` (real PNG, encoded in pure JS with zlib), `generate_video` (async, $0.40, progress 0→100 over ~6 s, real MP4 via `ffmpeg -f lavfi testsrc2`), `upscale_video` (takes a `ref://`), `estimate_cost` (read) | `file()` binary results, jobs, refs with video digests + keyframes, passing refs between tools |
| `web-mock.mjs` | `fetch_page` (a page with a hidden prompt injection), `send_email` (external) | `trust: untrusted`, provenance, taint → approval |
| `warehouse-mock.mjs` | `query` (5,000-row CSV, ~267 KB) | ref store table digest, `refs.read` slices |

Effects are declared with `effect:` (sent to clients as MCP annotations). Cost and `async` are only advisory in
the tool description: Mycel enforces them through `servers.<name>.tools` overrides in `mycel.yaml`, as the
quickstart does for `studio`.

## Run one directly

They speak MCP over stdin/stdout, so on their own they just wait for a client. The quickest look is through Mycel:

```bash
npm run build                      # repo root, once
cd examples/quickstart
node ../../dist/cli.js doctor -c mycel.yaml
```
```
  ✓ github: 5 tools
  ✓ studio: 4 tools
  ✓ web: 2 tools
  ✓ warehouse: 1 tools
```

Or with the MCP Inspector: `npx @modelcontextprotocol/inspector node examples/servers/studio-mock.mjs`.

`generate_video` / `upscale_video` need `ffmpeg` on `PATH`. Without it they fail with:
`ffmpeg is not installed or not on PATH. Install it (macOS: brew install ffmpeg · Debian/Ubuntu: apt install ffmpeg) to generate videos.`

All data is in memory and resets when the process exits. Timestamps are relative to "now", so 20 issues are
always stale. If you edit a tool's description or schema, Mycel's manifest pinning flags it as changed
(`mycel pin`); accept with `mycel pin --accept`.
