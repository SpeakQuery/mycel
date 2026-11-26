import { createRequire } from "node:module";
const req = createRequire(new URL("../../package.json", import.meta.url));
const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = req("@modelcontextprotocol/sdk/client/stdio.js");
export const YAML = req("yaml");
export async function connect(command, args, cwd = process.cwd()) {
  const c = new Client({ name: "lab", version: "1" });
  await c.connect(new StdioClientTransport({ command, args, cwd, stderr: "ignore" }));
  return c;
}
export const mycel = () => connect("node", ["../../dist/cli.js", "serve", "--no-dashboard"]);
export const text = (r) => r.content?.map((c) => c.text ?? `[${c.type}]`).join("\n") ?? "";
export const tok = (x) => Math.round((typeof x === "string" ? x : JSON.stringify(x)).length / 4);
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
