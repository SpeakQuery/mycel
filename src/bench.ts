import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Mycel } from "./core.js";
import { MycelConfig } from "./config.js";
import { estimateTokens, wireDefinition } from "./catalog.js";
import type { ToolProvider } from "./upstream.js";

/**
 * Reproducible benchmark. Builds a realistic 12-server / ~180-tool catalog in
 * process and compares what the model has to read with direct MCP vs Mycel.
 * Token counts are estimates (~4 chars/token), applied identically to both sides.
 */

type Spec = { name: string; desc: string; params: Record<string, [string, string, boolean?]> };

function capital(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}
const P = (type: string, desc: string, req = false): [string, string, boolean] => [type, desc, req];

const SERVERS: Record<string, { about: string; tools: Spec[] }> = {
  github: { about: "GitHub", tools: verbs("repository", ["list_issues", "get_issue", "create_issue", "update_issue", "add_label", "remove_label", "list_pull_requests", "get_pull_request", "create_pull_request", "merge_pull_request", "list_commits", "get_file_contents", "create_or_update_file", "search_code", "search_repositories", "fork_repository", "create_branch", "delete_branch", "list_workflow_runs", "rerun_workflow"]) },
  slack: { about: "Slack", tools: verbs("channel", ["list_channels", "post_message", "reply_to_thread", "add_reaction", "get_channel_history", "get_thread_replies", "search_messages", "get_users", "get_user_profile", "set_status", "upload_file", "create_channel", "archive_channel", "invite_to_channel"]) },
  gmail: { about: "Gmail", tools: verbs("email", ["search_emails", "read_email", "send_email", "draft_email", "reply_email", "forward_email", "list_labels", "modify_labels", "delete_email", "list_attachments", "download_attachment", "create_filter"]) },
  calendar: { about: "Google Calendar", tools: verbs("event", ["list_calendars", "list_events", "get_event", "create_event", "update_event", "delete_event", "find_free_time", "respond_to_invite", "list_attendees", "set_reminder"]) },
  notion: { about: "Notion", tools: verbs("page", ["search", "get_page", "create_page", "update_page", "append_blocks", "get_database", "query_database", "create_database_item", "update_database_item", "delete_block", "list_users", "add_comment", "list_comments"]) },
  linear: { about: "Linear", tools: verbs("ticket", ["list_teams", "list_issues", "get_issue", "create_issue", "update_issue", "assign_issue", "add_comment", "list_cycles", "list_projects", "create_project", "search_issues", "set_priority", "archive_issue"]) },
  postgres: { about: "PostgreSQL", tools: verbs("table", ["query", "list_schemas", "list_tables", "describe_table", "explain_query", "insert_rows", "update_rows", "delete_rows", "create_table", "drop_table", "list_indexes", "analyze_table"]) },
  filesystem: { about: "local filesystem", tools: verbs("file", ["read_file", "read_multiple_files", "write_file", "edit_file", "create_directory", "list_directory", "directory_tree", "move_file", "search_files", "get_file_info", "delete_file", "list_allowed_directories"]) },
  browser: { about: "headless browser", tools: verbs("page", ["navigate", "screenshot", "click", "fill", "select", "hover", "evaluate", "get_text", "get_html", "wait_for", "go_back", "pdf", "list_tabs", "close_tab", "upload_file", "press_key", "scroll", "set_viewport"]) },
  drive: { about: "Google Drive", tools: verbs("document", ["search_files", "get_file", "download_file", "upload_file", "create_folder", "move_file", "share_file", "list_permissions", "export_document", "create_document", "update_document", "delete_file", "list_revisions", "restore_revision"]) },
  studio: { about: "AI media studio (image, video, audio generation)", tools: verbs("media", ["generate_image", "edit_image", "upscale_image", "remove_background", "generate_video", "extend_video", "upscale_video", "lip_sync", "generate_music", "text_to_speech", "transcribe_audio", "list_models", "get_generation", "estimate_cost"]) },
  stripe: { about: "Stripe (test mode)", tools: verbs("customer", ["list_customers", "get_customer", "create_customer", "list_invoices", "create_invoice", "list_subscriptions", "cancel_subscription", "create_refund", "list_payments", "get_balance", "create_payment_link", "search_charges", "list_products", "create_price", "list_disputes"]) },
};

