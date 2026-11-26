import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { connect, tok, YAML } from "./lib.mjs";
const all = YAML.parse(readFileSync("mycel.yaml", "utf8")).servers;
const order = ["time", "fetch", "filesystem", "git", "memory", "thinking", "everything", "playwright"];
const rows = [];
for (let n = 1; n <= order.length; n++) {
  const servers = Object.fromEntries(order.slice(0, n).map((k) => [k, { ...all[k], cwd: process.cwd() }]));
  const dir = `scale/${n}`; mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/mycel.yaml`, YAML.stringify({ servers }));
  let direct = 0, tools = 0;
  for (const k of Object.keys(servers)) { const c = await connect(all[k].command, all[k].args); const t = (await c.listTools()).tools; tools += t.length; direct += tok(t); await c.close(); }
  const m = await connect("node", ["../../dist/cli.js", "serve", "--no-dashboard", "-c", `${dir}/mycel.yaml`]);
  const exposed = (await m.listTools()).tools;
  const mycel = tok(exposed) + tok(m.getInstructions?.() ?? "");
  await m.close();
  rows.push({ servers: n, tools, directTokens: direct, mycelTokens: mycel, exposed: exposed.length, savedPct: Math.round(100 - (100 * mycel) / direct) });
}
console.table(rows);
writeFileSync("scale.json", JSON.stringify(rows, null, 2));
process.exit(0);
