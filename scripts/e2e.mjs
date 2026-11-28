#!/usr/bin/env node
// End-to-end test of what a real user does, in a throwaway home folder (never touches yours):
//   install → setup → apps start Mycel → search + call a real MCP server → savings line → stats → undo → uninstall,
//   plus the Claude Desktop extension path (mycel_setup plan/apply).
// Usage: npm run build && node scripts/e2e.mjs            (synthetic app configs; what CI runs)
//        node scripts/e2e.mjs --copy-real                  (also copies YOUR app configs into the throwaway home first)
// Prints one line per check and exits 1 if any check fails.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const mock = join(root, "examples", "servers", "github-mock.mjs");
if (!existsSync(cli)) {
  console.error("Build first: npm run build");
  process.exit(2);
}
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "mycel-e2e-"));
  const os = platform();
  const appData = join(home, "AppData", "Roaming");
  const claudeDir = os === "darwin" ? join(home, "Library", "Application Support", "Claude") : os === "win32" ? join(appData, "Claude") : join(home, ".config", "Claude");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    MYCEL_HOME: "",
    MYCEL_NO_KEYCHAIN: "1", // never write to your real keychain
    MYCEL_NO_CLAUDE_CLI: "1", // never call your real `claude` CLI
    MYCEL_NO_UPDATE: "1",
    MYCEL_ENTRY_ABSOLUTE: "1", // apps start this build, not npm's
    MYCEL_LANG: "en",
    __CFBundleIdentifier: "",
  };
  delete env.MYCEL_HOME;
  delete env.MYCEL_CONFIG;
  return { home, claudeDir, env };
}
const put = (p, s) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
  return s;
};
const rd = (p) => readFileSync(p, "utf8");
const node = process.execPath;
const mycel = (sb, args, input) => spawnSync(node, [cli, ...args], { env: sb.env, cwd: sb.home, encoding: "utf8", input, timeout: 120000 });

/** Start an MCP server the way an app would, initialize, send all requests, collect replies by id. */
function mcp(command, args, env, requests, waitMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    const byId = {};
    let sent = false;
    let nextSent = 0;
    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    const finish = () => {
      clearTimeout(t);
      p.kill();
      resolve({ byId, err });
    };
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined) byId[m.id] = m;
        } catch {
          /* not JSON */
        }
      }
      // One request at a time, like a person in a chat: the next goes out when the previous one is answered.
      if (byId[0] && !sent) {
        sent = true;
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
      }
      if (sent && nextSent < requests.length && (nextSent === 0 || byId[nextSent])) {
        const r = typeof requests[nextSent] === "function" ? requests[nextSent](byId) : requests[nextSent];
        nextSent++;
        send({ jsonrpc: "2.0", id: nextSent, ...r });
      }
      if (sent && nextSent === requests.length && byId[requests.length]) finish();
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => setTimeout(finish, 50));
    const t = setTimeout(finish, waitMs);
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  });
}
const text = (r) => (r?.result?.content ?? []).map((c) => c.text ?? "").join("\n");

/** Test apps. With real configs copied in, their content is kept and the test servers are added to it. */
function syntheticApps(sb) {
  const desktop = join(sb.claudeDir, "claude_desktop_config.json");
  const base = (f) => {
    try {
      const j = JSON.parse(rd(f));
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  };
  const d0 = base(desktop);
  const c0 = base(join(sb.home, ".claude.json"));
  const files = {
    desktop: put(desktop, JSON.stringify({ globalShortcut: "Ctrl+Space", ...d0, mcpServers: { ...(d0.mcpServers ?? {}), github: { command: node, args: [mock], env: { GITHUB_TOKEN: "ghp-e2e-123456" } } } }, null, 2) + "\n"),
    claude: put(join(sb.home, ".claude.json"), JSON.stringify({ numStartups: 3, ...c0, mcpServers: { ...(c0.mcpServers ?? {}), gh2: { command: node, args: [mock] } } }, null, 2)),
    cursor: put(join(sb.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { broken: { command: "definitely-not-installed-xyz" } } }, null, 2) + "\n"),
  };
  return { desktop, files };
}