function verbs(noun: string, names: string[]): Spec[] {
  return names.map((n) => {
    const words = n.replace(/_/g, " ");
    const params: Spec["params"] = {};
    if (/list|search|query|find/.test(n)) {
      params.query = P("string", `Search query or filter expression for the ${noun}s to return. Supports field:value syntax and boolean operators.`);
      params.limit = P("integer", "Maximum number of results to return (1-100, default 30).");
      params.cursor = P("string", "Pagination cursor returned by a previous call.");
      params.sort = P("string", "Sort order, e.g. 'updated_desc' or 'created_asc'.");
    } else {
      params.id = P("string", `Unique identifier of the ${noun} this operation applies to.`, !/create|generate|upload|send|draft|insert|text_to|navigate/.test(n));
    }
    if (/create|update|send|post|reply|draft|write|edit|append|insert|generate|comment|set|fill/.test(n)) {
      params.title = P("string", `Title or subject for the ${noun}. Plain text, max 256 characters.`);
      params.body = P("string", `Main content. Markdown is supported. Mentions use @handle syntax; attachments must be referenced by URL or upload id.`, true);
      params.metadata = P("object", "Optional key/value metadata to attach. Keys must be strings; values are strings, numbers or booleans.");
    }
    if (/generate|video|image|music|speech|lip/.test(n)) {
      params.prompt = P("string", "Detailed natural-language description of the desired output, including style, subject, lighting, camera and mood.", true);
      params.model = P("string", "Model identifier to use. Call list_models to see options and their prices.");
      params.aspect_ratio = P("string", "Output aspect ratio such as 16:9, 9:16 or 1:1.");
      params.duration_seconds = P("number", "Length of the output in seconds where applicable.");
    }
    params.workspace = P("string", `Workspace, organisation or account that owns the ${noun}. Defaults to the authenticated user's primary workspace.`);
    return {
      name: n,
      desc: `${capital(words)} in ${noun === "media" ? "the media studio" : `your ${noun}s`}. Returns a JSON object describing the result. Requires the appropriate OAuth scope; respects workspace permissions and rate limits (see docs for quotas). Use this when the user asks to ${words}.`,
      params,
    };
  });
}

function schema(spec: Spec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, [type, description, req]] of Object.entries(spec.params)) {
    properties[k] = { type, description };
    if (req) required.push(k);
  }
  return { type: "object", properties, required };
}

/** Fake data the bench task uses. */
function issues(n: number) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    number: 1000 + i,
    title: `Issue ${i}: ${["Crash on save", "Slow dashboard", "Typo in docs", "OAuth redirect loop", "Flaky test"][i % 5]}`,
    state: "open",
    user: { login: `user${i % 9}`, id: 5000 + i, avatar_url: `https://avatars.example.com/u/${5000 + i}?v=4`, type: "User" },
    labels: i % 3 ? [{ name: "bug", color: "d73a4a", description: "Something isn't working" }] : [],
    comments: i % 7,
    created_at: new Date(now - (i * 3 + 5) * 86400000).toISOString(),
    updated_at: new Date(now - (i % 2 ? 45 : 3) * 86400000).toISOString(),
    body: `Steps to reproduce:\n1. Open the app\n2. Go to settings\n3. Click save\n\nExpected: it saves. Actual: ${["crash", "nothing happens", "error 500"][i % 3]}.\n\nEnvironment: macOS 26, Chrome 142.`,
    html_url: `https://github.com/acme/web/issues/${1000 + i}`,
  }));
}

