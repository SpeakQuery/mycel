// Build the Claude Desktop extension: site/mycel.mcpb (one-click install, no terminal).
//   npm run build && node scripts/build-mcpb.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "build", "mcpb");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });

const manifest = {
  manifest_version: "0.3",
  name: "mycel",
  display_name: "Mycel",
  version: pkg.version,
  description: "One gateway for all your MCP tools: smaller context, big results kept out of the chat, approvals for risky actions, and a savings line after each answer.",
  long_description:
    "Mycel puts all your MCP servers behind a few meta-tools, so the model finds tools on demand instead of loading every definition. Large results come back as compact references instead of flooding the chat. After installing, ask Claude: \"Set up Mycel\" (or \"Mycel'i kur\"). It shows a plan, asks you, then moves the servers you already use (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI) under Mycel, with backups. Undo any time: ask Claude to undo the Mycel setup.",
  author: { name: "SpeakQuery", url: "https://mycel.speakquery.ai" },
  repository: { type: "git", url: "https://github.com/SpeakQuery/mycel.git" },
  homepage: "https://mycel.speakquery.ai",
  documentation: "https://github.com/SpeakQuery/mycel#readme",
  support: "https://github.com/SpeakQuery/mycel/issues",
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: { command: "node", args: ["${__dirname}/server/index.js"], env: { MYCEL_EXTENSION: "1" } },
  },
  tools: [
    { name: "mycel_setup", description: "Set up Mycel: show a plan, then move your MCP servers under Mycel with backups (or undo)" },
    { name: "mycel_search", description: "Find tools across all connected servers" },
    { name: "mycel_describe", description: "Show a tool's input schema" },
    { name: "mycel_call", description: "Call a tool on any connected server" },
    { name: "mycel_run", description: "Run a short script that calls several tools in one step" },
    { name: "mycel_ref", description: "Read part of a large result kept outside the chat" },
    { name: "mycel_job", description: "Check or collect a long-running job" },
  ],
  tools_generated: true,
  keywords: ["mcp", "gateway", "tools", "context", "tokens", "savings"],
  license: pkg.license ?? "SEE LICENSE IN LICENSE",
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=20.0.0" } },
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(join(root, "extension", "server", "index.js"), join(out, "server", "index.js"));
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "mycel-extension", private: true, type: "module", version: pkg.version }, null, 2) + "\n");
for (const f of ["LICENSE", "NOTICE"]) if (existsSync(join(root, f))) copyFileSync(join(root, f), join(out, f));

// Bundle this exact build of Mycel (not whatever is on npm) with production dependencies only.
run("npm", ["pack", "--pack-destination", join(root, "build")]);
const tgz = readdirSync(join(root, "build")).find((f) => f.startsWith("speakquery-mycel-") && f.endsWith(".tgz"));
run("npm", ["install", "--prefix", out, "--omit=dev", "--no-fund", "--no-audit", "--loglevel=error", join(root, "build", tgz)]);
rmSync(join(root, "build", tgz));
rmSync(join(out, "package-lock.json"), { force: true });

const target = join(root, "site", "mycel.mcpb");
run("npx", ["-y", "@anthropic-ai/mcpb@2", "pack", out, target]);
console.log(`\n  ✓ ${target} (${(statSync(target).size / 1e6).toFixed(1)} MB), Mycel ${pkg.version}`);
