# Use cases by sector

> **Statuses:** MEASURED = run end-to-end with recorded results; PARTIAL = parts tested with mocks/scripts; DESIGNED FOR = not yet tested. Want your sector tested? [Open an issue](https://github.com/SpeakQuery/mycel/issues/new) — pilot plan in [docs/benchmark-protocol.md](benchmark-protocol.md).

Mycel is a local, single-user MCP gateway. Everything below uses real features only: refs and digests, Code Mode, the job queue, budgets, policy approvals, taint, capability tokens, search and the flight recorder. "Typical servers" are generic categories of MCP servers, not a list of integrations Mycel ships. Sectors 1–4 are summarised from the README; their evidence and caveats are unchanged. Local, single-user, read-heavy use is the recommended pilot; paid jobs with automatic fallback are not.

| # | Sector | Status |
|---:|---|---|
| 1 | [Researchers and data analysts](#1-researchers-and-data-analysts) | MEASURED (with caveat) |
| 2 | [Developers with many MCP servers](#2-developers-with-many-mcp-servers) | PARTIAL |
| 3 | [AI editors and content/marketing teams](#3-ai-editors-and-contentmarketing-teams) | PARTIAL |
| 4 | [Video / voice producers](#4-video-voice-producers) | PARTIAL (pilot) |
| 5 | [Customer-support agents](#5-customersupport-agents) | PARTIAL |
| 6 | [E-commerce operations](#6-ecommerce-operations) | DESIGNED FOR — not yet tested |
| 7 | [Legal / document review](#7-legal-document-review) | PARTIAL |
| 8 | [Finance & accounting reporting](#8-finance-accounting-reporting) | DESIGNED FOR — not yet tested |
| 9 | [Data engineering / ETL quality](#9-data-engineering-etl-quality) | PARTIAL |
| 10 | [Agencies & social-media teams](#10-agencies-socialmedia-teams) | DESIGNED FOR — not yet tested |

## 1–4. The four tested personas

Full evidence, numbers and caveats for these four are in the README section [Who is it for?](../README.md#-who-is-it-for). In short:

- **1. 🔬 Researchers and data analysts** — **MEASURED (with caveat).** A 20,000-row CSV becomes a ref plus a digest; a Code Mode scan finds what a text search missed.
- **2. 🧑‍💻 Developers with many MCP servers** — **PARTIAL.** 8 servers, 80 tools: 17.8k → 1.0k definition tokens where the client sends them all.
- **3. 📣 AI editors and content/marketing teams** — **PARTIAL.** Find designs, read assets by ref; publish or send needs approval under the example policy.
- **4. 🎬 Video / voice producers** — **PARTIAL (pilot).** Refs between agents, budget caps and jobs for slow renders; automatic paid fallback not yet recommended.

## 5. 🎧 Customer-support agents

**Status: PARTIAL.**

**Evidence (independent review, mock services, 3 runs each):** scripted runs 3/3 produced the right draft; a 1,800-line ticket history stayed as a ref; all 6 injected refund/email attempts stopped for approval (0 unapproved side effects, 0 unnecessary approvals). With a small local model (Qwen3-4B) 0/3 reached the right end state (wrong order id, no draft): a model limit, no Mycel-specific failure. Note: approval for trusted external actions (email, share, upload) requires an explicit `{ match: { effect: external }, action: approve }` rule; the default policy allows them.

- **Who:** Support teams running an agent over tickets, orders and a knowledge base.
- **Typical MCP servers:** ticketing/helpdesk, CRM, knowledge base, email, payments/refunds.
- **Pain:** Ticket histories are long, and the customer’s text is untrusted input sitting next to tools that can refund or send mail.

**Scenario**

1. Mark the ticketing and email servers `trust: untrusted`; the long ticket history comes back as a ref plus a digest instead of thousands of lines in the prompt.
2. The agent searches the knowledge base with `mycel_search` and greps the ref for the order id and earlier promises.
3. Its draft reply and refund call carry taint from the customer text, so the default policy (tainted + side-effect → approve) stops them until an agent supervisor approves inline or with `mycel approve`.
4. Refund and send calls are `external`/`destructive` contracts; add a per-day budget if the payments tool declares `costUsd`.
5. Every search, call and approval decision appears as a span in the flight recorder for later review.

- **What to measure in a pilot:** Share of tickets where the model needed the full history in the prompt, approvals raised vs. approvals that were correct, and any tainted write that got through (target: zero).
- **Not a fit:** A hosted, multi-tenant support desk serving many customers from one gateway: Mycel is local and single-user today.

## 6. 🛒 E-commerce operations

**Status: DESIGNED FOR — not yet tested.**

- **Who:** Shop operators and catalog/merchandising teams.
- **Typical MCP servers:** product catalog (CSV or database), storefront/admin API, image generation or editing, file storage.
- **Pain:** Catalogs run to thousands of rows, price updates are repetitive, and a wrong publish is visible to customers.

**Scenario**

1. Export the catalog; it becomes a ref with a table digest (columns, row count, sample) rather than rows in the prompt.
2. The model writes one Code Mode script that loops over the ref, computes new prices and prepares the update payloads in a single round trip.
3. Image generation or editing calls run as jobs with progress, cancel and retry; results are refs passed on to the storefront tool.
4. The publish/price-update tool is an `external` effect: the policy requires approval, bound to the exact arguments.
5. Declare `costUsd` on image tools and set a per-day cap so a loop can’t quietly spend.

- **What to measure in a pilot:** Rows changed per approval, wrong prices caught at the approval step, turns and time for a 1,000-row price change vs. direct tools.
- **Not a fit:** A handful of products or one-off edits: direct tools are simpler. Paid image jobs with automatic fallback are not yet recommended (see the paid-jobs note in the README).

## 7. ⚖️ Legal / document review

**Status: PARTIAL.**

**Evidence (independent review, mock services, 3 runs each):** scripted runs 3/3 found all 3 changed clauses across two 36-page versions, 0 missed, 0 invented; with the explicit approval rule all 9 send attempts stopped. Small local model 0/3 (answered without opening the documents). Note: approval for trusted external actions (email, share, upload) requires an explicit `{ match: { effect: external }, action: approve }` rule; the default policy allows them.

- **Who:** Lawyers, paralegals and in-house teams reviewing documents on their own machine.
- **Typical MCP servers:** filesystem or document store, PDF/text extraction, email or sharing tools.
- **Pain:** Contracts and PDFs are long, versions differ in small ways, and confidential text must not be sent anywhere by accident.

**Scenario**

1. Contracts and exhibits are read as refs; the model sees an outline digest instead of hundreds of pages.
2. It greps the refs for clauses (indemnity, termination, governing law) and reads only the matching lines.
3. To compare two versions it runs a Code Mode script over both refs and returns only the differing clauses.
4. Any email, share or upload tool is an `external` effect and needs approval before anything leaves the machine.
5. The flight recorder keeps a local record of which documents were read and what was sent.

- **What to measure in a pilot:** Clauses found by grep vs. a manual read of the same documents, missed differences in version comparison, and tokens used per document.
- **Not a fit:** Shared or multi-user matter workspaces, or anything that needs client-level access control: Mycel is single-user and local. It is a reading aid, not legal advice, and it does not guarantee that a search sees every clause: verify against the full text.

## 8. 📊 Finance & accounting reporting

**Status: DESIGNED FOR — not yet tested.**

- **Who:** Finance analysts and accountants preparing reports and reconciliations.
- **Typical MCP servers:** ledger/ERP export, spreadsheet or database, paid market or reference-data APIs, file storage.
- **Pain:** Ledger exports and spreadsheets are huge, reconciliation is many small steps, and paid data APIs can be called in a loop.

**Scenario**

1. The ledger export and the bank statement become refs with table digests.
2. A Code Mode script matches the two over the refs and returns only unmatched lines, one round trip instead of many.
3. Paid data APIs get `costUsd` in their contracts and a per-task or per-day budget cap checked on each call.
4. Writes to the accounting system are `write`/`external` and go through approval.
5. The flight recorder gives a timed audit trail of what ran; money is read from the budget ledger, which holds estimates and declared costs, not provider invoices.

- **What to measure in a pilot:** Reconciliation turns and time vs. direct tools, unmatched items missed vs. a manual check, and budget-ledger spend vs. the provider statement.
- **Not a fit:** Anything needing a regulated, tamper-proof audit log: the flight recorder is local JSONL, not a certified control. Not for multi-user ledgers.

## 9. 🛠️ Data engineering / ETL quality

**Status: PARTIAL.**

**Evidence (independent review, mock services, 3 runs each):** scripted runs 3/3 found all 3 issues in 50,001 rows, 0 false positives, both direct and through Mycel. Context size for the same 2-turn task: 583,980 tokens direct vs 602 through Mycel (requests + responses, chars/4). Local median latency 37.7 ms direct vs 319.3 ms Mycel. Small local model 0/3 in both arms.

- **Who:** Data engineers and data-quality owners checking pipeline outputs.
- **Typical MCP servers:** SQL/warehouse query tool, filesystem, object storage, ticketing for reporting issues.
- **Pain:** Result sets have thousands of rows and the bad ones are rare; a sample can miss them.
- **Closest evidence:** The closest evidence is the measured CSV case: in a 20,000-row dataset with two planted exceptions, a text search on the ref found one and a Code Mode numeric scan found both; the first report omitted both until asked to verify. This sector's own scripted runs are listed in the evidence line above.

**Scenario**

1. A SQL result comes back as a ref plus a digest (columns, row count, sample).
2. A text search on the ref is a quick first pass, but it can miss rows.
3. A Code Mode script scans every row of the ref against the rule (for example label vs. value, missing flag) and returns only violations.
4. The model reports counts and ids, and is asked to verify against the full file before concluding.
5. Writing fixes back or opening tickets goes through policy and approval.

- **What to measure in a pilot:** Planted exceptions found by the text search vs. the Code Mode scan, and the model’s first report vs. its verified report.
- **Not a fit:** Streaming or very large tables that don’t fit as a single ref; 1–2 small servers where Mycel only adds context.

## 10. 📱 Agencies & social-media teams

**Status: DESIGNED FOR — not yet tested.**

- **Who:** Agencies and in-house social teams running several agents over many client accounts.
- **Typical MCP servers:** Canva or other design tools, scheduling/publishing, analytics, ad or billing tools, storage.
- **Pain:** Many client tools, many agents, and one over-privileged key means a posting agent could reach billing.

**Scenario**

1. A human mints a capability token per role with `mycel token mint` (and agents can narrow it with `mycel token attenuate`): the design agent gets design tools, the posting agent gets scheduling only, each with a lower effect ceiling and a small budget.
2. Designs are found with `mycel_search` and passed between agents as refs.
3. Posting and scheduling are `external` effects; the policy requires approval before anything is published.
4. Tokens expire and can only be narrowed further, never widened.
5. The flight recorder shows which agent called which tool, and the budget shows spend per task.

- **What to measure in a pilot:** Calls a token correctly refused (billing from the posting agent), approvals needed per campaign, and spend per client.
- **Not a fit:** Hosting many clients’ credentials for many users on one shared gateway: Mycel is single-user and local today. One or two tools: no need.

## Also

- **Education content** (lesson and quiz material built from documents and media): same refs and approval pattern; DESIGNED FOR, not yet tested.
- **Health / biomedical literature review** (arXiv/PubMed-style search, reading papers by ref): a reading and summarising aid only. Mycel makes no medical-advice claims. DESIGNED FOR, not yet tested.

## Run it and tell us

[Open an issue](https://github.com/SpeakQuery/mycel/issues/new) with your sector and numbers. Method: [benchmark-protocol.md](benchmark-protocol.md).