function provider(server: string, specs: Spec[], calls: { n: number }): ToolProvider {
  return {
    listTools: async () => specs.map((s) => ({ name: s.name, description: s.desc, inputSchema: schema(s) })),
    callTool: async (name, args) => {
      calls.n++;
      if (server === "github" && name === "list_issues") return { content: [{ type: "text", text: JSON.stringify(issues(Number(args.limit ?? 40))) }] };
      if (server === "postgres" && name === "query") {
        const rows = ["id,region,product,units,revenue_usd"].concat(Array.from({ length: 5000 }, (_, i) => `${i},${["EU", "US", "APAC"][i % 3]},SKU-${i % 40},${(i * 7) % 90},${((i * 37) % 9000) / 10}`)).join("\n");
        return { content: [{ type: "text", text: rows }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, server, tool: name, id: args.id ?? "new_1" }) }] };
    },
  };
}

const QUERIES: Array<[string, string]> = [
  ["list open github issues", "github.list_issues"],
  ["send an email to the team", "gmail.send_email"],
  ["post a message in a slack channel", "slack.post_message"],
  ["make a video from a prompt", "studio.generate_video"],
  ["find a free time slot for a meeting", "calendar.find_free_time"],
  ["run a sql query", "postgres.query"],
  ["take a screenshot of the page", "browser.screenshot"],
  ["refund a customer payment", "stripe.create_refund"],
  ["read a file from disk", "filesystem.read_file"],
  ["upscale a photo", "studio.upscale_image"],
  ["merge a pull request", "github.merge_pull_request"],
  ["add a comment to a linear ticket", "linear.add_comment"],
  ["share a google drive document", "drive.share_file"],
  ["query a notion database", "notion.query_database"],
  ["transcribe this audio", "studio.transcribe_audio"],
  ["cancel a subscription", "stripe.cancel_subscription"],
  ["delete a calendar event", "calendar.delete_event"],
  ["describe the columns of a table", "postgres.describe_table"],
  ["text to speech voiceover", "studio.text_to_speech"],
  ["label an issue as stale", "github.add_label"],
];

export interface BenchResult {
  servers: number;
  tools: number;
  context: { directTokens: number; mycelTokens: number; reduction: number };
  task: { name: string; direct: { roundTrips: number; tokens: number }; mycel: { roundTrips: number; tokens: number }; reduction: number };
  table: { rows: number; directTokens: number; mycelTokens: number; reduction: number };
  video: { bytes: number; directTokens: number; mycelTokens: number; keyframes: number } | null;
  search: { queries: number; top1: number; top3: number };
}

