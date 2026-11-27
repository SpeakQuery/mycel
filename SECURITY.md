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
- Paid tools: Mycel does not automatically re-send a paid request whose outcome is unknown: it marks the job `unknown`, records the estimated charge once, and sends nothing more (no retry, no fallback), unless you declare that the provider's errors mean nothing was charged (`errorsAreRejections: true`). After a restart, a job whose last request went to a paid tool resumes only if that tool is `idempotent` and has `idempotencyKeyArg`; otherwise it is marked `interrupted` and the estimate is charged once. This is not exactly-once: the provider must deduplicate (Mycel can pass a stable per-job key via `idempotencyKeyArg`). Every paid dispatch is recorded once in the job's `dispatches` (actual cost on success, estimate otherwise). Automatic fallback across paid providers is not yet recommended. Budget caps are checked per call; they are not reserved before dispatch, so concurrent paid jobs can exceed a cap at the provider. Estimated charges count against the cap.
- Changed tool definitions ("rug pulls") are blocked until a human accepts them with `mycel pin --accept`.
- Delegated agents cannot exceed their capability token; tokens can only be narrowed.
- Every tool call that passes through Mycel is recorded in the flight recorder. Not recorded: actions the client takes on its own, and what a provider does on its side (a recorded estimate can differ from what the provider charged).

What Mycel cannot guarantee:

- That a server marked `trusted` is actually trustworthy.
- That a model never misreads data as instructions.
- Code Mode runs in QuickJS/WASM with no ambient capabilities, but it is defence in depth, not a security boundary for hostile code.

Reports in any of the guaranteed areas, and sandbox escapes, are in scope.
