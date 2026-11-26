# Claude Code

Add Mycel as a single MCP server (user scope, available in every project):

```bash
claude mcp add mycel -- mycel serve
```

With an explicit config file, or project scope (writes `.mcp.json` so your team shares it):

```bash
claude mcp add mycel -- mycel serve -c /absolute/path/to/mycel.yaml
claude mcp add --scope project mycel -- mycel serve -c ./mycel.yaml
```

From a clone (no npm publish needed):

```bash
npm run build
claude mcp add mycel -- node "$PWD/dist/cli.js" serve -c "$PWD/examples/quickstart/mycel.yaml"
```

The quickstart's server paths are relative to `examples/quickstart`, so start Claude Code from that folder
for this last variant (or give the servers absolute paths / a `cwd:` in your own `mycel.yaml`).

Check it: `claude mcp list` should show `mycel` as connected, and `/mcp` inside Claude Code lists
the six meta-tools (`mycel_search`, `mycel_describe`, `mycel_call`, `mycel_run`, `mycel_ref`, `mycel_job`).
