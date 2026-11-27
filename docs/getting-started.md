# Getting started

You need Node.js 20 or newer. Nothing else.

## 1. Run one command

```bash
npx -y @speakquery/mycel setup
```

Mycel looks for the AI apps you already use (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI) and the MCP servers they have. It then prints a plain summary, for example:

```
Found:
  Claude Desktop            2 servers  ~/Library/Application Support/Claude/claude_desktop_config.json
  Cursor                    1 server   ~/.cursor/mcp.json
What will change:
  create ~/.mycel/mycel.yaml with 3 server(s)
  ~/.cursor/mcp.json: replace 1 server in "mcpServers" with one "mycel" entry
Apply these changes? [y/N]
```

Nothing is touched until you type `y`. Run it with `--yes` to skip the question. If it runs without a terminal (a script, a CI job), it only shows the summary and changes nothing.

## 2. Restart your apps

Close and reopen the apps it listed. They now talk to Mycel, and Mycel talks to your servers. Your servers are not removed: they live in `~/.mycel/mycel.yaml`.

If any of your servers used API keys, Mycel does not copy the keys. It writes a placeholder like `{{secret:API_KEY}}` and tells you which environment variable to set (`export API_KEY=...`). The key stays on your machine.

## 3. Check it works

```bash
mycel stats
```

shows how many tokens Mycel saved you. (`npx -y @speakquery/mycel stats` if you did not install it globally.)

## Changed your mind?

```bash
mycel undo
```

Before changing any file, setup saved a copy in `~/.mycel/backups/<time>/`. `mycel undo` puts the files back exactly as they were. If you edited a file after setup, it tells you and asks before overwriting it. `mycel undo --list` shows all backups.

## Good to know

- Files with comments in them (VS Code's `mcp.json` can have some) are skipped, not rewritten, so your comments are never lost. Setup tells you which, and what to put in by hand.
- Project files shared with your team (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json` in a repo) are left alone. Add `--projects` to include them.
- Running setup again is safe: it will not wrap Mycel inside Mycel.
- Want the config somewhere else? `mycel setup --out ./mycel.yaml`.
