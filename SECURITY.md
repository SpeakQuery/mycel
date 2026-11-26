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

- Secrets never enter the model's context (`{{secret:NAME}}` placeholders, scrubbed from outputs, errors and traces).
- Destructive actions, and side-effects driven by tainted input, need a human approval by default.
- Changed tool definitions ("rug pulls") are blocked until a human accepts them with `mycel pin --accept`.
- Delegated agents cannot exceed their capability token; tokens can only be narrowed.
- Everything is recorded in the flight recorder.

What Mycel cannot guarantee:

- That a server marked `trusted` is actually trustworthy.
- That a model never misreads data as instructions.
- Code Mode runs in QuickJS/WASM with no ambient capabilities, but it is defence in depth, not a security boundary for hostile code.

Reports in any of the guaranteed areas, and sandbox escapes, are in scope.