function copyReal(sb) {
  const h = homedir();
  const os = platform();
  const realDesktop = os === "darwin" ? join(h, "Library", "Application Support", "Claude") : os === "win32" ? join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), "Claude") : join(h, ".config", "Claude");
  const pairs = [
    [join(h, ".claude.json"), join(sb.home, ".claude.json")],
    [join(h, ".gemini", "settings.json"), join(sb.home, ".gemini", "settings.json")],
    [join(h, ".cursor", "mcp.json"), join(sb.home, ".cursor", "mcp.json")],
    [join(h, ".codeium", "windsurf", "mcp_config.json"), join(sb.home, ".codeium", "windsurf", "mcp_config.json")],
    [join(realDesktop, "claude_desktop_config.json"), join(sb.claudeDir, "claude_desktop_config.json")],
  ];
  let n = 0;
  for (const [a, b] of pairs)
    if (existsSync(a)) {
      mkdirSync(dirname(b), { recursive: true });
      cpSync(a, b);
      n++;
    }
  return n;
}

async function terminalPath(copyRealConfigs) {
  console.log("\n# Terminal path: setup → apps → undo → uninstall");
  const sb = sandbox();
  try {
    if (copyRealConfigs) console.log(`  (copied ${copyReal(sb)} of your app configs into ${sb.home}; your originals are untouched)`);
    const { desktop, files } = syntheticApps(sb);
    const originals = Object.fromEntries([desktop, join(sb.home, ".claude.json"), join(sb.home, ".cursor", "mcp.json")].map((f) => [f, existsSync(f) ? rd(f) : null]));

    const dry = mycel(sb, ["setup"], "");
    check("setup without a terminal changes nothing", dry.status === 0 && /Dry run/.test(dry.stdout) && rd(desktop) === originals[desktop]);

    const s = mycel(sb, ["setup", "--yes"]);
    check("setup --yes succeeds", s.status === 0, s.status === 0 ? "" : (s.stderr || s.stdout).slice(-300));
    check("setup ends with a summary", /Mycel is set up: \d+ of \d+ server\(s\) working/.test(s.stdout));
    check("a broken server is reported, not fatal", /✗ broken/.test(s.stdout));
    const d = JSON.parse(rd(desktop));
    check("Claude Desktop now starts only Mycel, other settings kept", Object.keys(d.mcpServers ?? {}).join() === "mycel" && d.globalShortcut !== undefined);
    const yaml = rd(join(sb.home, ".mycel", "mycel.yaml"));
    check("API key is not in any config", !yaml.includes("ghp-e2e-123456") && !rd(desktop).includes("ghp-e2e-123456"));
    const sec = join(sb.home, ".mycel", "secrets.env");
    check("API key moved to the private secrets file", existsSync(sec) && rd(sec).includes("ghp-e2e-123456"));
    if (platform() !== "win32") check("secrets file is readable only by you", (statSync(sec).mode & 0o777) === 0o600);
    check("savings line turned on", /savingsLine: true/.test(yaml));

    const entry = d.mcpServers.mycel;
    // Few tools → Mycel's router exposes them directly (compact mode); many → meta-tools. Both must work.
    const tools = (b) => (b[1]?.result?.tools ?? []).map((t) => t.name);
    const r = await mcp(entry.command, entry.args, { ...sb.env, ...(entry.env ?? {}) }, [
      { method: "tools/list" },
      (b) => (tools(b).includes("mycel_search") ? { method: "tools/call", params: { name: "mycel_search", arguments: { query: "list open issues", limit: 3 } } } : { method: "tools/list" }),
      (b) =>
        tools(b).includes("mycel_call")
          ? { method: "tools/call", params: { name: "mycel_call", arguments: { tool: "github.list_issues", args: {} } } }
          : { method: "tools/call", params: { name: "github__list_issues", arguments: {} } },
    ]);
    const names = tools(r.byId);
    const compact = !names.includes("mycel_search");
    check(`the app sees the tools through Mycel (${compact ? "compact: few tools, exposed directly" : "meta-tools"})`, compact ? names.includes("github__list_issues") && names.includes("mycel_run") : names.includes("mycel_call"), names.slice(0, 6).join(","));
    if (!compact) check("search finds the real server's tool", /github\.list_issues/.test(text(r.byId[2])));
    const call = r.byId[3]?.result;
    check("call returns the real result", !!call && !call.isError && /Login page flickers|issues/i.test(text(r.byId[3])));
    check("answer ends with the savings line", /Mycel · this call/.test(text(r.byId[3])));
    check("savings travel in _meta", !!call?._meta?.["mycel/savings"]);

    const st = mycel(sb, ["stats"]);
    check("mycel stats reports measured savings", st.status === 0 && /measured/.test(st.stdout) && /last 7 days/.test(st.stdout));
    const doc = mycel(sb, ["doctor"]);
    check("mycel doctor runs", /mycel doctor/.test(doc.stdout));

    const u = mycel(sb, ["undo", "--yes"]);
    check("undo restores Claude Desktop byte-for-byte", u.status === 0 && rd(desktop) === originals[desktop]);
    check("undo restores Claude Code byte-for-byte", rd(join(sb.home, ".claude.json")) === originals[join(sb.home, ".claude.json")]);

    mycel(sb, ["setup", "--yes"]);
    put(join(sb.home, ".zshrc"), `alias ll=ls\n\n# Mycel\nexport PATH="${join(sb.home, ".mycel", "bin")}:$PATH"\n`);
    const un = mycel(sb, ["uninstall", "--yes"]);
    check("uninstall restores the apps", un.status === 0 && rd(desktop) === originals[desktop]);
    check("uninstall removes ~/.mycel and the PATH line", !existsSync(join(sb.home, ".mycel")) && !rd(join(sb.home, ".zshrc")).includes(".mycel"));
    void files;
  } finally {
    rmSync(sb.home, { recursive: true, force: true });
  }
}

