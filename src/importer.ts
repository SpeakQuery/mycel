import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

export interface FoundConfig {
  client: string;
  path: string;
  servers: Record<string, Record<string, unknown>>;
}

/** Known MCP client config locations (macOS, Linux, Windows). */
export function candidatePaths(cwd = process.cwd()): Array<{ client: string; path: string; key: string }> {
  const h = homedir();
  const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
  const mac = platform() === "darwin";
  const win = platform() === "win32";
  const claudeDesktop = mac
    ? join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : win
      ? join(appData, "Claude", "claude_desktop_config.json")
      : join(h, ".config", "Claude", "claude_desktop_config.json");
  const vscodeUser = mac ? join(h, "Library", "Application Support", "Code", "User", "mcp.json") : win ? join(appData, "Code", "User", "mcp.json") : join(h, ".config", "Code", "User", "mcp.json");
  return [
    { client: "Claude Desktop", path: claudeDesktop, key: "mcpServers" },
    { client: "Claude Code", path: join(h, ".claude.json"), key: "mcpServers" },
    { client: "Claude Code (project)", path: join(cwd, ".mcp.json"), key: "mcpServers" },
    { client: "Cursor", path: join(h, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "Cursor (project)", path: join(cwd, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "VS Code", path: vscodeUser, key: "servers" },
    { client: "VS Code (project)", path: join(cwd, ".vscode", "mcp.json"), key: "servers" },
    { client: "Windsurf", path: join(h, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
    { client: "Gemini CLI", path: join(h, ".gemini", "settings.json"), key: "mcpServers" },
  ];
}

export function discover(cwd?: string): FoundConfig[] {
  const out: FoundConfig[] = [];
  for (const c of candidatePaths(cwd)) {
    if (!existsSync(c.path)) continue;
    try {
      const j = JSON.parse(readFileSync(c.path, "utf8")) as Record<string, unknown>;
      let servers = (j[c.key] ?? {}) as Record<string, Record<string, unknown>>;
      // Claude Code also keeps per-project servers under projects.<path>.mcpServers
      if (c.client === "Claude Code" && j.projects && typeof j.projects === "object") {
        for (const p of Object.values(j.projects as Record<string, { mcpServers?: Record<string, Record<string, unknown>> }>)) {
          servers = { ...servers, ...(p.mcpServers ?? {}) };
        }
      }
      if (Object.keys(servers).length) out.push({ client: c.client, path: c.path, servers });
    } catch {
      /* unreadable config, skip */
    }
  }
  return out;
}

/**
 * Is this client entry Mycel itself? Only true when the command is the mycel binary,
 * or the args name the Mycel package/bin together with `serve`. A path or server name that merely
 * contains "mycel" (a repo folder called mycel-tools, a server named mycel-notes) is not Mycel.
 */
export function isMycelItself(command: unknown, args: unknown): string | null {
  if (typeof command !== "string") return null;
  const base = (x: string) => x.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (/^mycel(\.cmd|\.exe)?$/.test(base(command))) return `command is the mycel binary`;
  const a = Array.isArray(args) ? args.map(String) : [];
  if (!a.includes("serve")) return null;
  const hit = a.find((x) => {
    const n = x.replace(/\\/g, "/");
    return /^(@speakquery\/)?mycel(@[^/]*)?$/i.test(n) || /^@speakquery\/mycel(@[^/]*)?$/i.test(n) || /(^|\/)mycel\/dist\/cli\.js$/i.test(n) || /^mycel(\.cmd|\.exe)?$/i.test(base(n));
  });
  return hit ? `args run ${hit} serve` : null;
}

const SECRETISH = /(key|token|secret|password|pass|auth|credential|bearer)/i;

/**
 * Convert discovered client configs into a mycel.yaml. Secret-looking env values
 * are replaced with {{secret:NAME}} placeholders so they never sit in the file.
 */
export function toMycelYaml(found: FoundConfig[]): { yaml: string; servers: number; secrets: string[]; skipped: string[] } {
  const servers: Record<string, Record<string, unknown>> = {};
  const secrets = new Set<string>();
  const skipped: string[] = [];
  for (const f of found) {
    for (const [rawName, s] of Object.entries(f.servers)) {
      const name = rawName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
      const self = isMycelItself(s.command, s.args);
      if (self) {
        skipped.push(`${rawName} (that's Mycel itself: ${self})`);
        continue;
      }
      if (servers[name]) continue;
      if (typeof s.command === "string") {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries((s.env ?? {}) as Record<string, string>)) {
          if (SECRETISH.test(k)) {
            env[k] = `{{secret:${k}}}`;
            secrets.add(k);
          } else env[k] = String(v);
        }
        servers[name] = { command: s.command, args: s.args ?? [], ...(Object.keys(env).length ? { env } : {}) };
      } else if (typeof s.url === "string" || typeof s.serverUrl === "string") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((s.headers ?? {}) as Record<string, string>)) {
          if (SECRETISH.test(k)) {
            const n = `${name.toUpperCase().replace(/-/g, "_")}_${k.toUpperCase().replace(/-/g, "_")}`;
            headers[k] = String(v).replace(/^(Bearer\s+)?.+$/, (_m, b) => `${b ?? ""}{{secret:${n}}}`);
            secrets.add(n);
          } else headers[k] = String(v);
        }
        servers[name] = { url: s.url ?? s.serverUrl, ...(Object.keys(headers).length ? { headers } : {}), trust: "untrusted" };
      } else skipped.push(rawName);
    }
  }
  const doc = {
    servers,
    router: { mode: "auto" },
    policy: [
      { match: { effect: "destructive" }, action: "approve", reason: "Destructive actions need a human." },
      { match: { tainted: true, effect: "external" }, action: "approve", reason: "Untrusted content is trying to send something out." },
    ],
    budget: { perTaskUsd: 5, perDayUsd: 50 },
    refs: { inlineLimitBytes: 8000 },
  };
  const header = `# Mycel config — generated by \`mycel init\` from: ${found.map((f) => f.client).join(", ") || "nothing found"}\n# Docs: https://github.com/SpeakQuery/mycel#configuration\n`;
  return { yaml: header + YAML.stringify(doc), servers: Object.keys(servers).length, secrets: [...secrets], skipped };
}

/** Snippet the user pastes into their client so it talks to Mycel only. */
export function clientSnippet(configPath: string) {
  return { mcpServers: { mycel: { command: "mycel", args: ["serve", "--config", configPath] } } };
}
