# Case study: UI design with Google Stitch (real service, n=1 per arm)

**Status: MEASURED (n=1, real service).** One real-service run per arm on 2026-11-27 with the real Google Stitch MCP server. This is not a statistical result and not a design-quality comparison.

**Takeaway:** on the real service, cost was −85% and tool results in context −88% against direct, with the same number of turns (13 vs 13), and the saved HTML was byte-identical while the direct arm's re-typed copy lost a character.

## At a glance (real Stitch, `claude-haiku-5-5`, n=1 per arm)

| | Direct MCP | Mycel | Change |
|---|---:|---:|:---|
| 💰 CLI cost | $0.0867 | **$0.0132** | −85% ✅ |
| 📦 Tool results in context | 147,455 chars (~36.9k tokens) | **18,289 chars (~4.6k tokens)** | −88% ✅ |
| 🎨 Data returned by the 6 generations | 120,584 chars | **8,863 chars** (ref + digest, inline) | −93% ✅ |
| 💾 Saving the HTML | model re-typed 26,436 chars | **`ref://` handle, 318 chars** | −99% ✅ |
| ✍️ Output tokens | 14,899 | **4,014** | −73% ✅ |
| 📥 Total input incl. cache | 901,571 | **549,084** | −39% ✅ |
| 🔁 Turns | 13 | **13** | equal ✅ |
| ⏱️ Wall time | 17.1 min | **15.6 min** | −9% (within noise) ✅ |
| 🎯 Oracle: `payment.html` identical to Stitch's HTML | ❌ **corrupted**: dropped one character (U+F8FF before "Pay") and added a trailing newline while re-typing | ✅ **byte-identical** | ✅ |

**The corruption is a concrete reason refs matter:** the direct arm's model re-typed ~25 KB of HTML into `write_file` and silently dropped one private-use glyph (U+F8FF, the Apple-logo glyph before "Pay") and appended a trailing newline, so the saved file no longer matched Stitch's. The Mycel arm passed a 318-char `ref://` handle and the file was byte-identical. (n=1, but it happened.)

Scripted check of the same 6-screen project (no model): ~48.3k tokens direct vs ~3.0k through Mycel (−94%); tool definitions: 32 raw tools (~15,118 tokens) vs 6 meta tools (~915).

Honest limits: n=1 per arm on one real service, the designs differed between arms (not a quality comparison), and the numbers come from the Claude Code CLI's estimate and chars/4 token counts.

- **Gained:** cost −85%, tool results in context −88%, output tokens −73%, total input −39%, turns equal (13 vs 13), and the HTML saved by handle, byte-identical, where the direct arm's re-typed copy was corrupted.
- **Lost:** nothing measurable against direct. The remaining avoidable cost is one verification read after the write (the minimum for this task is about 10 calls; the run used 12). Wall time is dominated by Stitch generation latency.

The sections below keep the full detail: setup, prompt, the scripted check, limitations and a mock-service check.

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

The at-a-glance table above holds the measured numbers; both arms completed 6 screens, the Mycel file was byte-identical to Stitch's checkout HTML and the direct arm's was not (one U+F8FF character dropped, trailing newline added).

### Deterministic check (scripted client, same 6-screen project)

| Measure | Raw | Through Mycel |
|---|---:|---:|
| `list_screens` + 6 `get_screen` + 6 `download_file(html)` | 193,338 chars (~48.3k tokens) | **12,125 chars (~3.0k tokens)** |
| Tool definitions | 32 raw tools (Stitch + filesystem), ~15,118 tokens | **6 meta tools, ~915 tokens** |

## Limitations

- n=1 per arm: no variance estimate.
- The designs differed between arms. This is a cost and context comparison, not a quality comparison.
- Turns were equal (13 vs 13); the remaining avoidable cost is one verification read, and results come back as ref + digest (~1.5 KB each) inline, so the gain is in smaller payloads and no re-typing.
- Cost figures are the Claude Code CLI's estimate; tokens are about chars/4.
- Needs a raised MCP tool timeout and a policy that pre-approves the needed tools in print mode (see Setup).
- One real service and one task type.

## How to reproduce

1. `npm install -g @speakquery/mycel`, then create `mycel.yaml` and `secrets.env` as above (get a Stitch API key from Google; never commit it).
2. `export MCP_TOOL_TIMEOUT=1200000`.
3. Run the same task prompt twice with Claude Code, once with Stitch and filesystem wired directly, once with only Mycel wired in (`mycel serve`, see the [Quickstart](../../README.md#-quickstart)). Use the same model and the same operational hints.
4. Compare the CLI cost estimate, turns and wall time, and the size of the tool results in each transcript. See [See what you save](../../README.md#-see-what-you-save) for the per-call figures Mycel records.
5. Protocol for fair comparisons: [benchmark-protocol.md](../benchmark-protocol.md).

## Mock-service check (not the real Stitch)

To check the turn count without spending Stitch quota, a mock "slow design" MCP server with Stitch-like tools (`create_project`, `generate_screen_from_text` taking 22-38 s and returning ~16 KB of JSON, `get_screen`, `list_screens` returning `{}`, `download_file` returning ~29 KB of HTML) and the filesystem server ran the same task in Claude Code (`claude-haiku-5-5`, built-in file tools disabled, `MCP_TOOL_TIMEOUT=1200000`, the same operational hints, `router.mode: meta`, a policy that allows the mock and the filesystem server). Two arms, n=2 each, run in parallel on one Mac; oracle: `payment.html` written and byte-identical to the checkout screen the mock served (all runs passed).

| Run 1 · run 2 | Direct | Mycel |
|---|---:|---:|
| 🔁 Turns | 15 · 13 | **15 · 13** |
| 💰 CLI cost | $0.122 · $0.111 | **$0.014 · $0.012** |
| ✍️ Output tokens | 16.1k · 16.1k | **4.5k · 3.6k** |
| 📦 Tool-result chars | 127.7k · 126.4k | **16.4k · 12.1k** |
| 📥 Total input incl. cache | 1,106k · 892k | **616k · 525k** |
| ✔️ Oracle (file saved, byte-identical) | 2/2 | 2/2 |

Mycel waits inline for slow tools, so there are no job-wait turns; it returns the screen ids in the digest, so the tail of the task is just download, write. A first mock version whose HTML was filler text made one direct run refuse to save the file; that run is not included. The mock's delays are fixed (27, 35, 22, 38, 31, 24 s), the real service takes 1-3 minutes per screen and has its own failure modes. Wall time is not meaningful on a mock. n=2, one model, one task: a direction, not a benchmark. The harness is not part of the repository.
