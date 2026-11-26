// Mycel field test: 8 real open-source MCP servers, direct vs through Mycel.
import { readFileSync, writeFileSync } from "node:fs";
import { connect, mycel, text, tok, median, YAML } from "./lib.mjs";
import { resolve, sep } from "node:path";

// Paths go through JSON so Windows backslashes survive inside the sandbox script.
const DATA = resolve("data");
const Q = (p) => JSON.stringify(p);

const cfg = YAML.parse(readFileSync("mycel.yaml", "utf8")).servers;
const results = [];
const log = (id, name, pass, data, note = "") => {
  results.push({ id, name, pass, data, note });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}  ${JSON.stringify(data)} ${note}`);
};
const j = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };

// ---------------------------------------------------------------- direct side
let t0 = Date.now();
const direct = {};
await Promise.all(Object.entries(cfg).map(async ([n, s]) => { direct[n] = await connect(s.command, s.args); }));
const directConnectMs = Date.now() - t0;
let directTools = [];
for (const [n, c] of Object.entries(direct)) directTools.push(...(await c.listTools()).tools.map((t) => ({ ...t, server: n })));
const directTokens = tok(directTools.map(({ server, ...t }) => t));

// ---------------------------------------------------------------- mycel side
t0 = Date.now();
const m = await mycel();
const myTools = (await m.listTools()).tools;
const mycelReadyMs = Date.now() - t0;
const myTokens = tok(myTools) + tok(m.getInstructions?.() ?? "");
const call = async (tool, args = {}, extra = {}) => j(await m.callTool({ name: "mycel_call", arguments: { tool, args, ...extra } }));

// S1 context footprint
log("S1", "Context footprint (tool definitions sent to the model)", myTokens < directTokens / 5,
  { servers: Object.keys(cfg).length, tools: directTools.length, directTokens, mycelTokens: myTokens, exposed: myTools.length, savedPct: +(100 - (100 * myTokens) / directTokens).toFixed(1) });

// S2 startup
log("S2", "Startup until tools are listed", true, { directParallelMs: directConnectMs, mycelMs: mycelReadyMs });

// S3 search accuracy
const queries = [
  ["read a text file from disk", "filesystem.read_text_file"],
  ["show the git commit history", "git.git_log"],
  ["what time is it in Tokyo", "time.get_current_time"],
  ["convert 9am Istanbul time to New York", "time.convert_time"],
  ["download a web page as markdown", "fetch.fetch"],
  ["open a url in the browser", "playwright.browser_navigate"],
  ["take a screenshot of the page", "playwright.browser_take_screenshot"],
  ["click a button on the page", "playwright.browser_click"],
  ["remember a fact about a person in the knowledge graph", "memory.create_entities"],
  ["search files by name pattern", "filesystem.search_files"],
  ["show uncommitted changes", "git.git_diff_unstaged"],
  ["think step by step about a hard problem", "thinking.sequentialthinking"],
  ["fill out a web form", "playwright.browser_fill_form"],
  ["list a directory", "filesystem.list_directory"],
  ["create a new git branch", "git.git_create_branch"],
  ["add two numbers", "everything.get-sum"],
];
let top1 = 0, top3 = 0; const misses = [];
for (const [q, want] of queries) {
  const r = j(await m.callTool({ name: "mycel_search", arguments: { query: q, limit: 3 } }));
  const ids = (r.tools ?? r).map((t) => t.tool ?? t.id);
  if (ids[0] === want) top1++;
  if (ids.includes(want)) top3++; else misses.push(`${q} → ${ids[0]}`);
}
log("S3", "Tool search finds the right tool", top3 / queries.length >= 0.85, { queries: queries.length, top1, top3, top3Pct: Math.round((100 * top3) / queries.length) }, misses.length ? `misses: ${misses.join(" | ")}` : "");

// S4 per-call overhead
const dLat = [], mLat = [];
for (let i = 0; i < 15; i++) {
  let s = performance.now(); await direct.time.callTool({ name: "get_current_time", arguments: { timezone: "Europe/Istanbul" } }); dLat.push(performance.now() - s);
  s = performance.now(); await call("time.get_current_time", { timezone: "Europe/Istanbul" }); mLat.push(performance.now() - s);
}
const over = median(mLat) - median(dLat);
log("S4", "Per-call overhead (median of 15)", over < 25, { directMs: +median(dLat).toFixed(1), mycelMs: +median(mLat).toFixed(1), overheadMs: +over.toFixed(1) });

// S5 big output → ref
const dBig = text(await direct.filesystem.callTool({ name: "read_text_file", arguments: { path: resolve("data", "sales.csv") } }));
const mBig = await m.callTool({ name: "mycel_call", arguments: { tool: "filesystem.read_text_file", args: { path: resolve("data", "sales.csv") } } });
const mBigText = text(mBig);
const ref = (mBigText.match(/ref:\/\/[a-f0-9]+/) ?? [])[0];
const grep = ref ? text(await m.callTool({ name: "mycel_ref", arguments: { action: "read", ref, grep: "sku-42," } })) : "";
log("S5", "Large result (20k-row CSV) kept out of context", !!ref && tok(mBigText) < 2000 && grep.includes("sku-42"),
  { directTokens: tok(dBig), mycelTokens: tok(mBigText), ref: !!ref, grepTokens: tok(grep) });

// S6 multi-step job in one round trip
const code = `
  const listing = await tools.call("filesystem.list_directory", { path: ${Q(DATA)} });
  const raw = typeof listing === "string" ? listing : JSON.stringify(listing);
  const files = [...raw.matchAll(/note-\\d+\\.md/g)].map(x => x[0]);
  const stale = [];
  for (const f of [...new Set(files)]) {
    const body = await tools.call("filesystem.read_text_file", { path: ${Q(DATA)} + ${Q(sep)} + f });
    if (JSON.stringify(body).includes("status: stale")) stale.push(f);
  }
  await tools.call("memory.create_entities", { entities: [{ name: "stale-notes", entityType: "report", observations: stale }] });
  return { checked: new Set(files).size, stale: stale.length };`;
t0 = Date.now();
const run = j(await m.callTool({ name: "mycel_run", arguments: { code } }));
const runMs = Date.now() - t0;
const directRoundTrips = 1 + 15 + 1;
log("S6", "Multi-step task as one script (code mode)", run.ok && run.result?.stale === 5,
  { directRoundTrips, mycelRoundTrips: 1, toolCalls: run.toolCalls, ms: runMs, result: run.result }, run.ok ? "" : String(run.error));

// S7 prompt-injection guard: untrusted web content → destructive write
const s7 = j(await m.callTool({ name: "mycel_run", arguments: { code: `
  const page = await tools.call("fetch.fetch", { url: "https://example.com", max_length: 2000 });
  return await tools.call("filesystem.write_file", { path: ${Q(resolve("data", "pwned.txt"))}, content: JSON.stringify(page).slice(0, 200) });` } }));
const s7txt = JSON.stringify(s7);
let wrote = false; try { readFileSync(resolve("data", "pwned.txt")); wrote = true; } catch {}
log("S7", "Untrusted web content cannot trigger a file write without approval", !wrote && /approval/i.test(s7txt),
  { wroteFile: wrote, outcome: s7txt.slice(0, 160) });

// S8 browser automation works through the gateway
const nav = await call("playwright.browser_navigate", { url: "https://example.com" });
const snap = await call("playwright.browser_snapshot", {});
const snapTxt = JSON.stringify(snap);
log("S8", "Browser automation (Playwright) through Mycel", /Example Domain/.test(snapTxt) && nav?.status !== "approval_required",
  { navigate: nav?.status ?? "ok", snapshotTokens: tok(snapTxt), refOffloaded: /ref:\/\//.test(snapTxt) });

// S9 binary + progress
const img = JSON.stringify(await call("everything.get-tiny-image", {}));
let progress = 0;
const lr = await m.callTool({ name: "mycel_call", arguments: { tool: "everything.trigger-long-running-operation", args: { duration: 2, steps: 4 } } }, undefined, { onprogress: () => progress++, timeout: 30000 });
log("S9", "Images and progress notifications pass through", /image|ref:\/\//i.test(img) && !lr.isError,
  { imageHandled: /ref:\/\//.test(img) ? "ref" : "inline", progressEvents: progress, longRunning: text(lr).slice(0, 80) });

// S10 effect classification sanity
const cls = j(await m.callTool({ name: "mycel_search", arguments: { query: "browser", server: "playwright", limit: 25 } }));
const eff = {}; for (const t of cls.tools ?? cls) eff[t.effect] = (eff[t.effect] ?? 0) + 1;
const gitReset = j(await m.callTool({ name: "mycel_search", arguments: { query: "reset", server: "git", limit: 1 } }));
log("S10", "Risk classification is usable (not everything 'destructive')", (eff.destructive ?? 0) <= 6 && (gitReset.tools ?? gitReset)[0]?.effect === "destructive",
  { playwrightEffects: eff, gitReset: (gitReset.tools ?? gitReset)[0]?.effect });

writeFileSync("results.json", JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
