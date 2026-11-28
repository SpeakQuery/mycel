import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { candidatePaths, isMycelItself, toMycelYaml, type FoundConfig } from "./importer.js";
import { loadConfig, isStdio } from "./config.js";
import { Mycel } from "./core.js";
import { signIn } from "./login.js";
import { keychainGet, keychainKind, keychainNames, keychainSet } from "./keychain.js";

type Servers = Record<string, Record<string, unknown>>;

export interface SetupIO {
  out: (s: string) => void;
  /** Ask a yes/no question; an empty answer returns `def`. Only called when `interactive` is true. */
  ask: (q: string, def?: boolean) => Promise<boolean>;
  /** Read a value without echoing it (API keys). Returns "" when skipped. Only called when `interactive` is true. */
  secret?: (q: string) => Promise<string>;
  interactive: boolean;
}

export interface SetupOptions {
  yes?: boolean;
  /** Where to write the Mycel config. Default: ~/.mycel/mycel.yaml */
  config?: string;
  /** Also rewrite project-level files (./.mcp.json, ./.cursor/mcp.json, ./.vscode/mcp.json) without asking. */
  projects?: boolean;
  cwd?: string;
  /** After applying: test every server through Mycel, offer browser sign-ins and app restarts. The CLI turns this on. */
  check?: boolean;
  /** Environment used to detect the app setup runs inside (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Running inside the Mycel Claude Desktop extension: Claude Desktop gets no "mycel" entry (the extension is Mycel). */
  viaExtension?: boolean;
  /** Open the browser for sign-ins without asking (the user already approved applying). */
  autoSignIn?: boolean;
}

interface Plan {
  client: string;
  path: string;
  key: string;
  raw: string;
  json: Record<string, unknown>;
  servers: Servers; // everything found in this file (top-level + Claude Code per-project)
  others: string[]; // names that are not Mycel itself
  hasMycel: boolean;
  projectEntries: string[]; // Claude Code projects.<p> keys that hold servers
  project: boolean; // a project-level file shared with a team
}
interface Skipped {
  client: string;
  path: string;
  reason: string;
}

export function mycelHome(): string {
  return process.env.MYCEL_HOME ? resolve(process.env.MYCEL_HOME) : join(homedir(), ".mycel");
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const short = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);

