# mycel-client

A Python client for [Mycel](https://github.com/SpeakQuery/mycel), the MCP gateway and A2A agent mesh.

It talks to Mycel over A2A (protocol v0.3, JSON-RPC binding), so any Python program or agent framework can search the catalog, call tools, run code-mode scripts and handle human approvals. Every call goes through the same policy, budget, taint tracking and flight recorder that MCP clients get.

- No runtime dependencies. It uses only `urllib` and `json` from the standard library.
- Python 3.9 or newer, fully typed (`py.typed`).
- Apache-2.0.

## Install

The package lives in the `python/` folder of the Mycel repository. Install it straight from git:

```bash
pip install "git+https://github.com/SpeakQuery/mycel#subdirectory=python"
```

## Start a gateway

```bash
mycel serve --http --port 4747     # serves MCP at /mcp and A2A at /a2a
```

When Mycel binds to a loopback address (`127.0.0.1`, `localhost`, `::1`), local callers get full access without a token. Anywhere else, or when `a2a.requireToken` is set, every request needs a capability token:

```bash
# needs MYCEL_TOKEN_SECRET (or a2a.tokenSecret) on the gateway
mycel token mint --tools "github.*" --max-effect write --ttl 1h   # prints myc1.…
```

## Usage

```python
from mycel_client import Mycel, ApprovalRequired, Denied, MycelError

m = Mycel("http://127.0.0.1:4747")                          # loopback: no token needed
# m = Mycel("https://mycel.internal", token="myc1.…")       # remote: capability token

m.card()                                  # the Agent Card (dict)

for t in m.search("list github issues", limit=5):
    print(t["tool"], t["effect"], t["params"])

issues = m.call("github.list_issues", {"limit": 10})        # returns the result value

video = m.call("media.render", {"script": "..."}, wait=True, timeout=600)   # background jobs

total = m.run("""
  const issues = await tools.call('github.list_issues', {state: 'open'});
  return issues.length;
""")                                       # code mode: many calls, one round trip
```

### Return values

A completed task's artifact becomes a Python value. A `data` part comes back as a dict, list or number. A `text` part comes back as a `str`.

### Background jobs

Slow or async tools run as Mycel jobs, and their A2A task stays in the `working` state.

- `call(..., wait=True, timeout=600)` polls `tasks/get` until the job is done. Set `timeout=None` to wait forever. If the timeout runs out, it raises `MycelTimeout`, and the job keeps running on the server.
- `call(...)` without `wait=True` raises `StillWorking` with `task_id` and `job_id`. Pick the task up later with `m.wait(task_id)`, or poll it yourself with `m.task(task_id)`.
- `m.cancel(task_id)` cancels the task and its job.

`run()` and `resume()` accept the same `wait` and `timeout` arguments.

## Error handling

Every exception subclasses `MycelError`. Task-level errors also carry `.task_id` and the raw `.task`.

| A2A outcome | Exception |
|---|---|
| `completed` | none: the value is returned |
| `input-required` with `metadata.approval` | `ApprovalRequired(approval_id, task_id, message)` |
| `rejected` (policy, capability, budget, pinning) | `Denied` |
| `failed` (tool error, script error, unknown tool) | `TaskFailed` |
| `canceled` | `Canceled` |
| `working` with `wait=False` | `StillWorking` |
| wait timed out | `MycelTimeout` (also a `TimeoutError`) |
| HTTP 401/403, bad or expired token | `AuthError` |
| other JSON-RPC errors (`-32001` task not found, …) | `RpcError` (`.code`) |
| cannot connect, bad JSON | `MycelError` |

```python
try:
    m.call("github.create_issue", {"title": "Bug"})
except Denied as e:
    print("blocked by policy:", e)
except MycelError as e:
    print("failed:", e)
```

## Approvals

Mycel's policy can make a destructive call, or a call that uses tainted data, wait for a human. The client raises `ApprovalRequired` instead of running the call:

```python
from mycel_client import ApprovalRequired

try:
    m.call("db.drop_table", {"name": "users"})
except ApprovalRequired as e:
    print(e.message)          # why it needs approval
    print(e.approval_id)      # e.g. apv_1a2b3c4d
    print(e.task_id)          # the A2A task waiting for it
    # A human approves in the dashboard or with:  mycel approve apv_1a2b3c4d
    input("Press enter once approved… ")
    result = m.resume(e.task_id, approval=e.approval_id)
```

`resume()` re-sends the original call on the same task with the approval attached. Mycel accepts an approval only for the exact tool and arguments it was issued for, and only once. If no human has approved yet, `resume()` raises `ApprovalRequired` again.

## CLI

```bash
python -m mycel_client --url http://127.0.0.1:4747 card
python -m mycel_client --url http://127.0.0.1:4747 search "make a video" --limit 5
python -m mycel_client --url http://127.0.0.1:4747 call github.list_issues '{"limit": 10}'
python -m mycel_client --url http://127.0.0.1:4747 run script.js        # '-' reads stdin
python -m mycel_client task <task_id>
python -m mycel_client cancel <task_id>
python -m mycel_client resume <task_id> <approval_id>
```

- `--url` and `--token` fall back to the `MYCEL_URL` and `MYCEL_TOKEN` environment variables.
- `call`, `run` and `resume` wait for background jobs. Pass `--no-wait` to return right away.
- The package also installs the same CLI as a `mycel-client` command.
- Exit codes: `0` ok, `1` error, `2` approval required (the approval and task ids go to stderr), `3` denied, `4` still working.

## Low-level access

- `m.send(data, text=None, task_id=None, context_id=None)` returns the raw task from `message/send`.
- `m.rpc(method, params)` makes any JSON-RPC call.
- `mycel_client.result_of(task)` applies the state mapping above to a raw task.

## Development

```bash
cd python
python3 -m unittest -v
```

The tests run against a stdlib `http.server` fake of Mycel's A2A server, so they need no network access and no Node.
