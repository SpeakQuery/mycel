#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Mycel } from "./core.js";
import { createMcpServer } from "./server.js";
import { startHttp } from "./http.js";
import { discover, toMycelYaml, clientSnippet } from "./importer.js";
import { runBench, formatBench } from "./bench.js";
import { mint, attenuate, inspect, newRootKey, parseDuration, type Caveat } from "./tokens.js";
import { ApprovalQueue } from "./policy.js";
import { Recorder } from "./recorder.js";
import { EFFECTS, isStdio, type Effect } from "./config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { oauthFor } from "./upstream.js";
import { DEFAULT_CALLBACK_PORT, openBrowser, waitForCallback } from "./oauth.js";

// Exit quietly when piped into something that closes early (e.g. `mycel traces | head -1`).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});
const err = (s: string): void => void process.stderr.write(s + "\n");
const out = (s: string): void => void process.stdout.write(s + "\n");
const c = {
  g: (s: string) => (process.stdout.isTTY ? `\x1b[38;5;48m${s}\x1b[0m` : s),
  y: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  d: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  b: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

async function boot(configPath?: string, log = err) {
  const loaded = loadConfig(configPath ? resolve(configPath) : undefined);
  if (!loaded.path) log(c.y("No mycel.yaml found — run `mycel init` to create one. Starting with no servers."));
  return new Mycel(loaded, { log }).start();
}

const program = new Command();
program
  .name("mycel")
  .description("The connective layer for AI agents — MCP gateway + A2A mesh.")
  .version("0.1.4")
  .option("-c, --config <path>", "path to mycel.yaml");

program
  .command("init")
  .description("Import MCP servers from Claude, Cursor, VS Code, Windsurf and Gemini CLI into mycel.yaml")
  .option("-o, --out <path>", "where to write the config", "mycel.yaml")
  .option("-f, --force", "overwrite an existing config")
  .action((o: { out: string; force?: boolean }) => {
    const found = discover();
    const target = resolve(o.out);
    out(c.b("\n  mycel init\n"));
    if (!found.length) out(c.d("  No MCP client configs found. Writing a starter config.\n"));
    for (const f of found) out(`  ${c.g("✓")} ${f.client.padEnd(22)} ${Object.keys(f.servers).length} servers  ${c.d(f.path)}`);
    const { yaml, servers, secrets, skipped } = toMycelYaml(found);
    if (existsSync(target) && !o.force) {
      out(c.y(`\n  ${o.out} already exists — not overwriting (use --force).`));
    } else {
      writeFileSync(target, yaml);
      out(`\n  ${c.g("→")} Imported ${c.b(String(servers))} servers into ${o.out}`);
    }
    if (skipped.length) out(c.d(`    skipped: ${skipped.join(", ")}`));
    if (secrets.length) out(`\n  ${c.y("!")} Secrets were replaced with {{secret:NAME}} placeholders. Set them in your environment:\n    ${secrets.map((s) => `export ${s}=…`).join("\n    ")}`);
    out(`\n  Point your client at Mycel (replace its mcpServers with):\n`);
    out(JSON.stringify(clientSnippet(target), null, 2).split("\n").map((l) => "    " + l).join("\n"));
    out(`\n  Then: ${c.g("mycel doctor")} · ${c.g("mycel bench")} · ${c.g("mycel dashboard")}\n`);
  });

program
  .command("serve")
  .description("Run the gateway (stdio by default; --http for Streamable HTTP + A2A)")
  .option("--http", "serve MCP over HTTP at /mcp and A2A at /a2a")
  .option("-p, --port <n>", "HTTP port", (v) => Number(v))
  .option("--host <host>", "HTTP bind address")
  .option("--no-dashboard", "do not start the local dashboard (stdio mode)")
  .action(async (o: { http?: boolean; port?: number; host?: string; dashboard: boolean }) => {
    const m = await boot(program.opts().config);
    const shutdown = async () => {
      await m.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    const port = o.port ?? m.config.dashboard.port;
    const host = o.host ?? m.config.dashboard.host;
    if (o.http) {
      const h = await startHttp(m, { port, host, gateway: true, log: err });
      err(`Dashboard: ${h.url}/  (local only)`);
      return;
    }
    if (o.dashboard) {
      startHttp(m, { port, host, gateway: false }).then(
        (h) => err(`Mycel dashboard: ${h.url}/`),
        () => err(c.d(`(dashboard port ${port} busy — another Mycel is probably serving it)`)),
      );
    }
    const server = createMcpServer(m);
    await server.connect(new StdioServerTransport());
    const fp = m.contextFootprint();
    err(`Mycel ready: ${fp.tools} tools from ${m.upstreams.size} servers behind ${m.routerMode()} router (≈${fp.directTokens} → ${fp.mycelTokens} tokens of tool definitions).`);
  });

program
  .command("dashboard")
  .description("Open the local dashboard (traces, savings, jobs, approvals)")
  .option("-p, --port <n>", "port", (v) => Number(v))
  .action(async (o: { port?: number }) => {
    const m = await boot(program.opts().config);
    const h = await startHttp(m, { port: o.port ?? m.config.dashboard.port, host: m.config.dashboard.host, gateway: true, log: err });
    out(`\n  ${c.g("●")} Mycel dashboard → ${c.b(h.url + "/")}\n`);
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      execFileSync(opener, [h.url + "/"], { stdio: "ignore" });
    } catch {
      /* headless */
    }
  });

program
  .command("bench")
  .description("Measure context tokens and round trips: direct MCP vs Mycel")
  .option("--json", "print JSON")
  .action(async (o: { json?: boolean }) => {
    const r = await runBench();
    out(o.json ? JSON.stringify(r, null, 2) : "\n" + formatBench(r) + "\n");
  });

program
  .command("doctor")
  .description("Check your setup: Node, ffmpeg, config, server connections, pinning")
  .action(async () => {
    const ok = (b: boolean, s: string, hint = "") => out(`  ${b ? c.g("✓") : c.y("✗")} ${s}${!b && hint ? c.d(`  — ${hint}`) : ""}`);
    out(c.b("\n  mycel doctor\n"));
    ok(Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node}`, "Node 20+ required");
    let ff = false;
    try {
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      ff = true;
    } catch {
      /* missing */
    }
    ok(ff, "ffmpeg/ffprobe (video & audio digests)", "optional: brew install ffmpeg / apt install ffmpeg");
    const loaded = (() => {
      try {
        return loadConfig(program.opts().config ? resolve(program.opts().config) : undefined);
      } catch (e) {
        ok(false, "config is valid", (e as Error).message);
        process.exitCode = 1;
        return null;
      }
    })();
    if (!loaded) return;
    ok(!!loaded.path, `config ${loaded.path ?? "(none)"}`, "run mycel init");
    const m = await new Mycel(loaded, { log: () => {} }).start();
    for (const u of m.upstreams.values()) ok(u.status === "ready", `${u.name}: ${u.status === "ready" ? `${u.tools.length} tools` : u.error}`, /unauthori[sz]ed|\b401\b/i.test(u.error ?? "") && !/mycel login/.test(u.error ?? "") ? `run: mycel login ${u.name}` : "");
    const failed = [...m.upstreams.values()].filter((u) => u.status === "error");
    if (failed.length) {
      out(`\n  ${c.y("✗")} ${failed.length} upstream${failed.length > 1 ? "s" : ""} failed to start: ${failed.map((u) => u.name).join(", ")} — their tools are NOT available through Mycel.`);
      process.exitCode = 1;
    }
    ok(m.drift.changed.length === 0, `manifest pinning: ${m.drift.changed.length} changed, ${m.drift.added.length} new`, `review with mycel pin`);
    const fp = m.contextFootprint();
    out(`\n  Context: ${fp.tools} tools would cost ≈${fp.directTokens} tokens; through Mycel ≈${fp.mycelTokens}.\n`);
    await m.close();
  });

program
  .command("login <server>")
  .description("Sign in to a remote MCP server that uses OAuth (Canva, Notion, Linear, …)")
  .option("--no-browser", "print the sign-in link instead of opening a browser")
  .action(async (name: string, o: { browser: boolean }) => {
    const loaded = loadConfig(program.opts().config ? resolve(program.opts().config) : undefined);
    const cfg = loaded.config.servers[name];
    if (!cfg) throw new Error(`No server "${name}" in ${loaded.path ?? "config"}`);
    if (isStdio(cfg)) return out(`${name} is a local (stdio) server; it doesn't need a sign-in.`);
    const m = new Mycel(loaded, { log: () => {}, noConnect: true });
    const provider = oauthFor(name, cfg, m.vault, {
      home: loaded.home,
      onRedirect: (url) => {
        out(`\n  Sign in to ${c.b(name)} in your browser:\n  ${url.href}\n`);
        if (o.browser) openBrowser(url.href);
      },
    });
    if (!provider) return out(`OAuth is off for ${name} (oauth: false, or an Authorization header is set).`);
    const port = (cfg.oauth || undefined)?.callbackPort ?? DEFAULT_CALLBACK_PORT;
    const cb = waitForCallback(port, () => provider.expectedState());
    await cb.ready;
    const connect = async () => {
      const client = new Client({ name: `mycel:${name}`, version: "0.1.4" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: m.vault.inject(cfg.headers) }, authProvider: provider });
      await client.connect(transport);
      return { client, transport };
    };
    let conn: Awaited<ReturnType<typeof connect>>;
    try {
      conn = await connect();
      cb.close();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) {
        cb.close();
        throw e;
      }
      out(c.d("  Waiting for you to finish signing in…"));
      const code = await cb.code;
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: m.vault.inject(cfg.headers) }, authProvider: provider });
      await transport.finishAuth(code);
      conn = await connect();
    }
    const { tools } = await conn.client.listTools();
    out(`  ${c.g("✓")} ${name}: signed in, ${tools.length} tools available. Tokens refresh automatically.\n`);
    await conn.client.close();
  });

