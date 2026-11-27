# Full-scale context footprint (15 real servers, 420 tools)

Reproduces the "hundreds of tools cost ~200k tokens of definitions, Mycel costs ~1.2k" figure from this repo, with one command, no network and no logins.

```bash
# repo root, once
npm ci && npm run build
# then
cd examples/full-scale && npm test        # or: node count.mjs
```

Takes about 3 seconds. It exits 1 if the Mycel side is not below 5% of the direct side. The gate fails if any server or tool from the dumps is not loaded by the gateway, as well as when Mycel's share is not under 5%. Results are also written to `results.json`.

## What is measured

The tokens a client spends **before the first message** on tool definitions:

- **Direct**: every tool of all 15 servers, as `{ name, description, inputSchema, annotations }`, serialized as JSON, `chars / 4`. This is what a client that loads all tools up front puts in the model's context. A second column, "full payload", also counts `outputSchema` (everything `tools/list` returned); typical clients do not send that to the model.
- **Mycel**: the built Mycel gateway is started over stdio against `mycel.yaml`; the count is its `tools/list` (6 meta tools) plus the server `instructions`, `chars / 4`.

Each of the 15 servers is a *replay server* (`replay-server.mjs`) that serves a captured `tools/list` byte-for-byte; calling a tool returns the error "replay only". So Mycel does its real work (connect, classify, index, build its tool surface) on the real definitions.

## Result (captured 2026-11-26)

| Server | serverInfo name | version | Tools | Direct tokens |
|---|---|---|---|---|
| arxiv | arxiv-mcp-server | 0.8.2 | 19 | 4,457 |
| canva | Canva MCP Server | 1.0.0 | 44 | 28,518 |
| context7 | Context7 | 4.9.0 | 2 | 1,363 |
| desktop-commander | desktop-commander | 0.3.4 | 25 | 13,124 |
| duckduckgo | ddg-search | (none reported) | 3 | 1,037 |
| everything | mcp-servers/everything | 1.0.0 | 13 | 1,575 |
| fetch | mcp-fetch | 2026.11.18 | 1 | 362 |
| filesystem | secure-filesystem-server | 1.0.0 | 14 | 2,264 |
| git | mcp-git | 2026.11.18 | 14 | 1,929 |
| higgsfield | Higgsfield AI | 1.0.0 | 241 | 140,319 |
| memory | memory-server | 1.0.0 | 9 | 1,341 |
| playwright | Playwright | 1.66.0-alpha-2026-11-18 | 25 | 5,300 |
| sqlite | sqlite | 0.1.0 | 6 | 321 |
| thinking | sequential-thinking-server | 1.0.0 | 1 | 1,036 |
| time | mcp-time | 2026.11.18 | 3 | 607 |
| **Total direct** | | | **420** | **203,547** |
| **Through Mycel** | | | 6 | **1,338** (0.66%) |

The README's earlier "414 tools / ~204k" came from a lab run earlier; this capture has 6 more tools (420), most likely because the remote servers' tool lists changed since then (not verified). The token total matches (203.5k vs ~204k).

## Re-capture with your own servers

`dump.mjs` connects to every server in a `mycel.yaml` the way Mycel does (including OAuth tokens stored under `<home>/oauth`, from `mycel login`), saves exactly what `tools/list` returns (all pages), scrubs personal data and writes one file per server:

```bash
node dump.mjs --config /path/to/your/mycel.yaml --out dumps
```

Then regenerate `mycel.yaml` so it has one replay entry per file in `dumps/` (copy the pattern: `command: node`, `args: ["replay-server.mjs", "dumps/<name>.json"]`) and run `npm test`.

`dump.mjs` redacts emails, personal names, token-shaped strings, bearer credentials, URLs with secret query parameters, `/Users/...` paths and UUIDs (nil/max UUID constants in schema patterns are kept), and replaces the config folder's absolute path with `<lab>`. It writes `REDACTIONS.md` listing where something was removed (never the value). Review the dumps before you share them; pattern matching is not a guarantee. `--raw <dir>` also writes the unredacted dump for your own inspection (keep it out of the repo).

For this capture, the scan found nothing to redact (see `REDACTIONS.md`), and a separate grep over the final dumps for the author's names, `gmail`, `/Users/`, e-mail addresses, UUIDs and secret-looking URL parameters also came back empty.

## Limitations

- `chars / 4` is an estimate, not a tokenizer. Real counts differ by model and by how JSON is escaped. The gap is two orders of magnitude, far larger than the estimation error.
- Only the initial tool definitions are measured. Not measured: the tokens of tool results, a model's tool-choice accuracy, latency, or what Mycel's search and calls cost during a task.
- Clients that already load tool descriptions on demand (Claude Code, recent Cursor) do not pay the "direct" cost; the figure applies to clients that send every definition on every turn.
- Definitions are a snapshot (2026-11-26). Remote servers (Canva, Higgsfield, Context7) change over time; recapture to refresh.
- The replay servers cannot execute tools, so this proves the footprint, not that every real call works through Mycel (see `examples/field-test` for that).
