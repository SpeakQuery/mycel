# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| older | No |

## Reporting a vulnerability

Please report privately. Do not open a public issue.

1. Go to <https://github.com/SpeakQuery/mycel/security/advisories>.
2. Click **Report a vulnerability** and describe the issue, affected version and reproduction steps.

We aim to acknowledge reports within a few days and will coordinate a fix and disclosure with you.

## Supported deployment

Mycel is supported as a **single-user, local** gateway.

- The HTTP (`/mcp`) and A2A endpoints are **not** a multi-user isolation boundary. There is no isolation between users who share one gateway: they share policy, refs, secrets, jobs and the recorder.
- Policy parity across all execution paths (direct call, Code Mode, jobs, A2A) and secret/taint leak rates are **not independently tested**.
- There has been **no third-party penetration test** yet.

Do not expose a shared gateway to mutually untrusting users.

## Threat model summary

Mycel **reduces and exposes** risk; it does not "solve" prompt injection.

What Mycel aims to guarantee:

- Secrets referenced as `{{secret:NAME}}` are injected by Mycel and scrubbed from outputs, errors and traces; a server that echoes a secret in an unusual encoding could still leak it.
- Destructive actions, and side-effects driven by tainted input, need a human approval by default. A clean (untainted) `external` call such as publish or send is allowed by default; add a rule like `{ match: { effect: external }, action: approve }` if you want approval for those.
- Paid tools: After a paid request with an unknown outcome Mycel never falls back to another provider. It re-sends to the same tool only if that tool is `idempotent`, has `idempotencyKeyArg` (the same key is re-sent) and has retries left; otherwise it marks the job `unknown` and sends nothing more. The estimated charge is recorded once per (tool, key). A request is treated as rejected, and so may fall back, only when it is known not to have been accepted (connection refused before dispatch, or an error from a tool whose contract sets `errorsAreRejections: true`). After a restart, a job whose last request went to a paid tool resumes only if that tool is `idempotent` and has `idempotencyKeyArg`; otherwise it is marked `interrupted` and the estimate is charged once. This is not exactly-once: the provider must deduplicate (Mycel can pass a stable per-job key via `idempotencyKeyArg`). Attempts that the job queue sends are recorded in the job's `dispatches`; retries inside a single call's transport loop are not. On success the budget records the tool's declared `costUsd` for the call (the contract amount, not a provider invoice); otherwise it records the estimate, and `charged` in `dispatches` only means an estimate was written (a definite rejection writes none). A manual `mycel_job retry` of a job whose last paid dispatch is unresolved deliberately reuses the same idempotency key, so a deduplicating provider can collapse it into one receipt; per (tool, key) only one estimate is kept, and a later success replaces it with the actual charge (never both). Dispatches without a key are each charged. Automatic fallback across paid providers is not yet recommended. Budget caps are checked per call; for a job the check runs once, when it is queued, against the primary tool's price, so fallbacks and manual retries get no separate pre-dispatch check and nothing is reserved: concurrent paid jobs can exceed a cap at the provider. Estimated charges count against the cap. Jobs recorded by 0.1.3 or earlier are not re-settled on upgrade; compare earlier paid jobs with the provider statement whatever their status.
- Changed tool definitions ("rug pulls") are blocked until a human accepts them with `mycel pin --accept`.
- Delegated agents cannot exceed their capability token's scope; tokens can only be narrowed. A token's budget is a per-call cap with the same limits as the budget above (no reservation, so concurrent paid jobs can exceed it).
- Every tool request that reaches Mycel's MCP server is recorded in the flight recorder, including failures, unknown tools, invalid refs and dry runs (`describe`, `ref` and `job` spans hold ids and sizes only). Not recorded: requests rejected before they reach Mycel, actions the client takes on its own, and what a provider does on its side (a recorded estimate can differ from what the provider charged).

What Mycel cannot guarantee:

- That a server marked `trusted` is actually trustworthy.
- That a model never misreads data as instructions.
- Code Mode runs in QuickJS/WASM with no ambient capabilities, but it is defence in depth, not a security boundary for hostile code.

Reports in any of the guaranteed areas, and sandbox escapes, are in scope.
