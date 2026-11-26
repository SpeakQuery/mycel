# Client snippets

Point any MCP client at Mycel instead of at each server. Mycel then fronts every server in your `mycel.yaml`.

| File | Client | Where it goes |
|---|---|---|
| `claude-desktop.json` | Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| `cursor.json` | Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) |
| `vscode.json` | VS Code (Copilot agent mode) | `.vscode/mcp.json` in your workspace |
| `claude-code.md` | Claude Code | one `claude mcp add` command |

Replace `/absolute/path/to/mycel.yaml` with your config (or drop `-c …` and Mycel finds `mycel.yaml`
in the working directory, its parents, or `~/.mycel/mycel.yaml`). `mycel init` writes a config from the
clients you already have and prints the exact snippet to paste.

`MYCEL_TOKEN_SECRET` (Claude Desktop example) is only needed when your config references
`{{secret:MYCEL_TOKEN_SECRET}}`, for example for A2A capability tokens. Generate one with `mycel token secret`.

**From a clone instead of npm:** use `"command": "node", "args": ["/abs/path/to/mycel/dist/cli.js", "serve", "-c", "/abs/path/to/mycel.yaml"]`.
Desktop clients start servers in their own working directory, so use absolute paths (or `cwd:`) for the
servers inside your `mycel.yaml` too.

**Verify** (from a clone, what these snippets run): the client should list six tools,
`mycel_search, mycel_describe, mycel_call, mycel_run, mycel_ref, mycel_job` (plus `mycel_delegate`
when `a2a.peers` is configured and `mycel_ask` when `models:` is).
