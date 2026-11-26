import { createHash } from "node:crypto";
import type { Contract, ToolAnnotations } from "./contracts.js";
import type { Trust } from "./config.js";

export interface ToolEntry {
  /** Fully-qualified id: `<server>.<tool>` */
  id: string;
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  contract: Contract;
  trust: Trust;
  /** sha256 of the definition the model would see — used for manifest pinning. */
  hash: string;
}

export function hashDefinition(t: { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }): string {
  const canonical = JSON.stringify(sortKeys({ n: t.name, d: t.description ?? "", i: t.inputSchema ?? {}, o: t.outputSchema ?? null }));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Rough token estimate (≈4 chars per token for JSON/English). Used for savings accounting. */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(s.length / 4);
}

/** The definition an MCP client would put in the model's context for this tool. */
export function wireDefinition(t: ToolEntry) {
  return { name: t.id, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) };
}

const STOP = new Set("a an the of to for and or in on with by from is are be this that it as at your you".split(" "));

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Tiny suffix stemmer — good enough to match "issues" with "issue", "labelled" with "label". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && /(ing|ed)$/.test(w)) return w.replace(/(ing|ed)$/, "").replace(/(.)\1$/, "$1");
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const SYNONYMS: Record<string, string[]> = {
  remove: ["delete"], delete: ["remove"], find: ["search", "list"], search: ["find", "query", "list"], list: ["search", "find"], my: ["search"],
  ticket: ["issue"], issue: ["ticket", "bug"], bug: ["issue"], mail: ["email"], email: ["mail", "message"],
  film: ["video"], movie: ["video"], clip: ["video"], picture: ["image"], photo: ["image"], img: ["image"],
  db: ["database", "sql"], sql: ["database", "query"], file: ["document"], doc: ["document"],
  pr: ["pull", "request"], repo: ["repository"], message: ["chat", "send"], calendar: ["event", "meeting"],
  remember: ["create", "add", "store", "memory"], save: ["create", "write", "store"], store: ["create", "save"], note: ["create", "observation"],
  history: ["log"], changes: ["diff"], uncommitted: ["unstaged", "diff"], screenshot: ["screenshot", "capture"], open: ["navigate"], go: ["navigate"], visit: ["navigate"],
  shell: ["process", "command", "terminal", "execute"], terminal: ["process", "command", "shell"], command: ["process", "execute"], execute: ["run", "process", "start"], run: ["execute", "start"], web: ["internet", "online", "search"], edit: ["replace", "modify", "update"],
};

/**
 * BM25 index over tool names, descriptions and parameter names.
 * No embeddings, no network: fast, deterministic and good at short queries.
 */
export class Catalog {
  private tools = new Map<string, ToolEntry>();
  private docs = new Map<string, Map<string, number>>();
  private lengths = new Map<string, number>();
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(entries: ToolEntry[] = []) {
    this.replaceAll(entries);
  }

  replaceAll(entries: ToolEntry[]) {
    this.tools.clear();
    for (const e of entries) this.tools.set(e.id, e);
    this.reindex();
  }

  upsertServer(server: string, entries: ToolEntry[]) {
    for (const [id, t] of this.tools) if (t.server === server) this.tools.delete(id);
    for (const e of entries) this.tools.set(e.id, e);
    this.reindex();
  }

  get size() {
    return this.tools.size;
  }

  all(): ToolEntry[] {
    return [...this.tools.values()];
  }

  get(id: string): ToolEntry | undefined {
    return this.tools.get(id) ?? this.resolveLoose(id);
  }

  /** Accept `tool` without server prefix when unambiguous, and `server/tool` or `server__tool`. */
  private resolveLoose(id: string): ToolEntry | undefined {
    const norm = id.replace("__", ".").replace("/", ".");
    if (this.tools.has(norm)) return this.tools.get(norm);
    const matches = this.all().filter((t) => t.name === id);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private reindex() {
    this.docs.clear();
    this.lengths.clear();
    this.df.clear();
    let total = 0;
    for (const t of this.tools.values()) {
      const props = Object.keys(((t.inputSchema as { properties?: object }).properties ?? {}) as object);
      // Name tokens are weighted 3x, server 2x, description and params 1x.
      const terms = [
        ...tokenize(t.name), ...tokenize(t.name), ...tokenize(t.name),
        ...tokenize(t.server), ...tokenize(t.server),
        ...tokenize(t.description),
        ...props.flatMap(tokenize),
      ];
      const tf = new Map<string, number>();
      for (const w of terms) tf.set(w, (tf.get(w) ?? 0) + 1);
      this.docs.set(t.id, tf);
      this.lengths.set(t.id, terms.length);
      total += terms.length;
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    }
    this.avgLen = this.tools.size ? total / this.tools.size : 0;
  }

  search(query: string, opts: { limit?: number; server?: string; effect?: string } = {}): Array<{ tool: ToolEntry; score: number }> {
    const limit = opts.limit ?? 8;
    const base = tokenize(query);
    const q = new Map<string, number>();
    for (const w of base) {
      q.set(w, (q.get(w) ?? 0) + 1);
      for (const s of SYNONYMS[w] ?? []) for (const t of tokenize(s)) if (!q.has(t)) q.set(t, 0.5);
    }
    const N = this.tools.size;
    const k1 = 1.2;
    const b = 0.75;
    const results: Array<{ tool: ToolEntry; score: number }> = [];
    for (const [id, tf] of this.docs) {
      const tool = this.tools.get(id)!;
      if (opts.server && tool.server !== opts.server) continue;
      if (opts.effect && tool.contract.effect !== opts.effect) continue;
      let score = 0;
      const len = this.lengths.get(id)!;
      for (const [w, weight] of q) {
        const f = tf.get(w);
        if (!f) continue;
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / (this.avgLen || 1))));
      }
      if (score > 0) results.push({ tool, score });
    }
    const listServer = () => this.all().filter((t) => t.server === opts.server && (!opts.effect || t.contract.effect === opts.effect)).slice(0, limit).map((tool) => ({ tool, score: 0 }));
    if (!base.length) return opts.server ? listServer() : this.all().slice(0, limit).map((tool) => ({ tool, score: 0 }));
    if (!results.length && opts.server) return listServer();
    return results.sort((a, b2) => b2.score - a.score).slice(0, limit);
  }

  /** One-line-per-server overview the model sees instead of every schema. */
  overview(): Array<{ server: string; tools: number; sample: string[]; effects: Record<string, number> }> {
    const by = new Map<string, ToolEntry[]>();
    for (const t of this.tools.values()) by.set(t.server, [...(by.get(t.server) ?? []), t]);
    return [...by.entries()].map(([server, ts]) => ({
      server,
      tools: ts.length,
      sample: ts.slice(0, 6).map((t) => t.name),
      effects: ts.reduce<Record<string, number>>((acc, t) => ((acc[t.contract.effect] = (acc[t.contract.effect] ?? 0) + 1), acc), {}),
    }));
  }
}