program
  .command("search <query...>")
  .description("Search the tool catalog")
  .action(async (q: string[]) => {
    const m = await boot(program.opts().config);
    for (const r of m.search(q.join(" "), { limit: 10 })) out(`${c.g(r.tool.padEnd(36))} ${c.d(r.effect.padEnd(11))} ${r.description.slice(0, 90)}`);
    await m.close();
  });

program
  .command("call <tool> [json]")
  .description("Call a tool through Mycel (same policy, refs and recording as agents)")
  .option("--approval <id>")
  .option("--dry-run")
  .action(async (tool: string, json: string | undefined, o: { approval?: string; dryRun?: boolean }) => {
    const m = await boot(program.opts().config);
    out(JSON.stringify(await m.call(tool, json ? JSON.parse(json) : {}, { approval: o.approval, dryRun: o.dryRun, agent: "cli" }), null, 2));
    await m.close();
  });

program
  .command("run <file>")
  .description("Run a code-mode script (file path, or - for stdin)")
  .action(async (file: string) => {
    const code = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
    const m = await boot(program.opts().config);
    const r = await m.run(code, { agent: "cli" });
    for (const l of r.logs) err(c.d(`│ ${l}`));
    out(JSON.stringify(r.ok ? r.result : { error: r.error }, null, 2));
    await m.close();
    process.exitCode = r.ok ? 0 : 1;
  });

