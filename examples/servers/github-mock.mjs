#!/usr/bin/env node
// A mock GitHub MCP server (stdio). In-memory, deterministic, no network.
// 40 issues; exactly half of them have not been updated in more than 45 days.
import { defineAdapter } from "../../dist/index.js";

const DAY = 86_400_000;
const TITLES = [
  "Login page flickers on Safari 18", "Rate limiter returns 500 instead of 429", "Docs: typo in quickstart",
  "Webhook retries ignore Retry-After", "Dark mode: chart legend unreadable", "CSV export drops unicode",
  "Search ignores diacritics", "Upgrade to Node 22 LTS", "Flaky test: jobs.resume", "Memory leak in SSE handler",
  "Add OpenTelemetry exporter", "Settings page 404 for org admins", "Crash when config has BOM",
  "Slow cold start on Lambda", "Pagination cursor off by one", "Avatar upload rejects HEIC",
  "Timezone bug in daily digest", "CLI --json prints colours", "Improve error for missing token",
  "Support HTTP proxy env vars", "Billing page shows wrong currency", "Keyboard shortcuts conflict on Linux",
  "Mobile: sidebar won't close", "Add retry to S3 uploads", "Deprecation warning from punycode",
  "Email templates not localized", "Audit log misses API key rotation", "Sort by date is unstable",
  "Image previews broken behind CDN", "Make onboarding skippable", "Long titles overflow in cards",
  "Notifications arrive twice", "GraphQL N+1 on /projects", "Allow custom domains", "Export to PDF cuts tables",
  "Accessibility: focus ring missing", "Bump zod to v4", "Add ARM64 Docker image", "Clipboard copy fails in Firefox",
  "Remove legacy v1 endpoints",
];
const LABELS = [["bug"], ["bug", "api"], ["docs"], ["bug", "webhooks"], ["ui"], ["bug", "export"], ["search"], ["chore"], ["test"], ["bug", "perf"]];
const PEOPLE = ["ada", "linus", "grace", "ken", "barbara", "dennis", "margaret", "guido"];

// Even issue numbers are stale (50–140 days old); odd ones were touched in the last 2 weeks.
const now = Date.now();
const issues = TITLES.map((title, i) => {
  const number = 100 + i;
  const stale = i % 2 === 0;
  const ageDays = stale ? 50 + ((i * 7) % 90) : 1 + (i % 13);
  return {
    number,
    title,
    state: "open",
    labels: [...LABELS[i % LABELS.length]],
    author: PEOPLE[i % PEOPLE.length],
    assignee: i % 3 === 0 ? null : PEOPLE[(i + 3) % PEOPLE.length],
    comments: (i * 5) % 17,
    created_at: new Date(now - (ageDays + 30) * DAY).toISOString(),
    updated_at: new Date(now - ageDays * DAY).toISOString(),
    url: `https://github.example.test/acme/app/issues/${number}`,
  };
});
const branches = new Set(["main", "feat/otel", "fix/login-flicker", "old/v1-api"]);
const find = (n) => {
  const it = issues.find((x) => x.number === Number(n));
  if (!it) throw new Error(`Issue #${n} not found`);
  return it;
};

const num = { type: "integer", description: "Issue number" };

defineAdapter({
  name: "github-mock",
  tools: [
    {
      name: "list_issues",
      description: "List issues in the acme/app repository. Filter by state or label.",
      effect: "read",
      input: { type: "object", properties: { state: { type: "string", enum: ["open", "closed", "all"] }, label: { type: "string" } } },
      run: async ({ state = "open", label }) =>
        issues.filter((i) => (state === "all" || i.state === state) && (!label || i.labels.includes(label))),
    },
    {
      name: "get_issue",
      description: "Get one issue by number, including its body.",
      effect: "read",
      input: { type: "object", properties: { number: num }, required: ["number"] },
      run: async ({ number }) => ({ ...find(number), body: `Steps to reproduce for "${find(number).title}"…` }),
    },
    {
      name: "add_label",
      description: "Add a label to an issue.",
      effect: "write",
      input: { type: "object", properties: { number: num, label: { type: "string" } }, required: ["number", "label"] },
      run: async ({ number, label }) => {
        const it = find(number);
        if (!it.labels.includes(label)) it.labels.push(label);
        it.updated_at = new Date().toISOString();
        return { number: it.number, labels: it.labels };
      },
    },
    {
      name: "close_issue",
      description: "Close an issue with an optional comment.",
      effect: "write",
      input: { type: "object", properties: { number: num, comment: { type: "string" } }, required: ["number"] },
      run: async ({ number, comment }) => {
        const it = find(number);
        it.state = "closed";
        return { number: it.number, state: it.state, comment: comment ?? null };
      },
    },
    {
      name: "delete_branch",
      description: "Permanently delete a git branch. Cannot be undone.",
      effect: "destructive",
      input: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] },
      run: async ({ branch }) => {
        if (branch === "main") throw new Error("Refusing to delete the default branch");
        if (!branches.delete(branch)) throw new Error(`Branch ${branch} not found`);
        return { deleted: branch, remaining: [...branches] };
      },
    },
  ],
}).serve();
