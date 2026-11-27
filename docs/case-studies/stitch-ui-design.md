# Case study: UI design with Google Stitch (real service, n=1)

**Status: MEASURED (n=1, real service).** One run per arm on 2026-11-27, with the real Google Stitch MCP server. This is not a statistical result and not a design-quality comparison.

**Takeaway:** cheaper and safer when tools return big artifacts; slower in turns in this run (0.1.6). Mycel changes after this run (inline waits for async tools, schemas in narrow searches and in argument errors) remove the job-wait and describe turns; see the CHANGELOG and the mock-service re-measurement note below, not re-run on the real service.

## Setup

- Client: Claude Code (print mode), model `claude-haiku-5-5`.
- Servers: Google Stitch MCP (HTTP) and the filesystem MCP server.
- Two arms with identical task prompts and the same operational hints: **direct** (both servers wired straight into the client, 32 tools) and **through Mycel** (6 meta tools).
- n=1 per arm.

`mycel.yaml` used for the Mycel arm (the key is read from `secrets.env`, never written into the config):

```yaml
secrets: { source: file, file: ./secrets.env }

servers:
  stitch:
    url: https://stitch.googleapis.com/mcp
    headers:
      X-Goog-Api-Key: "{{secret:STITCH_API_KEY}}"
  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "./out"]

policy:
  # first match wins: denials first
  - match: { tool: "stitch.delete_project" }
    action: deny
  - match: { tool: "stitch.apply_design_system" }
    action: deny
  - match: { tool: "stitch.update_design_system" }
    action: deny
  - match: { server: "stitch" }
    action: allow
  - match: { server: "filesystem" }
    action: allow
```

`secrets.env` holds one line, `STITCH_API_KEY=<your key>`. Keep it out of version control.

Two setup notes, to be honest about them:

- **Timeouts.** Stitch generation takes 1-3 minutes per screen. Claude Code's default 60 s MCP tool timeout must be raised: `MCP_TOOL_TIMEOUT=1200000`.
- **Approval in print mode.** With Mycel's default policy, `stitch.create_project` needed approval, and Claude Code print mode auto-declined it (it turns an approval request into its own denial). The run therefore used the policy above, which allows the `stitch` and `filesystem` servers and denies `delete_project`, `apply_design_system` and `update_design_system`.

## Task prompt

Both arms received the same task:

> Create a new Stitch project named &lt;name&gt;. Generate 6 mobile screens for a food-delivery app: 1) login, 2) home with restaurant list, 3) restaurant menu, 4) cart, 5) payment/checkout, 6) order tracking. Then save the HTML code of the payment/checkout screen to payment.html in the output directory using the filesystem tool. Reply with the list of the 6 screen titles and the path of the saved file.

Both arms also got the same appended system prompt with operational hints: generate one screen at a time; `list_screens` may return `{}` (use `get_screen`); don't retry calls that succeeded.

## Results

Both arms completed: 6 screens each, and the saved `payment.html` matched Stitch's checkout HTML (byte-identical in the Mycel arm).

| Measure | Direct MCP | Through Mycel |
|---|---:|---:|
| CLI cost estimate | $0.0950 | **$0.0221 (-77%)** |
| Tool results entering the model context | ~140,819 chars (~35.2k tokens) | **~24,632 chars (~6.2k tokens)** |
| The 6 `generate` results | 109,879 chars | **2,028 chars** |
| Saving the file | the model re-typed the 30,509-char HTML into `write_file` | a `ref://` handle (317 chars) was passed: no re-typing, no corruption risk |
| Output tokens | 17,018 | **6,950** |
| Turns | **13** | 27 |
| Wall time | **13.6 min** | 16.1 min |
| Total input incl. cache reads | **869,791** | 1,212,217 |
| Uncached input | 52 | **24** |
| Cache creation | 104,022 | **34,036** |

Mycel was slower and used more turns: search, describe and job-wait turns. Its total input including cache reads was higher, though mostly cached.

### Deterministic check (scripted client, same 6-screen project)

