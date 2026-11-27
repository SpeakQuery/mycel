import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { candidatePaths, isMycelItself, toMycelYaml, type FoundConfig } from "./importer.js";

type Servers = Record<string, Record<string, unknown>>;

export interface SetupIO {
  out: (s: string) => void;
  /** Ask a yes/no question. Only called when `interactive` is true. */
  ask: (q: string) => Promise<boolean>;
  interactive: boolean;
}

export interface SetupOptions {
  yes?: boolean;
  /** Where to write the Mycel config. Default: ~/.mycel/mycel.yaml */
  config?: string;
  /** Also rewrite project-level files (./.mcp.json, ./.cursor/mcp.json, ./.vscode/mcp.json). */
  projects?: boolean;
  cwd?: string;
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
export function mycelEntry(configPath: string): { command: string; args: string[] } {
  return onPath("mycel")
    ? { command: "mycel", args: ["serve", "--config", configPath] }
    : { command: "npx", args: ["-y", "@speakquery/mycel", "serve", "--config", configPath] };
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
    if (c.client.endsWith("(project)") && !opts.projects) {
      skipped.push({ client: c.client, path: c.path, reason: "project file shared with your team; left alone (add --projects to include it)" });
      continue;
    }
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
    plans.push({ client: c.client, path: c.path, key: c.key, raw, json, servers, others, hasMycel: others.length < names.length, projectEntries });
  }
  return { plans, skipped };
}

function indentOf(raw: string): string | number {
  const m = raw.match(/^([ \t]+)"/m);
  return m ? (m[1].includes("\t") ? "\t" : m[1].length) : 2;
}

function rewrite(p: Plan, entry: { command: string; args: string[] }): string {
  const j = JSON.parse(p.raw) as Record<string, unknown>;
  j[p.key] = { mycel: entry };
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
  files: Array<{ client: string; path: string; backup: string; sha256Before: string; sha256After: string; viaClaudeCli?: boolean }>;
}

const backupsDir = () => join(mycelHome(), "backups");

function claudeCliRewrite(p: Plan, entry: { command: string; args: string[] }): boolean {
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
      execFileSync(cli, ["mcp", "add", "-s", "user", "mycel", "--", entry.command, ...entry.args], { stdio: "ignore", timeout: 30000 });
    }
    return true;
  } catch {
    return false;
  }
}

export async function runSetup(o: SetupOptions, io: SetupIO): Promise<number> {
  const { out } = io;
  const cwd = o.cwd ?? process.cwd();
  const target = resolve(o.config ?? join(mycelHome(), "mycel.yaml"));
  const { plans, skipped } = scan({ ...o, cwd });
  out("\n  mycel setup\n");
  if (!plans.length && !skipped.length) {
    out("  No MCP client configs with servers were found (looked for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI).");
    out("  Nothing changed. Add servers to your client first, or write ~/.mycel/mycel.yaml by hand (see mycel init).\n");
    return 0;
  }
  const todo = plans.filter((p) => p.others.length);
  const entry = mycelEntry(target);

  const found: FoundConfig[] = todo.map((p) => ({ client: p.client, path: p.path, servers: Object.fromEntries(p.others.map((n) => [n, p.servers[n]])) }));
  const gen = toMycelYaml(found);

  // Merge into an existing config rather than replacing it.
  const yamlExists = existsSync(target);
  let yamlNext = gen.yaml;
  let added = gen.servers;
  const notes: string[] = [];
  if (yamlExists) {
    const doc = YAML.parseDocument(readFileSync(target, "utf8"));
    const have = new Set(Object.keys((doc.toJS()?.servers ?? {}) as object));
    const fresh = (YAML.parse(gen.yaml).servers ?? {}) as Servers;
    added = 0;
    for (const [n, s] of Object.entries(fresh)) {
      if (have.has(n)) {
        notes.push(`"${n}" already exists in ${short(target)}; kept the existing definition`);
        continue;
      }
      doc.setIn(["servers", n], s);
      added++;
    }
    yamlNext = String(doc);
  }

  out("  Found:");
  for (const p of plans) out(`    ${p.client.padEnd(24)} ${String(p.others.length).padStart(2)} server${p.others.length === 1 ? " " : "s"}  ${short(p.path)}`);
  for (const s of skipped) out(`    ${s.client.padEnd(24)} skipped: ${s.path === "" ? "" : short(s.path)} ${s.reason}`);
  out("\n  What will change:");
  out(`    ${yamlExists ? (added ? `add ${added} server(s) to existing ${short(target)} (existing entries untouched)` : `${short(target)} already has these servers; unchanged`) : `create ${short(target)} with ${added} server(s)`}`);
  for (const n of notes) out(`      note: ${n}`);
  for (const p of plans) out(`    ${short(p.path)}: ${describe(p)}`);
  out(`    clients will start Mycel with: ${entry.command} ${entry.args.join(" ")}`);
  if (gen.secrets.length) out(`\n  Secrets were replaced with {{secret:NAME}} placeholders. Set these environment variables before starting your client:\n    ${gen.secrets.join(", ")}`);
  if (gen.skipped.length) out(`  Skipped: ${gen.skipped.join("; ")}`);
  out(`  Backups of every changed file go to ${short(backupsDir())} (undo any time with: mycel undo)`);

  if (!todo.length) {
    out("\n  Everything already points at Mycel. Nothing to do.\n");
    return 0;
  }
  if (!o.yes) {
    if (!io.interactive) {
      out("\n  Dry run: nothing was changed (no terminal to ask in). Run again with --yes to apply:\n    npx -y @speakquery/mycel setup --yes\n");
      return 0;
    }
    if (!(await io.ask("\n  Apply these changes? [y/N] "))) {
      out("  Cancelled. Nothing changed.\n");
      return 0;
    }
  }

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
  if (yamlExists && added) manifest.config.backup = save(target, "config");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (!yamlExists || added) {
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
    } else writeAtomic(p.path, rewrite(p, entry));
    f.sha256After = sha(readFileSync(p.path));
    out(`  ${"✓"} ${f.client}: ${short(p.path)}`);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const clients = [...new Set(todo.map((p) => p.client.replace(/ \(project\)$/, "")))];
  out(`\n  Done. Restart ${clients.join(", ")}. See your savings anytime: mycel stats  ·  Undo: mycel undo\n`);
  return 0;
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
  for (const f of m.files) await doRestore(f.client, f.path, f.backup, f.sha256After);
  if (m.config.backup) await doRestore("Mycel config", m.config.path, m.config.backup, m.config.sha256After);
  else if (m.config.createdBySetup) kept.push(`Mycel config ${short(m.config.path)} was created by setup; kept (delete it yourself if unwanted)`);
  for (const r of restored) out(`  ✓ restored ${r}`);
  for (const k of kept) out(`  - ${k}`);
  out(`\n  Restored ${restored.length} file(s). Restart your clients.\n`);
  return 0;
}
