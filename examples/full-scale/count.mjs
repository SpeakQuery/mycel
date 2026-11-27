// Direct vs Mycel context footprint over 15 captured MCP servers. No network, no logins.
// Needs the repo built (npm ci && npm run build at the repo root). Exit 1 unless Mycel < 5% of direct.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../dist/cli.js");
const tok = (x) => Math.round((typeof x === "string" ? x : JSON.stringify(x)).length / 4); // ~4 chars/token, same as the lab

// ---- direct side: everything every server's tools/list returned, as a client would load it
const dumps = readdirSync(join(here, "dumps")).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(here, "dumps", f), "utf8")));
// Headline = what a client puts in the model's context per tool: name, description, inputSchema, annotations
// (the same shape as Mycel's own contextFootprint). outputSchema is not sent to the model by typical clients,
// so it is shown separately as "full payload" (everything tools/list returned) for transparency.
const wire = (t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) });
const rows = dumps.map((d) => ({ server: d.server, version: d.serverInfo?.version ?? "", tools: d.tools.length, directTokens: tok(d.tools.map(wire)), fullPayloadTokens: tok(d.tools) }));
const allTools = dumps.flatMap((d) => d.tools);
const totalTools = allTools.length;
const directTokens = tok(allTools.map(wire));
const fullPayloadTokens = tok(allTools);

// ---- Mycel side: start the built gateway over stdio against the replay config
const home = mkdtempSync(join(tmpdir(), "mycel-full-scale-"));
const t0 = Date.now();
const client = new Client({ name: "full-scale-count", version: "1" });
let mycelTools, instructions;
const loadedIds = new Set();
const gatewayIds = new Set(); // every tool id the gateway actually exposes (for the reverse check)
const wanted = dumps.flatMap((d) => d.tools.map((t) => `${d.server}.${t.name}`));
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve", "--no-dashboard", "-c", join(here, "mycel.yaml")],
    cwd: here,
    env: { ...getDefaultEnvironment(), MYCEL_HOME: home },
    stderr: "ignore",
  }));
  mycelTools = (await client.listTools()).tools;
  instructions = client.getInstructions() ?? "";
  // What did the gateway actually load? Ask it about every tool id from the dumps (mycel_describe, 10 per call).
  const parse = (r) => JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? "null");
  for (let i = 0; i < wanted.length; i += 10) {
    const chunk = wanted.slice(i, i + 10);
    const res = parse(await client.callTool({ name: "mycel_describe", arguments: { tools: chunk } }));
    for (const r of Array.isArray(res) ? res : []) if (r && !r.error && wanted.includes(r.tool)) loadedIds.add(r.tool);
  }
  // And the other direction: list everything the gateway holds (mycel_search with query "*" lists all tools).
  const all = parse(await client.callTool({ name: "mycel_search", arguments: { query: "*", limit: 1_000_000 } }));
  for (const r of Array.isArray(all) ? all : []) if (r?.tool) gatewayIds.add(r.tool);
} finally {
  await client.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
const startupMs = Date.now() - t0;
const mycelTokens = tok(mycelTools) + tok(instructions);
const pct = (100 * mycelTokens) / directTokens;

// ---- report
const pad = (s, n) => String(s).padEnd(n), num = (s, n) => String(s).padStart(n);
console.log(`${pad("server", 20)}${pad("version", 24)}${num("tools", 6)}${num("direct tokens", 15)}${num("full payload", 14)}`);
for (const r of rows) console.log(`${pad(r.server, 20)}${pad(r.version, 24)}${num(r.tools, 6)}${num(r.directTokens, 15)}${num(r.fullPayloadTokens, 14)}`);
console.log("-".repeat(79));
console.log(`${pad("TOTAL (direct)", 44)}${num(totalTools, 6)}${num(directTokens, 15)}${num(fullPayloadTokens, 14)}`);
console.log(`${pad(`Mycel (${mycelTools.length} tools + instructions)`, 44)}${num("", 6)}${num(mycelTokens, 15)}`);
console.log("\ndirect tokens = name+description+inputSchema+annotations; full payload also counts outputSchema (not sent to the model by typical clients).");
console.log(`Mycel is ${pct.toFixed(2)}% of direct (${(100 - pct).toFixed(1)}% saved, ${(directTokens / mycelTokens).toFixed(0)}x smaller). Startup ${startupMs} ms.`);

const missing = wanted.filter((id) => !loadedIds.has(id));
const missingServers = [...new Set(missing.map((id) => id.slice(0, id.indexOf("."))))];
if (missing.length) {
  console.error(`\nFAIL: Mycel did not load ${missing.length} of ${wanted.length} tools from the dumps (${loadedIds.size} loaded).`);
  console.error(`  servers with missing tools: ${missingServers.map((s) => `${s} (${missing.filter((id) => id.startsWith(s + ".")).length}/${dumps.find((d) => d.server === s).tools.length})`).join(", ")}`);
  console.error(`  e.g. ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
}
const wantedSet = new Set(wanted);
const extra = [...gatewayIds].filter((id) => !wantedSet.has(id));
if (!gatewayIds.size) console.error("\nFAIL: could not list the gateway's tools (mycel_search \"*\" returned nothing).");
if (extra.length) console.error(`\nFAIL: the gateway exposes ${extra.length} tool id${extra.length > 1 ? "s" : ""} that are not in the dumps: ${extra.join(", ")}`);
const ok = pct < 5 && !missing.length && !extra.length && gatewayIds.size > 0;
writeFileSync(join(here, "results.json"), JSON.stringify({
  servers: rows, totalTools, directTokens, fullPayloadTokens,
  mycel: { exposedTools: mycelTools.length, toolTokens: tok(mycelTools), instructionTokens: tok(instructions), tokens: mycelTokens },
  gatewayTools: gatewayIds.size,
  mycelPercentOfDirect: +pct.toFixed(2), tokenEstimate: "chars/4", pass: ok,
}, null, 2) + "\n");
if (pct >= 5) console.error("FAIL: Mycel footprint is not < 5% of direct.");
if (!ok) process.exit(1);