| Measure | Raw | Through Mycel |
|---|---:|---:|
| `list_screens` + 6 `get_screen` + 6 `download_file(html)` | 193,338 chars (~48.3k tokens) | **12,125 chars (~3.0k tokens)** |
| Tool definitions | 32 raw tools (Stitch + filesystem), ~15,118 tokens | **6 meta tools, ~915 tokens** |

## Limitations

- n=1 per arm: no variance estimate.
- The designs differed between arms. This is a cost and context comparison, not a quality comparison.
- Mycel used more turns (27 vs 13) and more wall time (16.1 vs 13.6 min) because of search, describe and job-wait turns. Fewer turns are planned.
- Total input including cache reads was higher with Mycel (1,212,217 vs 869,791); the saving shows up in uncached input, cache creation, output tokens and the CLI cost estimate.
- Cost figures are the Claude Code CLI's estimate; tokens are about chars/4.
- Needs a raised MCP tool timeout and a policy that pre-approves the needed tools in print mode (see Setup).
- One real service and one task type.

## How to reproduce

1. `npm install -g @speakquery/mycel`, then create `mycel.yaml` and `secrets.env` as above (get a Stitch API key from Google; never commit it).
2. `export MCP_TOOL_TIMEOUT=1200000`.
3. Run the same task prompt twice with Claude Code, once with Stitch and filesystem wired directly, once with only Mycel wired in (`mycel serve`, see the [Quickstart](../../README.md#-quickstart)). Use the same model and the same operational hints.
4. Compare the CLI cost estimate, turns and wall time, and the size of the tool results in each transcript. See [See what you save](../../README.md#-see-what-you-save) for the per-call figures Mycel records.
5. Protocol for fair comparisons: [benchmark-protocol.md](../benchmark-protocol.md).

## Re-measurement after the fewer-turns changes (mock service, not the real Stitch)

The real-service run above was not repeated (it spends Stitch quota). To measure turns without it, a mock "slow design" MCP server with Stitch-like tools (`create_project`, `generate_screen_from_text` taking 22-38 s and returning ~16 KB of JSON, `get_screen`, `list_screens` returning `{}`, `download_file` returning ~29 KB of HTML) and the filesystem server ran the same task in Claude Code (`claude-haiku-5-5`, built-in file tools disabled, `MCP_TOOL_TIMEOUT=1200000`, the same operational hints, `router.mode: meta`, a policy that allows the mock and the filesystem server). Three arms, n=2 each, arms run in parallel on one Mac; oracle: `payment.html` written and byte-identical to the checkout screen the mock served (all 8 runs passed).

| | Direct | Mycel 0.1.6 | Mycel (this branch) |
|---|---|---|---|
| Turns (run 1 / run 2) | 15 / 13 | 30 / 31 | **15 / 13** |
| Wall time, min | 4.1 / 4.0 | 4.0 / 3.7 | 3.6 / 3.5 |
| Total input incl. cache reads, k tokens | 1,106 / 892 | 1,353 / 1,126 | **616 / 525** |
| Uncached input tokens | 30 / 26 | 60 / 52 | 30 / 26 |
| Output tokens | 16,135 / 16,137 | 10,456 / 6,505 | 4,493 / 3,599 |
| CLI cost estimate | $0.122 / $0.111 | $0.026 / $0.020 | $0.014 / $0.012 |
| Tool results in context, chars | 127,733 / 126,368 | 24,223 / 20,106 | 16,428 / 12,149 |

Where the 0.1.6 turns went (run 1: 30 turns): 1 ToolSearch for the meta-tools, 1-2 searches, 6 generation calls, 6 `mycel_job wait` calls (plus a ToolSearch to load `mycel_job`), 4-9 `mycel_ref` / `mycel_run` reads to dig the screen ids out of the digested results, plus one failed generation (the model passed `projects/<id>` instead of the id; the direct arm made the same mistake). With the changes: no job waits (generation is waited for inline), one search (`queries`, `limit: 3`), and the ids are in the digest, so the tail is download, write. A first mock version whose HTML was filler text made one direct run refuse to save the file; that run is not included. The mock's delays are fixed (27, 35, 22, 38, 31, 24 s), the real service takes 1-3 minutes per screen and has its own failure modes. n=2, one model, one task: a direction, not a benchmark. The harness is not part of the repository.
