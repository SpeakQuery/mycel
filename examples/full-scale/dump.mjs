// Capture exactly what `tools/list` returns from every server in a mycel.yaml, scrub personal data, write one file per server.
//   node dump.mjs --config /path/to/mycel.yaml [--out dumps] [--raw /dir/for/unredacted/inspection]
// Connects the way Mycel does (dist/upstream.js, incl. stored OAuth tokens under <home>/oauth).
// Needs the repo built (npm run build). Writes <out>/<server>.json and <out>/../REDACTIONS.md (no original values).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = (f) => import(pathToFileURL(resolve(here, "../../dist", f)).href);
const { loadConfig } = await dist("config.js");
const { connectMcp } = await dist("upstream.js");
const { SecretVault } = await dist("secrets.js");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const cfgPath = arg("config");
if (!cfgPath) { console.error("usage: node dump.mjs --config <mycel.yaml> [--out dir] [--raw dir]"); process.exit(2); }
const outDir = resolve(arg("out", resolve(here, "dumps")));
const rawDir = arg("raw") && resolve(arg("raw"));
const loaded = loadConfig(resolve(cfgPath));
const baseDir = dirname(loaded.path);

// ---------------------------------------------------------------- redaction
const RULES = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["personal-name", /eyup|kutlu/gi],
  ["gmail", /@gmail/gi],
  ["token", /\b(?:sk|pk|ghp|gho|ghs|xox[abprs]|AKIA|AIza|eyJ)[-_A-Za-z0-9.]{16,}/g],
  ["bearer", /Bearer\s+[A-Za-z0-9._~+\/=-]{16,}/g],
  ["url-query-secret", /https?:\/\/[^\s"')]*[?&](?:token|key|api_?key|access_token|sig|signature|secret|auth|code)=[^\s"'&)]+/gi],
  ["user-path", /\/Users\/[^\s"'`,)\]]+/g],
  // nil/max UUIDs (all 0 or all f) appear in schema validation patterns; they are constants, not ids.
  ["uuid-id", /\b(?!0{8}-0{4}-0{4}-0{4}-0{12}\b)(?!f{8}-f{4}-f{4}-f{4}-f{12}\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
];
const labPaths = [...new Set([baseDir, process.cwd()])].filter((p) => p.length > 8);
const log = [];
function scrub(str, ctx) {
  let s = str;
  for (const p of labPaths) {
    const n = s.split(p).length - 1;
    if (n) { s = s.split(p).join("<lab>"); log.push({ ...ctx, kind: "lab-path", reason: "absolute lab path replaced with <lab> (placeholder)", count: n }); }
  }
  for (const [kind, re] of RULES) {
    const m = s.match(re);
    if (m) { s = s.replace(re, "<redacted>"); log.push({ ...ctx, kind, reason: REASON[kind], count: m.length }); }
  }
  return s;
}
const REASON = { email: "email address", "personal-name": "personal name", gmail: "gmail address fragment", token: "token/API-key shaped string", bearer: "bearer credential", "url-query-secret": "URL carrying a secret query parameter", "user-path": "absolute path under /Users/", "uuid-id": "UUID (possible user/workspace/team id)" };
function walk(v, ctx, path) {
  if (typeof v === "string") return scrub(v, { ...ctx, field: path });
  if (Array.isArray(v)) return v.map((x, i) => walk(x, ctx, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, ctx, path ? `${path}.${k}` : k)]));
  return v;
}

// ---------------------------------------------------------------- capture
const vault = new SecretVault(loaded.config.secrets);
mkdirSync(outDir, { recursive: true });
if (rawDir) mkdirSync(rawDir, { recursive: true });
const capturedAt = new Date().toISOString().slice(0, 10);
const summary = [];
for (const [name, cfg] of Object.entries(loaded.config.servers)) {
  process.stderr.write(`${name} ... `);
  try {
    const provider = await connectMcp(name, cfg, vault, baseDir, { home: loaded.home });
    const client = provider.client;
    const info = client.getServerVersion() ?? {};
    const tools = []; let cursor;
    do { const r = await client.listTools(cursor ? { cursor } : {}); tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
    const raw = { server: name, serverInfo: { name: info.name, version: info.version }, capturedAt, tools };
    if (rawDir) writeFileSync(resolve(rawDir, `${name}.json`), JSON.stringify(raw, null, 2) + "\n");
    const clean = { ...raw, tools: tools.map((t) => walk(t, { server: name, tool: t.name }, "")) };
    writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(clean, null, 2) + "\n");
    summary.push([name, tools.length]);
    process.stderr.write(`${tools.length} tools\n`);
    await provider.close();
  } catch (e) { process.stderr.write(`FAILED: ${e.message}\n`); process.exitCode = 1; }
}

// ---------------------------------------------------------------- redaction report (never contains the original values)
const rows = log.map((r) => `| ${r.server} | ${r.tool} | ${r.field.replace(/^\./, "")} | ${r.kind} | ${r.count} | ${r.reason} |`);
writeFileSync(resolve(outDir, "..", "REDACTIONS.md"), `# Redactions

Every personal or account-specific value found in the captured \`tools/list\` responses was replaced with \`<redacted>\`; absolute paths of the capture machine's lab folder were replaced with \`<lab>\`. This file lists where, never what.

Total hits: ${log.length} locations, ${log.reduce((a, r) => a + r.count, 0)} occurrences.

| Server | Tool | Field | Kind | Occurrences | Reason |
|---|---|---|---|---|---|
${rows.join("\n") || "| - | - | - | - | 0 | nothing found |"}
`);
console.log(summary.map(([n, c]) => `${n}: ${c}`).join("\n"));
