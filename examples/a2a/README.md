# A2A: two Mycel instances talking

- **Agent B, `builder`** ([`agent-b.yaml`](agent-b.yaml)) owns the GitHub tools (the mock from `../servers`) and
  serves them over HTTP: A2A at `/a2a`, the Agent Card at `/.well-known/agent-card.json`, MCP at `/mcp`. A2A
  callers must present a capability token signed with B's `tokenSecret`.
- **Agent A, `planner`** ([`agent-a.yaml`](agent-a.yaml)) has no tools of its own. It lists `builder` under
  `a2a.peers`, so its model gets a `mycel_delegate` meta-tool. [`delegate.mjs`](delegate.mjs) does what that tool does:
  `m.delegate("builder", { data: { tool: "github.list_issues", args: {} } })`.

## Run it (two terminals, both in `examples/a2a`)

```bash
npm run build                                   # repo root, once
cd examples/a2a
```

**Terminal 1: agent B**
```bash
export MYCEL_TOKEN_SECRET=$(node ../../dist/cli.js token secret)
echo $MYCEL_TOKEN_SECRET                         # copy it for terminal 2
node ../../dist/cli.js serve --http --port 4801 -c agent-b.yaml
```
```
✓ github: 5 tools
Mycel HTTP on http://127.0.0.1:4801  (MCP: /mcp · A2A: /a2a)
Dashboard: http://127.0.0.1:4801/  (local only)
```

**Terminal 2: mint a token for A with B's secret, then delegate**
```bash
export MYCEL_TOKEN_SECRET=<value from terminal 1>
export BUILDER_TOKEN=$(node ../../dist/cli.js token mint --tools 'github.list_*,github.get_*' --max-effect read --ttl 1h --sub planner)
node ../../dist/cli.js token inspect "$BUILDER_TOKEN"     # shows the caveats and effective rights
node delegate.mjs
```
```
planner meta-tools: mycel_search, mycel_describe, mycel_call, mycel_run, mycel_ref, mycel_job, mycel_delegate
delegating with token rights: {"id":"…","chain":["planner"],"tools":["github.list_*","github.get_*"],"maxEffect":"read","exp":…}

builder card: builder — Owns the acme/app GitHub repository. Lists, labels and closes issues.
  skill search     Search 5 tools. Send {"search":"query"}.
  skill code-mode  Chain many tool calls in one sandboxed script. Send {"code":"return await tools.call(...)"}.
  skill github     5 tools, e.g. list_issues, get_issue, add_label, close_issue. Send {"tool":"github.<name>","args":{...}}.

list_issues → task completed · provenance untrusted
  artifact: ref://7ba2db3655a287bffd88ef4a (application/json, 13.9 KB, 40 issues)
code-mode → task completed: {"open":40,"stale":20,"oldest":"Clipboard copy fails in Firefox"}
close_issue → task rejected: capability token does not grant github.close_issue

✓ delegation works and the token's limits hold
```

What to notice:
- B decides with **its own** policy, budget and recorder, narrowed by the token A presents. A token can only narrow
  rights (`mycel token attenuate`), never widen them.
- Results from a peer come back as `provenance: untrusted` on A's side (`trust: untrusted` on the peer).
- The 40-issue list is bigger than B's inline limit, so the artifact is a `ref://` that lives in **B's** ref store.
  A cannot read it. Ask B to do the work where the data is instead (step 3, a `{code}` message), and only the small answer travels.
- Without a token B refuses: `curl -s -X POST localhost:4801/a2a -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1","parts":[{"kind":"text","text":"label"}]}}}'`
  → `{"error":{"code":-32000,"message":"A capability token is required (Authorization: Bearer myc1.…). …"}}`

## Human approval across agents

`agent-b.yaml` requires approval for `github.close_issue`. With a token that allows writes, the task stops at
`input-required`, a human on **B's** side approves, and A resumes the same task:

```bash
# terminal 2 (MYCEL_TOKEN_SECRET = B's secret)
export WRITER=$(node ../../dist/cli.js token mint --tools 'github.*' --max-effect write --ttl 1h --sub planner)
curl -s -X POST localhost:4801/a2a -H "authorization: Bearer $WRITER" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1",
       "parts":[{"kind":"data","data":{"tool":"github.close_issue","args":{"number":101}}}]}}}'
#  → "state": "input-required", metadata.approval "apv_…", text "Human approval required: … send {"approval":"apv_…"} with this taskId."

node ../../dist/cli.js approvals -c agent-b.yaml        # apv_0bce346b  github.close_issue  Closing an issue notifies …
node ../../dist/cli.js approve apv_0bce346b -c agent-b.yaml

curl -s -X POST localhost:4801/a2a -H "authorization: Bearer $WRITER" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m2",
       "taskId":"<task id from the first reply>","parts":[{"kind":"data","data":{"approval":"apv_0bce346b"}}]}}}'
#  → "state": "completed", artifact { "number": 101, "state": "closed", … }
```
The approval is stored in `examples/a2a/.mycel/approvals.json`, so the CLI and the running server share it.

## Any A2A client works

```bash
curl -s localhost:4801/.well-known/agent-card.json
curl -s -X POST localhost:4801/a2a -H "authorization: Bearer $BUILDER_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1",
       "parts":[{"kind":"data","data":{"tool":"github.get_issue","args":{"number":101}}}]}}}'
```
Message parts B understands: `{tool, args}`, `{code}`, `{search}`, plain text (treated as a search), and
`{approval}` together with a `taskId` to resume a task that stopped at `input-required`.