const approvalsFile = () => join(loadConfig(program.opts().config ? resolve(program.opts().config) : undefined).home, "approvals.json");
program
  .command("approvals")
  .description("List pending approvals")
  .action(() => {
    const pending = new ApprovalQueue(approvalsFile()).pending();
    if (!pending.length) out(c.d("No pending approvals."));
    for (const a of pending) out(`${c.y(a.id)}  ${c.b(a.tool)}  ${c.d(a.reason)}\n    ${JSON.stringify(a.args).slice(0, 200)}`);
  });
program
  .command("approve <id>")
  .description("Approve a pending action")
  .action((id: string) => {
    const a = new ApprovalQueue(approvalsFile()).decide(id, true, "cli");
    out(`${c.g("✓ approved")} ${a.tool} — the agent can now retry with approval "${a.id}".`);
  });
program
  .command("deny <id>")
  .description("Deny a pending action")
  .action((id: string) => {
    const a = new ApprovalQueue(approvalsFile()).decide(id, false, "cli");
    out(`${c.y("✗ denied")} ${a.tool}`);
  });

program
  .command("pin")
  .description("Show tool-definition drift; --accept re-pins changed tools")
  .option("--accept [ids...]", "accept current definitions (all, or the given ids)")
  .action(async (o: { accept?: boolean | string[] }) => {
    const m = await boot(program.opts().config);
    const d = m.drift;
    if (o.accept) {
      m.lock.accept(m.catalog.all(), Array.isArray(o.accept) ? o.accept : undefined);
      out(c.g(`✓ pinned ${Array.isArray(o.accept) ? o.accept.length : m.catalog.size} tool definitions`));
    } else {
      out(`changed: ${d.changed.length ? c.y(d.changed.join(", ")) : "none"}\nadded:   ${d.added.length}\nremoved: ${d.removed.join(", ") || "none"}`);
    }
    await m.close();
  });

const token = program.command("token").description("Capability tokens for delegated agents");
token
  .command("secret")
  .description("Generate a root key (put it in MYCEL_TOKEN_SECRET or a2a.tokenSecret)")
  .action(() => out(newRootKey()));