export async function runBench(): Promise<BenchResult> {
  const home = mkdtempSync(join(tmpdir(), "mycel-bench-"));
  const calls = { n: 0 };
  try {
    const providers = Object.fromEntries(Object.entries(SERVERS).map(([name, s]) => [name, { provider: provider(name, s.tools, calls) }]));
    const config = MycelConfig.parse({ pinning: { enabled: false }, recorder: { enabled: false }, refs: { dir: join(home, "refs") } });
    const m = await new Mycel({ config, path: null, home }, { providers, noConnect: true }).start();

    // 1) Context footprint
    const fp = m.contextFootprint();

    // 2) Task: "label every open issue not updated in 30 days as stale"
    const N = 40;
    const listResult = JSON.stringify(issues(N));
    const stale = issues(N).filter((i) => Date.now() - Date.parse(i.updated_at) > 30 * 86400000);
    // Direct MCP: the model reads the whole list, then issues one tool call per stale issue.
    const perCall = estimateTokens({ name: "github__add_label", arguments: { id: "1000", body: "stale", workspace: "acme" } }) + estimateTokens({ ok: true, server: "github", tool: "add_label", id: "1000" });
    const directTask = { roundTrips: 1 + stale.length, tokens: estimateTokens(listResult) + stale.length * perCall };
    const script = `const issues = await tools.call("github.list_issues", { query: "state:open", limit: ${N} });
const stale = issues.filter(i => daysSince(i.updated_at) > 30);
for (const i of stale) await tools.call("github.add_label", { id: String(i.number), body: "stale" });
return { labelled: stale.length };`;
    const run = await m.run(script);
    if (!run.ok) throw new Error(`bench script failed: ${run.error}`);
    const mycelTask = { roundTrips: 1, tokens: estimateTokens(script) + estimateTokens(run.result) };

    // 3) Large table through the ref store
    const q = await m.call("postgres.query", { query: "select * from sales" });
    const rawRows = (await providers.postgres.provider.callTool("query", {}, {})).content[0].text as string;
    const tableMycel = estimateTokens(q.status === "ok" ? q.result : q);

    // 4) Video through the ref store (needs ffmpeg)
    let video: BenchResult["video"] = null;
    try {
      const file = join(home, "clip.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
      const buf = readFileSync(file);
      const meta = m.refs.put(buf, { name: "clip.mp4", mime: "video/mp4" });
      const handle = m.refs.handle(meta);
      video = { bytes: buf.length, directTokens: Math.ceil(buf.toString("base64").length / 4), mycelTokens: estimateTokens(handle), keyframes: meta.digest.kind === "video" ? meta.digest.keyframes.length : 0 };
    } catch {
      video = null;
    }

    // 5) Search quality
    let top1 = 0;
    let top3 = 0;
    for (const [query, expected] of QUERIES) {
      const hits = m.catalog.search(query, { limit: 3 }).map((h) => h.tool.id);
      if (hits[0] === expected) top1++;
      if (hits.includes(expected)) top3++;
    }

    await m.close();
    const pct = (a: number, b: number) => Math.round((1 - b / a) * 1000) / 10;
    return {
      servers: Object.keys(SERVERS).length,
      tools: m.catalog.size,
      context: { directTokens: estimateTokens(m.catalog.all().map(wireDefinition)), mycelTokens: fp.mycelTokens, reduction: pct(fp.directTokens, fp.mycelTokens) },
      task: { name: `Label ${stale.length} stale issues out of ${N}`, direct: directTask, mycel: mycelTask, reduction: pct(directTask.tokens, mycelTask.tokens) },
      table: { rows: 5000, directTokens: estimateTokens(rawRows), mycelTokens: tableMycel, reduction: pct(estimateTokens(rawRows), tableMycel) },
      video,
      search: { queries: QUERIES.length, top1, top3 },
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function pctLabel(a: number, b: number) {
  const p = (1 - b / a) * 100;
  return p > 99.9 ? ">99.9%" : `${Math.round(p * 10) / 10}%`;
}

export function formatBench(r: BenchResult): string {
  const k = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US"));
  const lines = [
    `Mycel benchmark — ${r.servers} servers, ${r.tools} tools (token counts ≈ chars/4, same method on both sides)`,
    ``,
    `| Scenario | Direct MCP | Mycel | Saved |`,
    `|---|---:|---:|---:|`,
    `| Tool definitions in context | ${k(r.context.directTokens)} tokens | ${k(r.context.mycelTokens)} tokens | ${r.context.reduction}% |`,
    `| ${r.task.name} | ${r.task.direct.roundTrips} round trips · ${k(r.task.direct.tokens)} tokens | ${r.task.mycel.roundTrips} round trip · ${k(r.task.mycel.tokens)} tokens | ${r.task.reduction}% |`,
    `| ${r.table.rows.toLocaleString("en-US")}-row SQL result | ${k(r.table.directTokens)} tokens | ${k(r.table.mycelTokens)} tokens (digest + ref) | ${r.table.reduction}% |`,
    ...(r.video ? [`| 8 s 720p video (${(r.video.bytes / 1024 / 1024).toFixed(1)} MB) | ${k(r.video.directTokens)} tokens as base64 | ${k(r.video.mycelTokens)} tokens (metadata + ${r.video.keyframes} keyframe refs) | ${pctLabel(r.video.directTokens, r.video.mycelTokens)} |`] : []),
    ``,
    `Tool search (BM25, offline): top-1 ${r.search.top1}/${r.search.queries}, top-3 ${r.search.top3}/${r.search.queries}`,
  ];
  return lines.join("\n");
}
