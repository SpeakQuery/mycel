# Field report: a real video pipeline with Higgsfield (real service, n=1)

**Status: PARTIAL (real service, n=1, 2026-11-27).** One Claude Code session used Mycel as the only path to the real Higgsfield MCP server while it monitored, downloaded, checked and published six 30-second Seedance 2.5 shorts (720p, 9:16). The six videos were **submitted by a different agent directly to Higgsfield, not through Mycel**, so this report does not measure generation through Mycel. It measures setup, monitoring and entitlement checks.

**Takeaway:** the big win was not the meta-tools inside the model's context. It was `mycel call` from a shell script: job polling every 5 minutes cost **0 model tokens**, where the same check run by a subagent cost about 85,000 tokens each time.

## At a glance

| | Result | Kind |
|---|---|---|
| 🔌 Remote MCP + OAuth | Higgsfield added as `url: https://mcp.higgsfield.ai/mcp`, `mycel login higgsfield` in the browser, **241 tools** loaded | measured |
| 🧰 Tool definitions, 270 tools (Higgsfield + 4 imported servers) | ~155,172 tokens direct → **~962 tokens** through Mycel (−99.4%) | **estimated** (`mycel doctor`, definition size, chars/4) |
| 🔁 Job polling (`mycel call higgsfield.job_status` in a bash loop, every 5 min) | **0 model tokens** per check, vs ~85,700 tokens for one subagent check | measured (session usage) |
| 🎟️ Entitlement check (`mycel call higgsfield.models_explore`) | 1.7 s, 0 tokens; the free-allowance flag was off, so no new generation was started | measured |
| 💳 Credits spent by this session | 0 | measured (provider transactions) |

## What went wrong (and what we changed or will change)

1. **`mycel setup` did not exist for the user.** The instructions said `npx -y @speakquery/mycel setup`, but 0.1.8 (which adds `setup`) was not yet on npm, so `npx` fetched an older version. The agent fell back to `mycel init`. Lesson: never advertise a command before the package that has it is published.
2. **One wasted call on a parameter name.** The first `job_status` call used `job_id`; the tool wants `jobId`. Search results should make exact parameter names easier to see.
3. **Most tokens went to subagents, not to tool definitions.** Each quality-check or upload subagent used 72k–150k tokens. Mycel does not reduce that; moving repetitive checks into scripts that call `mycel call` did.
4. **Not Mycel:** the Higgsfield CLI needs a workspace selected before it works, and a browser extension could not pass 18 MB and 9.2 MB uploads (a 4.5 MB re-encode, SSIM 0.988, worked).

## Not measured yet

- Generating a video **through** Mycel (`mycel_call` or a `mycel_job` for a slow render) against a direct call.
- Video quality. The six videos came from long, multi-shot prompts written by another agent; their quality says nothing about Mycel.

## Reproduce

```bash
npx -y @speakquery/mycel init
# add to mycel.yaml:  servers: { higgsfield: { url: https://mcp.higgsfield.ai/mcp } }
npx -y @speakquery/mycel login higgsfield
npx -y @speakquery/mycel doctor
npx -y @speakquery/mycel call higgsfield.job_status '{"jobId":"<job id>"}'
```
