# Field test: Mycel vs 8 real MCP servers

This puts Mycel in front of eight real, open-source MCP servers and measures the same work two ways: direct, and through Mycel. None of the servers needs an account.

| Server | Tools | Runs with |
|---|---:|---|
| `@modelcontextprotocol/server-filesystem` | 14 | Node |
| `@modelcontextprotocol/server-memory` | 9 | Node |
| `@modelcontextprotocol/server-everything` | 13 | Node |
| `@modelcontextprotocol/server-sequential-thinking` | 1 | Node |
| `@playwright/mcp` | 25 | Node (headless browser) |
| `mcp-server-fetch` | 1 | Python via [`uv`](https://docs.astral.sh/uv/) |
| `mcp-server-git` | 14 | Python via `uv` |
| `mcp-server-time` | 3 | Python via `uv` |

## Run it

From the repo root, run `npm install && npm run build` once, then:

```bash
cd examples/field-test
npm install          # the Node servers
npm run setup        # test data: a 20,000-row CSV, 15 notes, a tiny git repo
npm test             # 10 checks, direct vs Mycel  → results.json
npm run scale        # context cost as servers are added 1 → 8  → scale.json
```

Works on macOS, Linux and Windows. S7 and S8 open https://example.com.

## What it checks

| # | Check | Pass when |
|---|---|---|
| S1 | Tool definitions sent to the model | Mycel uses < 1/5 of the direct tokens |
| S2 | Startup until tools are listed | reported |
| S3 | Offline search, 16 natural-language queries | ≥ 85% have the right tool in the top 3 |
| S4 | Per-call overhead, median of 15 | < 25 ms |
| S5 | 20,000-row CSV | result becomes a grep-able ref under 2k tokens |
| S6 | "Find stale notes, save a report" | 17 tool calls in 1 round trip, correct answer (5) |
| S7 | Untrusted web page → `write_file` | blocked, approval required, file not written |
| S8 | Playwright navigate + snapshot | works without needless approval prompts |
| S9 | Image result + progress notifications | image becomes a ref, progress is forwarded |
| S10 | Risk classes | Playwright isn't "all destructive"; `git_reset` is |

## Results (macOS, Node 22, November 2026)

All 10 checks pass. Highlights:
- Context for 80 tools: 17.9k → 1.16k tokens (−93.5%, S1 on the current build).
- 20,000-row CSV: 131k → 187 tokens.
- 17 calls → 1 round trip.
- Per-call overhead: +0.4 ms.

| Servers | Tools | Direct | Mycel | Saved |
|---:|---:|---:|---:|---:|
| 1 | 3 | 1,089 | 1,128 | −4% |
| 2 | 4 | 1,451 | 1,498 | −3% |
| 3 | 18 | 4,729 | 3,832 | 19% |
| 4 | 32 | 6,658 | 919 | 86% |
| 8 | 80 | 17,882 | 1,160 | 93.5% |

_Rows 1–7 are from 0.1.x measurements (`scale.json`); the 8-server row is S1 on the current build._

**Takeaway:** with 1–2 small servers, Mycel adds a few percent and you don't need it for context savings. From about 4 servers, or with one large server, it pays for itself on every turn.

## Remote servers with OAuth

Canva, Higgsfield, Notion, Linear and others sign you in with OAuth. Uncomment them in `mycel.yaml`, then run this once per server:

```bash
mycel login canva
```

Your browser opens and you sign in there. Mycel never sees your password. It stores the tokens in `.mycel/oauth/canva.json` (readable only by you) and refreshes them automatically.
