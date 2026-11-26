# Benchmark protocol (draft 0.1)

Drafted from an independent review. It describes how to compare an agent that calls MCP servers directly with the same agent going through Mycel, so that the numbers mean something. The single-run CSV result in the README follows only part of this protocol (it is a pilot, n=1).

## 1. Pre-register before running

Write these down before the first run and publish them with the results:

- Mycel commit and npm package version
- OS and Node version
- Client name and version (for example Claude Code 2.1.316)
- Model id
- Tool catalog hash (the exact list of servers and tools exposed in each arm)
- Fixture hash (input files, CSVs, repositories)
- Permissions: which built-in tools are on or off, which writes are pre-approved
- Cache condition (see section 3)

## 2. Design

- **Paired arms:** every task runs in both arms (direct and Mycel) on the same fixture.
- **Alternate the order** between repeats so drift (provider load, rate limits) does not favour one arm.
- **Ground truth is the final state** (the answer found, the file written), checked by a script, not by the model's own claim.

## 3. Cache conditions

Report these separately; never average them:

- **Cache off**
- **Cache cold** (first run after a change)
- **Cache warm** (repeat run)

## 4. Sample size

- A pilot with n=1 is allowed, and must be labelled as a single run.
- A published comparison needs **at least 20 repeats per task x condition**.
- Report **p95 only with at least 100 observations**; otherwise report median and range.

## 5. Measurements

- Turns, wall-clock time, input and output tokens, and cost per run.
- Reconcile the Mycel ledger (flight recorder) with the provider's own ledger; report any gap.
- Separate **approval time** (a human or a pre-approval step waiting) from **error time** (retries, failures).
- Keep failed and expensive runs in the data. Do not drop outliers without saying so.
- Report token counts under separate names: **tiktoken** (state the encoding, for example cl100k or o200k), **chars/4**, and **provider telemetry**. Do not mix them in one column.

## 6. Output format

JSONL, one row per run, for example:

```json
{"task":"csv-rare-row","arm":"mycel","order":2,"cache":"off","turns":4,"seconds":6.6,"input_tokens":25915,"output_tokens":574,"cost_usd_est":0.0029,"correct":true,"approval_seconds":0,"error_seconds":0}
```

## Reporting your result

Open an issue with your JSONL and the pre-registered fields from section 1.