const caveatOpts = (cmd: Command) =>
  cmd
    .option("--tools <globs>", "comma-separated tool globs, e.g. 'github.list_*,calendar.*'")
    .option("--max-effect <effect>", `one of ${EFFECTS.join(", ")}`)
    .option("--budget <usd>", "spend cap in USD", Number)
    .option("--ttl <duration>", "expiry, e.g. 30m, 2h, 1d")
    .option("--sub <name>", "who this is for (audit label)");
const toCaveat = (o: { tools?: string; maxEffect?: string; budget?: number; ttl?: string; sub?: string }): Caveat => {
  if (o.maxEffect && !EFFECTS.includes(o.maxEffect as Effect)) throw new Error(`--max-effect must be one of ${EFFECTS.join(", ")}`);
  return {
    ...(o.tools ? { tools: o.tools.split(",").map((s) => s.trim()) } : {}),
    ...(o.maxEffect ? { maxEffect: o.maxEffect as Effect } : {}),
    ...(o.budget !== undefined ? { budgetUsd: o.budget } : {}),
    ...(o.ttl ? { exp: Math.floor(Date.now() / 1000) + parseDuration(o.ttl) } : {}),
    ...(o.sub ? { sub: o.sub } : {}),
  };
};
caveatOpts(token.command("mint").description("Mint a new token (needs MYCEL_TOKEN_SECRET)")).action((o) => {
  const key = process.env.MYCEL_TOKEN_SECRET;
  if (!key) throw new Error("Set MYCEL_TOKEN_SECRET (generate one with `mycel token secret`).");
  out(mint(key, toCaveat(o)));
});
caveatOpts(token.command("attenuate <token>").description("Narrow a token — no secret needed, can only remove rights")).action((t: string, o) => out(attenuate(t, toCaveat(o))));
token
  .command("inspect <token>")
  .description("Show a token's caveats and effective rights")
  .action((t: string) => out(JSON.stringify(inspect(t), null, 2)));

program
  .command("replay <traceId>")
  .description("Print a recorded task step by step")
  .action((traceId: string) => {
    const loaded = loadConfig(program.opts().config ? resolve(program.opts().config) : undefined);
    const rec = new Recorder(join(loaded.home, "traces"), { enabled: false, redact: true });
    const events = rec.load({ traceId, days: 30 });
    if (!events.length) return out(c.y(`No events for trace ${traceId}. Recent traces: ${rec.traces(5).map((t) => t.traceId).join(", ")}`));
    const t0 = Date.parse(events[0].ts);
    for (const e of events) {
      const t = `+${((Date.parse(e.ts) - t0) / 1000).toFixed(2)}s`.padStart(9);
      out(`${c.d(t)} ${e.ok ? c.g("●") : c.y("●")} ${e.kind.padEnd(9)} ${(e.tool ?? "").padEnd(32)} ${e.durationMs !== undefined ? `${e.durationMs}ms` : ""} ${e.tokensSaved ? c.g(`-${e.tokensSaved} tok`) : ""} ${e.costUsd ? `$${e.costUsd}` : ""} ${e.decision && e.decision !== "allow" ? c.y(e.decision) : ""} ${e.error ? c.y(e.error) : ""}`);
    }
  });

program
  .command("traces")
  .description("List recent traces")
  .action(() => {
    const loaded = loadConfig(program.opts().config ? resolve(program.opts().config) : undefined);
    const rec = new Recorder(join(loaded.home, "traces"), { enabled: false, redact: true });
    for (const t of rec.traces(20)) out(`${c.g(t.traceId)}  ${t.start}  ${String(t.steps).padStart(3)} steps  ${t.errors ? c.y(`${t.errors} err`) : "      "}  saved ${t.tokensSaved} tok  ${t.title}`);
  });

program
  .command("refs")
  .description("List refs, or garbage-collect old ones")
  .option("--gc <age>", "delete refs older than e.g. 7d")
  .action(async (o: { gc?: string }) => {
    const loaded = loadConfig(program.opts().config ? resolve(program.opts().config) : undefined);
    const { RefStore, humanBytes } = await import("./refs.js");
    const store = new RefStore(loaded.config.refs.dir ?? join(loaded.home, "refs"));
    if (o.gc) return out(`removed ${store.gc(parseDuration(o.gc) * 1000)} refs`);
    for (const r of store.list(50)) out(`${c.g(r.id)}  ${r.mime.padEnd(24)} ${humanBytes(r.size).padStart(9)}  ${r.taint === "untrusted" ? c.y("untrusted") : "         "}  ${r.source?.server ?? ""}${r.source?.tool ? "." + r.source.tool : ""}`);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  err(c.y(`mycel: ${e.message}`));
  process.exit(1);
});