/** `npx` puts the package's bin on PATH only while it runs; that copy is gone afterwards, so never count it. */
function onPath(bin: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d || /[\\/]_npx[\\/]/.test(d)) continue;
    for (const e of exts) {
      const p = join(d, bin + e);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** The entry clients get: the `mycel` binary when installed, otherwise via npx. */
export function mycelEntry(configPath: string): { command: string; args: string[]; env?: Record<string, string> } {
  // The install script runs setup from a private copy (~/.mycel/app) with an absolute Node path.
  if (process.env.MYCEL_ENTRY_ABSOLUTE === "1" && process.argv[1]) return { command: process.execPath, args: [resolve(process.argv[1]), "serve", "--config", configPath] };
  // Apps started from the Dock or Start menu (Claude Desktop, Cursor) get a short PATH without Homebrew, nvm or
  // npm's folders, so `mycel` / `npx` and the `node` their first line asks for are not found. Write the absolute
  // command and a PATH with the folder that has node.
  const win = process.platform === "win32";
  const mycel = onPath("mycel");
  const npx = mycel ? null : onPath("npx");
  const nodeDir = !win && (mycel || npx) ? onPath("node") : null;
  const env = nodeDir ? { env: { PATH: [dirname(nodeDir), "/usr/bin", "/bin"].join(":") } } : {};
  return mycel
    ? { command: win ? "mycel" : mycel, args: ["serve", "--config", configPath], ...env }
    : { command: npx && !win ? npx : "npx", args: ["-y", "@speakquery/mycel@latest", "serve", "--config", configPath], ...env };
}

function stripJsonc(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += s[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function scan(opts: SetupOptions): { plans: Plan[]; skipped: Skipped[] } {
  const plans: Plan[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const c of candidatePaths(opts.cwd)) {
    if (!existsSync(c.path) || seen.has(c.path)) continue;
    seen.add(c.path);
    const raw = readFileSync(c.path, "utf8");
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw);
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    } catch {
      let why = "is not valid JSON";
      try {
        JSON.parse(stripJsonc(raw));
        why = "contains comments (JSONC); not rewritten so your comments are not lost. Replace its servers by hand with the command shown under \"clients will start Mycel with\"";
      } catch {
        /* keep generic */
      }
      skipped.push({ client: c.client, path: c.path, reason: why });
      continue;
    }
    const servers: Servers = { ...((json[c.key] as Servers | undefined) ?? {}) };
    const projectEntries: string[] = [];
    if (c.client === "Claude Code" && json.projects && typeof json.projects === "object") {
      for (const [pk, p] of Object.entries(json.projects as Record<string, { mcpServers?: Servers }>)) {
        if (p?.mcpServers && Object.keys(p.mcpServers).length) {
          projectEntries.push(pk);
          for (const [n, s] of Object.entries(p.mcpServers)) if (!servers[n]) servers[n] = s;
        }
      }
    }
    if (!Object.keys(servers).length) continue;
    const names = Object.keys(servers);
    const others = names.filter((n) => !isMycelItself(servers[n].command, servers[n].args));
    plans.push({ client: c.client, path: c.path, key: c.key, raw, json, servers, others, hasMycel: others.length < names.length, projectEntries, project: c.client.endsWith("(project)") });
  }
  return { plans, skipped };
}

function indentOf(raw: string): string | number {
  const m = raw.match(/^([ \t]+)"/m);
  return m ? (m[1].includes("\t") ? "\t" : m[1].length) : 2;
}

function rewrite(p: Plan, entry: { command: string; args: string[] } | null): string {
  const j = JSON.parse(p.raw) as Record<string, unknown>;
  j[p.key] = entry ? { mycel: entry } : {};
  if (p.client === "Claude Code" && j.projects && typeof j.projects === "object") {
    for (const k of p.projectEntries) {
      const proj = (j.projects as Record<string, Record<string, unknown>>)[k];
      proj.mcpServers = {};
    }
  }
  return JSON.stringify(j, null, indentOf(p.raw)) + (p.raw.endsWith("\n") ? "\n" : "");
}

function describe(p: Plan): string {
  const n = p.others.length;
  const proj = p.projectEntries.length ? ` and empty ${p.projectEntries.length} per-project server list(s)` : "";
  if (!n) return `already points at Mycel; nothing to change`;
  return `replace ${n} server${n === 1 ? "" : "s"} in "${p.key}" with one "mycel" entry${proj}`;
}

function writeAtomic(path: string, data: string) {
  const tmp = `${path}.mycel-tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export interface Manifest {
  id: string;
  createdAt: string;
  config: { path: string; createdBySetup: boolean; backup?: string; sha256After?: string };
  /** The secrets file setup moved API keys into (read only by you). */
  secrets?: { path: string; createdBySetup: boolean; backup?: string; sha256After?: string };
  files: Array<{ client: string; path: string; backup: string; sha256Before: string; sha256After: string; viaClaudeCli?: boolean; createdBySetup?: boolean }>;
}

const backupsDir = () => join(mycelHome(), "backups");

function claudeCliRewrite(p: Plan, entry: { command: string; args: string[]; env?: Record<string, string> }): boolean {
  // Only user-scope servers of ~/.claude.json go through the CLI. Failure falls back to JSON editing.
  const cli = onPath("claude");
  if (!cli || p.client !== "Claude Code" || process.env.MYCEL_NO_CLAUDE_CLI) return false;
  try {
    const top = Object.keys((p.json[p.key] as Servers | undefined) ?? {}).filter((n) => !isMycelItself(p.servers[n].command, p.servers[n].args));
    for (const n of top) execFileSync(cli, ["mcp", "remove", "-s", "user", n], { stdio: "ignore", timeout: 30000 });
    if (!p.hasMycel || top.length) {
      try {
        execFileSync(cli, ["mcp", "remove", "-s", "user", "mycel"], { stdio: "ignore", timeout: 30000 });
      } catch {
        /* none to remove */
      }
      const envArgs = Object.entries(entry.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      execFileSync(cli, ["mcp", "add", "-s", "user", ...envArgs, "mycel", "--", entry.command, ...entry.args], { stdio: "ignore", timeout: 30000 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Claude Desktop's folder: macOS Application Support, Windows %APPDATA%, Linux ~/.config. */
function claudeDesktopDir(): string {
  const h = homedir();
  const p = osPlatform();
  return p === "darwin" ? join(h, "Library", "Application Support", "Claude") : p === "win32" ? join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), "Claude") : join(h, ".config", "Claude");
}

export interface DesktopExtension {
  id: string;
  name: string;
  server: Record<string, unknown>;
  settingsPath: string;
}

/**
 * Claude Desktop extensions (one-click .mcpb/.dxt installs) live outside claude_desktop_config.json:
 * `Claude Extensions/<id>/manifest.json` plus `Claude Extensions Settings/<id>.json` ({ isEnabled, userConfig }).
 * Enabled ones are imported; setup then turns them off in Claude Desktop (Mycel runs them instead).
 */
export function findDesktopExtensions(dir = claudeDesktopDir()): { found: DesktopExtension[]; skipped: string[] } {
  const found: DesktopExtension[] = [];
  const skipped: string[] = [];
  const extDir = join(dir, "Claude Extensions");
  const setDir = join(dir, "Claude Extensions Settings");
  if (!existsSync(extDir)) return { found, skipped };
  for (const id of readdirSync(extDir)) {
    const mf = join(extDir, id, "manifest.json");
    const settingsPath = join(setDir, `${id}.json`);
    if (!existsSync(mf) || !existsSync(settingsPath)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8")) as { name?: string; display_name?: string; server?: { type?: string; mcp_config?: { command?: string; args?: string[]; env?: Record<string, string> } } };
      const st = JSON.parse(readFileSync(settingsPath, "utf8")) as { isEnabled?: boolean; userConfig?: Record<string, unknown> };
      if (st.isEnabled === false) continue;
      if ((m.name ?? "").toLowerCase() === "mycel") continue; // the Mycel extension itself
      const mc = m.server?.mcp_config;
      const label = m.display_name ?? m.name ?? id;
      if (!mc?.command) {
        skipped.push(`${label} (no command in its manifest)`);
        continue;
      }
      if (m.server?.type === "node" && mc.command === "node" && !onPath("node")) {
        skipped.push(`${label} (needs Node.js on PATH; Claude Desktop uses its own copy)`);
        continue;
      }
      const uc = st.userConfig ?? {};
      const h = homedir();
      const vars: Record<string, string> = { __dirname: join(extDir, id), HOME: h, DOCUMENTS: join(h, "Documents"), DESKTOP: join(h, "Desktop"), DOWNLOADS: join(h, "Downloads"), pathSeparator: delimiter === ";" ? "\\" : "/", "/": delimiter === ";" ? "\\" : "/" };
      const sub = (v: string): string =>
        v.replace(/\$\{([^}]+)\}/g, (all, k: string) => {
          if (k.startsWith("user_config.")) {
            const u = uc[k.slice("user_config.".length)];
            return u === undefined || u === null ? "" : Array.isArray(u) ? u.join(" ") : String(u);
          }
          return vars[k] ?? all;
        });
      const args: string[] = [];
      for (const a of mc.args ?? []) {
        const whole = /^\$\{user_config\.([^}]+)\}$/.exec(a);
        const u = whole ? uc[whole[1]] : undefined;
        if (Array.isArray(u)) args.push(...u.map(String));
        else args.push(sub(a));
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(mc.env ?? {})) env[k] = sub(String(v));
      found.push({ id, name: label, server: { command: sub(mc.command), args, ...(Object.keys(env).length ? { env } : {}) }, settingsPath });
    } catch {
      skipped.push(`${id} (unreadable manifest or settings)`);
    }
  }
  return { found, skipped };
}

/** MCP servers that Claude Code plugins bring. Plugins manage them, so setup reports them and leaves them alone. */
export function pluginServers(home = homedir()): string[] {
  const reg = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(reg)) return [];
  const names = new Set<string>();
  try {
    const j = JSON.parse(readFileSync(reg, "utf8")) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const installs of Object.values(j.plugins ?? {})) {
      for (const i of installs ?? []) {
        if (!i.installPath) continue;
        for (const f of [join(i.installPath, ".mcp.json"), join(i.installPath, ".claude-plugin", "plugin.json")]) {
          if (!existsSync(f)) continue;
          try {
            const pj = JSON.parse(readFileSync(f, "utf8")) as { mcpServers?: Record<string, unknown> };
            for (const n of Object.keys(pj.mcpServers ?? {})) names.add(n);
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return [...names];
}

/** Parse a dotenv-style secrets file (same rules as the Secret Vault). */
function readSecretsFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Where API keys go: the config's existing secrets file, or secrets.env next to the config. */
function secretsPathFor(target: string, yamlText: string | null): string {
  if (yamlText) {
    const s = (YAML.parse(yamlText)?.secrets ?? {}) as { source?: string; file?: string };
    if ((s.source === "file" || s.source === "keychain") && s.file) return isAbsolute(s.file) ? s.file : resolve(dirname(target), s.file);
  }
  return join(dirname(target), "secrets.env");
}

export async function runSetup(o: SetupOptions, io: SetupIO): Promise<number> {
  const { out } = io;
  const cwd = o.cwd ?? process.cwd();
  const target = resolve(o.config ?? join(mycelHome(), "mycel.yaml"));
  const { plans: all, skipped } = scan({ ...o, cwd });
  const exts = findDesktopExtensions();
  const plugins = pluginServers();
  out("\n  mycel setup\n");
  if (!all.length && !skipped.length && !exts.found.length) {
    out("  No MCP client configs with servers were found (looked for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI).");
    out("  Nothing changed. Add servers to your client first, or write ~/.mycel/mycel.yaml by hand (see mycel init).\n");
    return 0;
  }

  // Project files are shared with a team: include them only with --projects or a yes for each one.
  const plans: Plan[] = [];
  for (const p of all) {
    if (!p.project || !p.others.length || o.projects) {
      plans.push(p);
      continue;
    }
    if (io.interactive && !o.yes && (await io.ask(`  ${p.client} file ${short(p.path)} (${p.others.length} server(s)) is shared with your team. Include it too? [y/N] `, false))) plans.push(p);
    else skipped.push({ client: p.client, path: p.path, reason: "project file shared with your team; left alone (add --projects to include it)" });
  }
  if (!plans.length && !exts.found.length) {
    for (const sk of skipped) out(`    ${sk.client.padEnd(24)} skipped: ${short(sk.path)} ${sk.reason}`);
    out("\n  Nothing to do.\n");
    return 0;
  }
  const todo = plans.filter((p) => p.others.length);
  const entry = mycelEntry(target);

  const yamlExists = existsSync(target);
  const yamlText = yamlExists ? readFileSync(target, "utf8") : null;
  const secretsPath = secretsPathFor(target, yamlText);
  const fileSecrets = readSecretsFile(secretsPath);
  // Keys go to the system keychain when there is one (macOS Keychain, Linux Secret Service), unless this config
  // already uses a secrets file. Anything the keychain refuses falls back to the private file.
  const existingSource = yamlText ? ((YAML.parse(yamlText)?.secrets ?? {}) as { source?: string }).source : undefined;
  const kc = existingSource === "file" ? null : keychainKind();
  const kcStored: Record<string, string> = {};
  if (kc) for (const n of keychainNames()) {
    const v = keychainGet(n);
    if (v !== undefined) kcStored[n] = v;
  }
  const storedSecrets = { ...kcStored, ...fileSecrets };
  const storeLabel = kc === "macos" ? "the macOS Keychain" : kc === "secret-service" ? "your system keyring" : short(secretsPath);
  const found: FoundConfig[] = todo.map((p) => ({ client: p.client, path: p.path, servers: Object.fromEntries(p.others.map((n) => [n, p.servers[n]])) }));
  // Extensions run through Mycel only if Claude Desktop has a "mycel" entry: add one when its config has none to rewrite.
  const desktopPath = join(claudeDesktopDir(), "claude_desktop_config.json");
  const desktopPlan = plans.find((p) => p.client === "Claude Desktop");
  if (exts.found.length && !desktopPlan && existsSync(desktopPath)) {
    let readable = true;
    try {
      const j = JSON.parse(readFileSync(desktopPath, "utf8"));
      readable = !!j && typeof j === "object" && !Array.isArray(j);
    } catch {
      readable = false;
    }
    if (!readable) {
      // Never overwrite a config we cannot parse (comments, broken JSON): leave the extensions on in Claude Desktop.
      for (const e of exts.found.splice(0)) exts.skipped.push(`${e.name} (${short(desktopPath)} could not be read as plain JSON, so Claude Desktop keeps running it)`);
    }
  }
  if (exts.found.length) found.push({ client: "Claude Desktop extensions", path: join(claudeDesktopDir(), "Claude Extensions"), servers: Object.fromEntries(exts.found.map((e) => [e.name, e.server])) });
  const desktopAdd = exts.found.length > 0 && !desktopPlan && !o.viaExtension;
  const gen = toMycelYaml(found, storedSecrets);
  const newSecrets = Object.entries(gen.secretValues).filter(([k]) => storedSecrets[k] === undefined);
  const missingSecrets = gen.secrets.filter((k) => gen.secretValues[k] === undefined && storedSecrets[k] === undefined && process.env[k] === undefined);

  // Merge into an existing config rather than replacing it.
  const doc = YAML.parseDocument(yamlText ?? gen.yaml);
  let added = gen.servers;
  const notes: string[] = [];
  if (yamlExists) {
    const have = new Set(Object.keys((doc.toJS()?.servers ?? {}) as object));
    const fresh = (YAML.parse(gen.yaml).servers ?? {}) as Servers;
    added = 0;
    for (const [n, sv] of Object.entries(fresh)) {
      if (have.has(n)) {
        notes.push(`"${n}" already exists in ${short(target)}; kept the existing definition`);
        continue;
      }
      doc.setIn(["servers", n], sv);
      added++;
    }
  }
  const sec = (doc.toJS()?.secrets ?? {}) as { source?: string };
  const wantSource = kc ? "keychain" : "file";
  const pointSecrets = gen.secrets.length > 0 && sec.source !== "file" && sec.source !== "keychain";
  if (pointSecrets) {
    doc.setIn(["secrets", "source"], wantSource);
    doc.setIn(["secrets", "file"], secretsPath);
  }
  let yamlChanges = !yamlExists || added > 0 || pointSecrets;

  out("  Found:");
  for (const p of plans) out(`    ${p.client.padEnd(24)} ${String(p.others.length).padStart(2)} server${p.others.length === 1 ? " " : "s"}  ${short(p.path)}`);
  for (const sk of skipped) out(`    ${sk.client.padEnd(24)} skipped: ${sk.path === "" ? "" : short(sk.path)} ${sk.reason}`);
  out("\n  What will change:");
  out(`    ${yamlExists ? (added ? `add ${added} server(s) to existing ${short(target)} (existing entries untouched)` : `${short(target)} already has these servers; unchanged`) : `create ${short(target)} with ${added} server(s)`}`);
  for (const n of notes) out(`      note: ${n}`);
  for (const p of plans) out(`    ${short(p.path)}: ${describe(p)}`);
  if (exts.found.length) out(`    Claude Desktop extensions: run ${exts.found.map((e) => e.name).join(", ")} through Mycel and turn them off in Claude Desktop${desktopAdd ? ` (adds a "mycel" entry to ${short(desktopPath)})` : ""}`);
  for (const x of exts.skipped) out(`      extension left as is: ${x}`);
  if (plugins.length) out(`    Claude Code plugins bring ${plugins.length} server(s) of their own (${plugins.slice(0, 6).join(", ")}${plugins.length > 6 ? ", …" : ""}); plugins manage them, so they stay as they are`);
  out(`    clients will start Mycel with: ${entry.command} ${entry.args.join(" ")}`);
  if (newSecrets.length) out(`    move ${newSecrets.length} API key(s) out of client configs into ${storeLabel} (only you can read them; you don't need to set anything)`);
  if (missingSecrets.length)     out(`    ${missingSecrets.length} API key(s) have no value yet (${missingSecrets.join(", ")}); you can paste them in a moment`);
  if (gen.skipped.length) out(`  Skipped: ${gen.skipped.join("; ")}`);
  out(`  Backups of every changed file go to ${short(backupsDir())} (undo any time with: mycel undo)`);

  if (!todo.length && !exts.found.length) {
    out("\n  Everything already points at Mycel. Nothing to do.\n");
    return 0;
  }
  if (!o.yes) {
    if (!io.interactive) {
      out("\n  Dry run: nothing was changed (no terminal to ask in). Run again with --yes to apply:\n    npx -y @speakquery/mycel setup --yes\n");
      return 0;
    }
    if (!(await io.ask("\n  Apply these changes? [Y/n] ", true))) {
      out("  Cancelled. Nothing changed.\n");
      return 0;
    }
  }

  // Missing API keys: ask for each one (hidden input) instead of telling the user to edit a file.
  if (missingSecrets.length && io.interactive && io.secret && !o.yes) {
    for (const k of missingSecrets) {
      const v = (await io.secret(`  ${k}: paste the value (hidden; Enter to skip): `)).trim();
      if (v) newSecrets.push([k, v]);
      else out(`    skipped; add later as a line ${k}=… in ${short(secretsPath)}`);
    }
  }
  // Show savings to the user: on unless they say no (or already decided in the config).
  const ui = (doc.toJS()?.ui ?? {}) as { savingsLine?: boolean };
  if (ui.savingsLine === undefined) {
    const wantLine = o.yes || !io.interactive ? true : await io.ask("  Show what Mycel saves (tokens, %, ≈ $ and time) at the end of each answer? [Y/n] ", true);
    doc.setIn(["ui", "savingsLine"], wantLine);
    yamlChanges = true;
  }
  if (newSecrets.length && !pointSecrets && !["file", "keychain"].includes(doc.toJS()?.secrets?.source ?? "env")) {
    doc.setIn(["secrets", "source"], wantSource);
    doc.setIn(["secrets", "file"], secretsPath);
  }
  const yamlNext = String(doc);

  // Apply: back up first, then write.
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupsDir(), id);
  mkdirSync(join(dir, "files"), { recursive: true });
  const manifest: Manifest = { id, createdAt: new Date().toISOString(), config: { path: target, createdBySetup: !yamlExists }, files: [] };
  const save = (file: string, tag: string) => {
    const dest = join("files", `${tag}-${basename(file)}`);
    copyFileSync(file, join(dir, dest));
    return dest;
  };
  let i = 0;
  for (const p of todo) manifest.files.push({ client: p.client, path: p.path, backup: save(p.path, String(++i)), sha256Before: sha(readFileSync(p.path)), sha256After: "" });
  if (yamlExists && yamlChanges) manifest.config.backup = save(target, "config");
  const inKeychain = kc ? newSecrets.filter(([k, v]) => keychainSet(k, v)).map(([k]) => k) : [];
  const toFile = newSecrets.filter(([k]) => !inKeychain.includes(k));
  const secretsExisted = existsSync(secretsPath);
  if (toFile.length) manifest.secrets = { path: secretsPath, createdBySetup: !secretsExisted, ...(secretsExisted ? { backup: save(secretsPath, "secrets") } : {}) };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (toFile.length) {
    mkdirSync(dirname(secretsPath), { recursive: true });
    const prev = secretsExisted ? readFileSync(secretsPath, "utf8") : "# Mycel secrets: API keys moved here by `mycel setup`. Keep this file private.\n";
    const body = (prev === "" || prev.endsWith("\n") ? prev : prev + "\n") + toFile.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    writeAtomic(secretsPath, body);
    try {
      chmodSync(secretsPath, 0o600);
    } catch {
      /* not supported (Windows): the file stays in your user folder */
    }
    manifest.secrets!.sha256After = sha(readFileSync(secretsPath));
  }
  if (yamlChanges) {
    mkdirSync(dirname(target), { recursive: true });
    writeAtomic(target, yamlNext);
  }
  manifest.config.sha256After = sha(readFileSync(target));
  for (const f of manifest.files) {
    const p = todo.find((x) => x.path === f.path)!;
    if (claudeCliRewrite(p, entry)) {
      f.viaClaudeCli = true;
      // The CLI handled user scope; per-project lists are edited as JSON.
      if (p.projectEntries.length) {
        const j = JSON.parse(readFileSync(p.path, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
        for (const k of p.projectEntries) if (j.projects?.[k]) j.projects[k].mcpServers = {};
        writeAtomic(p.path, JSON.stringify(j, null, indentOf(p.raw)) + (p.raw.endsWith("\n") ? "\n" : ""));
      }
    } else writeAtomic(p.path, rewrite(p, o.viaExtension && p.client === "Claude Desktop" ? null : entry));
    f.sha256After = sha(readFileSync(p.path));
    out(`  ${"✓"} ${f.client}: ${short(p.path)}`);
  }
  if (desktopAdd) {
    const existed = existsSync(desktopPath);
    let j: Record<string, unknown> = {};
    if (existed) {
      try {
        j = JSON.parse(readFileSync(desktopPath, "utf8"));
      } catch {
        j = {};
      }
    }
    const before = existed ? sha(readFileSync(desktopPath)) : "";
    const backup = existed ? save(desktopPath, "desktop") : "";
    j.mcpServers = { ...((j.mcpServers as Servers | undefined) ?? {}), mycel: entry };
    mkdirSync(dirname(desktopPath), { recursive: true });
    writeAtomic(desktopPath, JSON.stringify(j, null, 2) + "\n");
    manifest.files.push({ client: "Claude Desktop", path: desktopPath, backup, sha256Before: before, sha256After: sha(readFileSync(desktopPath)), ...(existed ? {} : { createdBySetup: true }) });
    out(`  ✓ Claude Desktop: ${short(desktopPath)}`);
  }
  for (const e of exts.found) {
    const raw = readFileSync(e.settingsPath, "utf8");
    const backup = save(e.settingsPath, `ext-${e.id}`);
    const j = JSON.parse(raw) as Record<string, unknown>;
    j.isEnabled = false;
    writeAtomic(e.settingsPath, JSON.stringify(j, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
    manifest.files.push({ client: `Claude Desktop extension ${e.name}`, path: e.settingsPath, backup, sha256Before: sha(raw), sha256After: sha(readFileSync(e.settingsPath)) });
    out(`  ✓ extension ${e.name}: now runs through Mycel`);
  }
  if (inKeychain.length) out(`  ✓ ${inKeychain.length} API key(s): ${storeLabel}`);
  if (toFile.length) out(`  ✓ ${toFile.length} API key(s): ${short(secretsPath)}`);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const clients = [...new Set([...todo.map((p) => p.client.replace(/ \(project\)$/, "")), ...(exts.found.length ? ["Claude Desktop"] : [])])];

  if (!o.check) {
    out(`\n  Done. Restart ${clients.join(", ")}. See your savings anytime: mycel stats  ·  Undo: mycel undo\n`);
    return 0;
  }
  const r = await checkAndSignIn(target, io, o);
  await restartClients(clients, io, o);
  const pct = r.directTokens > 0 ? Math.round((1 - r.mycelTokens / r.directTokens) * 100) : 0;
  out("\n  ─────────────────────────────────────────────");
  out(`  Mycel is set up: ${r.ready} of ${r.total} server(s) working, ${r.tools} tools.`);
  if (r.directTokens > 0) out(`  Tool definitions: ≈${r.directTokens.toLocaleString("en-US")} → ≈${r.mycelTokens.toLocaleString("en-US")} tokens (−${pct}%, estimated; applies when an app sends every tool definition each turn).`);
  out("  Your savings show up at the end of answers, and any time with: mycel stats");
  if (r.failed.length) out(`  Not working yet: ${r.failed.join(", ")}. Check later with: mycel doctor`);
  out("  Changed your mind? mycel undo\n");
  return 0;
}

const NEEDS_SIGN_IN = /unauthori[sz]ed|\b401\b|mycel login|invalid_token|oauth/i;

/** Wizard step: start every server through Mycel, offer a browser sign-in where one is needed. Returns servers still failing. */
interface CheckResult {
  failed: string[];
  ready: number;
  total: number;
  tools: number;
  directTokens: number;
  mycelTokens: number;
}

async function checkAndSignIn(target: string, io: SetupIO, o: SetupOptions): Promise<CheckResult> {
  const { out } = io;
  out("\n  Checking each server through Mycel…");
  let loaded;
  try {
    loaded = loadConfig(target);
  } catch (e) {
    out(`  ✗ the Mycel config could not be read: ${(e as Error).message}`);
    return { failed: ["(config)"], ready: 0, total: 0, tools: 0, directTokens: 0, mycelTokens: 0 };
  }
  const m = await new Mycel(loaded, { log: () => {} }).start();
  const results = [...m.upstreams.values()].map((u) => ({ name: u.name, ok: u.status === "ready", tools: u.tools.length, error: u.error ?? "" }));
  const fp = m.contextFootprint();
  await m.close();
  let signedInTools = 0;
  const failed: string[] = [];
  for (const r of results) {
    const cfg = loaded.config.servers[r.name];
    if (r.ok) {
      out(`  ✓ ${r.name}: ${r.tools} tools`);
      continue;
    }
    if (cfg && !isStdio(cfg) && NEEDS_SIGN_IN.test(r.error)) {
      if (!io.interactive && !o.autoSignIn) {
        out(`  ! ${r.name}: needs a one-time sign-in. Run: mycel login ${r.name}`);
        failed.push(r.name);
        continue;
      }
      if (!o.yes && !o.autoSignIn && !(await io.ask(`  ${r.name} needs a one-time sign-in. Open your browser now? [Y/n] `, true))) {
        out(`    later: mycel login ${r.name}`);
        failed.push(r.name);
        continue;
      }
      const s = await signIn(loaded, r.name, out);
      if (s.ok) {
        out(`  ✓ ${r.name}: signed in, ${s.tools} tools`);
        signedInTools += s.tools;
      }
      else {
        out(`  ✗ ${r.name}: sign-in did not finish (${s.reason}). Try again later: mycel login ${r.name}`);
        failed.push(r.name);
      }
      continue;
    }
    const hint = /secret "([^"]+)" is not available/i.exec(r.error);
    out(`  ✗ ${r.name}: ${r.error.split("\n")[0].slice(0, 160)}${hint ? `  — add ${hint[1]}=… to the secrets file` : ""}`);
    failed.push(r.name);
  }
  const ok = results.filter((x) => x.ok);
  return {
    failed,
    ready: results.length - failed.length,
    total: results.length,
    tools: ok.reduce((n, x) => n + x.tools, 0) + signedInTools,
    directTokens: fp.directTokens,
    mycelTokens: fp.mycelTokens,
  };
}

/** Desktop apps setup can restart for the user (macOS). Bundle ids detect when setup runs inside that app. */
const APPS: Record<string, { app: string; bundle: RegExp }> = {
  "Claude Desktop": { app: "Claude", bundle: /^com\.anthropic\.claude/i },
  Cursor: { app: "Cursor", bundle: /cursor/i },
  Windsurf: { app: "Windsurf", bundle: /windsurf|codeium/i },
  "VS Code": { app: "Visual Studio Code", bundle: /^com\.microsoft\.VSCode/i },
};

/** Which clients setup may restart itself, and which the user restarts (and how). Pure, for tests. */
export function restartPlan(clients: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { auto: Array<{ client: string; app: string }>; manual: string[] } {
  const auto: Array<{ client: string; app: string }> = [];
  const manual: string[] = [];
  const host = env.__CFBundleIdentifier ?? "";
  for (const c of clients) {
    const a = APPS[c];
    if (c === "Claude Code") manual.push("Claude Code: start a new session (or type /mcp) to load Mycel");
    else if (c === "Gemini CLI") manual.push("Gemini CLI: start it again");
    else if (!a) manual.push(`${c}: restart it`);
    else if (platform !== "darwin") manual.push(`${c}: quit and reopen it`);
    else if (a.bundle.test(host)) manual.push(`${c}: setup is running inside it, so quit and reopen it when this finishes`);
    else auto.push({ client: c, app: a.app });
  }
  return { auto, manual };
}

function appRunning(app: string): boolean {
  try {
    return execFileSync("osascript", ["-e", `application "${app}" is running`], { encoding: "utf8", timeout: 10000 }).trim() === "true";
  } catch {
    return false;
  }
}

/** Wizard step: restart the desktop apps that were rewired, one yes each. */
async function restartClients(clients: string[], io: SetupIO, o: SetupOptions): Promise<void> {
  const { out } = io;
  const plan = restartPlan(clients, process.platform, o.env ?? process.env);
  const manual = [...plan.manual];
  for (const { client, app } of plan.auto) {
    if (!appRunning(app)) {
      out(`  ✓ ${client} is closed; it will load Mycel when you open it`);
      continue;
    }
    if (!io.interactive || o.yes || !(await io.ask(`  Restart ${client} now so it loads Mycel? Open chats are kept. [Y/n] `, true))) {
      manual.push(`${client}: quit and reopen it`);
      continue;
    }
    try {
      execFileSync("osascript", ["-e", `quit app "${app}"`], { stdio: "ignore", timeout: 20000 });
      for (let t = 0; t < 40 && appRunning(app); t++) await new Promise((r) => setTimeout(r, 500));
      execFileSync("open", ["-a", app], { stdio: "ignore", timeout: 20000 });
      out(`  ✓ ${client} restarted`);
    } catch {
      manual.push(`${client}: quit and reopen it (automatic restart did not work)`);
    }
  }
  if (manual.length) out(`\n  To finish:\n${manual.map((m) => `    • ${m}`).join("\n")}`);
}

export function listBackups(): Manifest[] {
  const d = backupsDir();
  if (!existsSync(d)) return [];
  const res: Manifest[] = [];
  for (const id of readdirSync(d).sort()) {
    try {
      res.push(JSON.parse(readFileSync(join(d, id, "manifest.json"), "utf8")) as Manifest);
    } catch {
      /* incomplete backup */
    }
  }
  return res;
}

function summarizeDiff(a: string, b: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  const sa = new Set(la);
  const sb = new Set(lb);
  const removed = la.filter((l) => !sb.has(l)).length;
  const addedL = lb.filter((l) => !sa.has(l)).length;
  return `${addedL} line(s) added, ${removed} line(s) removed since setup`;
}

export async function runUndo(o: { yes?: boolean; list?: boolean; id?: string }, io: SetupIO): Promise<number> {
  const { out } = io;
  const all = listBackups();
  if (o.list) {
    if (!all.length) out("No setup backups.");
    for (const m of all) out(`${m.id}  ${m.files.length} file(s): ${m.files.map((f) => f.client).join(", ")}`);
    return 0;
  }
  const m = o.id ? all.find((x) => x.id === o.id) : all[all.length - 1];
  if (!m) {
    out(o.id ? `No backup with id ${o.id}. See: mycel undo --list` : "Nothing to undo: no setup backups found.");
    return o.id ? 1 : 0;
  }
  const dir = join(backupsDir(), m.id);
  out(`\n  mycel undo  (backup ${m.id})\n`);
  const restored: string[] = [];
  const kept: string[] = [];
  const doRestore = async (label: string, path: string, backup: string | undefined, after: string | undefined) => {
    if (!backup) return;
    const src = join(dir, backup);
    if (!existsSync(src)) {
      kept.push(`${label}: backup file is missing, left as is`);
      return;
    }
    if (existsSync(path) && after && sha(readFileSync(path)) !== after) {
      out(`  ${label} (${short(path)}) changed since setup: ${summarizeDiff(readFileSync(src, "utf8"), readFileSync(path, "utf8"))}.`);
      if (!o.yes) {
        const go = io.interactive && (await io.ask("  Overwrite it with the backup? [y/N] "));
        if (!go) {
          kept.push(`${label}: kept your newer version (use --yes to force)`);
          return;
        }
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(src, path);
    restored.push(`${label}: ${short(path)}`);
  };
  for (const f of m.files) {
    if (f.createdBySetup) {
      // Setup created this file; emptying its server list keeps any other settings the app wrote since.
      try {
        const j = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>;
        delete (j.mcpServers as Record<string, unknown> | undefined)?.mycel;
        writeFileSync(f.path, JSON.stringify(j, null, 2) + "\n");
        restored.push(`${f.client}: removed the "mycel" entry setup added to ${short(f.path)}`);
      } catch {
        kept.push(`${f.client}: ${short(f.path)} could not be read; left as is`);
      }
      continue;
    }
    await doRestore(f.client, f.path, f.backup, f.sha256After);
  }
  if (m.secrets?.backup) await doRestore("Secrets file", m.secrets.path, m.secrets.backup, m.secrets.sha256After);
  else if (m.secrets?.createdBySetup) kept.push(`Secrets file ${short(m.secrets.path)} was created by setup and holds your API keys; kept (your restored client configs have them again; delete it if you stop using Mycel)`);
  if (m.config.backup) await doRestore("Mycel config", m.config.path, m.config.backup, m.config.sha256After);
  else if (m.config.createdBySetup) kept.push(`Mycel config ${short(m.config.path)} was created by setup; kept (delete it yourself if unwanted)`);
  for (const r of restored) out(`  ✓ restored ${r}`);
  for (const k of kept) out(`  - ${k}`);
  out(`\n  Restored ${restored.length} file(s). Restart your clients.\n`);
  return 0;
}

/** Shell profile files the installer may have added a PATH line to. */
function profileFiles(): string[] {
  const h = homedir();
  return [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => join(h, f));
}

/**
 * `mycel uninstall`: undo every setup (newest first, so apps end with their original settings), remove the
 * installer's PATH line and keychain entries, then delete ~/.mycel. Asks first unless --yes.
 */
export async function runUninstall(o: { yes?: boolean; keepData?: boolean }, io: SetupIO, hooks: { removeKeychain?: () => number } = {}): Promise<number> {
  const { out } = io;
  const home = mycelHome();
  const backups = listBackups();
  const profiles = profileFiles().filter((f) => existsSync(f) && readFileSync(f, "utf8").includes(join(home, "bin")));
  out("\n  mycel uninstall\n");
  out(`    restore your apps from ${backups.length} setup backup(s)${backups.length ? "" : " (none found)"}`);
  if (profiles.length) out(`    remove the mycel PATH line from ${profiles.map(short).join(", ")}`);
  if (hooks.removeKeychain) out("    remove Mycel's API keys from the system keychain");
  if (!o.keepData) out(`    delete ${short(home)} (config, API keys, logs, backups, the private Node.js and Mycel copy)`);
  if (!o.yes) {
    if (!io.interactive) {
      out("\n  Dry run: nothing was changed. Run again with --yes to uninstall.\n");
      return 0;
    }
    if (!(await io.ask("\n  Uninstall Mycel? [y/N] ", false))) {
      out("  Cancelled. Nothing changed.\n");
      return 0;
    }
  }
  for (const b of [...backups].reverse()) await runUndo({ id: b.id, yes: true }, { ...io, out: () => {} });
  if (backups.length) out(`  ✓ apps restored to their settings from before Mycel`);
  for (const f of profiles) {
    const s = readFileSync(f, "utf8");
    const bin = join(home, "bin");
    const next = s
      .split("\n")
      .filter((l, i, a) => !(l.includes(bin) && l.includes("PATH")) && !(l.trim() === "# Mycel" && (a[i + 1] ?? "").includes(bin)))
      .join("\n");
    writeFileSync(f, next);
    out(`  ✓ ${short(f)}: PATH line removed`);
  }
  if (hooks.removeKeychain) out(`  ✓ ${hooks.removeKeychain()} key(s) removed from the keychain`);
  if (!o.keepData && existsSync(home)) {
    rmSync(home, { recursive: true, force: true });
    out(`  ✓ ${short(home)} deleted`);
  }
  out("\n  Mycel is uninstalled. Restart your apps. Thanks for trying it.\n");
  return 0;
}