async function extensionPath() {
  console.log("\n# Claude Desktop extension: no terminal, setup from the chat");
  const launcher = existsSync(join(root, "build", "mcpb", "server", "index.js")) ? join(root, "build", "mcpb", "server", "index.js") : null;
  if (!launcher) {
    console.log("SKIP  extension (run node scripts/build-mcpb.mjs first)");
    return;
  }
  const sb = sandbox();
  try {
    const { desktop } = syntheticApps(sb);
    const env = { ...sb.env, MYCEL_EXTENSION: "1" };
    delete env.MYCEL_ENTRY_ABSOLUTE;
    const r = await mcp(node, [launcher], env, [
      { method: "tools/list" },
      { method: "tools/call", params: { name: "mycel_setup", arguments: { action: "plan" } } },
      { method: "tools/call", params: { name: "mycel_setup", arguments: { action: "apply" } } },
    ], 120000);
    const names = (r.byId[1]?.result?.tools ?? []).map((t) => t.name);
    check("fresh extension shows mycel_setup", names.includes("mycel_setup"), names.join(","));
    let plan = {};
    try {
      plan = JSON.parse(text(r.byId[2]) || "{}");
    } catch {
      plan = { report: text(r.byId[2]) };
    }
    check("plan describes the change", /What will change/.test(plan.report ?? ""), (plan.report ?? JSON.stringify(r.byId[2] ?? null)).slice(0, 400));
    const applied = JSON.parse(text(r.byId[3]) || "{}");
    check("apply succeeds", applied.status === "ok", (applied.report ?? "").slice(-200));
    check("Claude Desktop servers moved under the extension (no duplicate mycel entry)", Object.keys(JSON.parse(rd(desktop)).mcpServers).length === 0);
    check("Claude Code now starts Mycel", Object.keys(JSON.parse(rd(join(sb.home, ".claude.json"))).mcpServers).join() === "mycel");
  } finally {
    rmSync(sb.home, { recursive: true, force: true });
  }
}

await terminalPath(process.argv.includes("--copy-real"));
await extensionPath();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
