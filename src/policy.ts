import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PolicyRule, PolicyAction, Effect } from "./config.js";
import type { ToolEntry } from "./catalog.js";
import { EFFECT_RANK } from "./contracts.js";
import type { CapabilityClaims } from "./tokens.js";

export interface Decision {
  action: PolicyAction;
  reason: string;
  rule?: number;
}

export interface CallContext {
  tool: ToolEntry;
  /** True when any input to this call derives from untrusted content. */
  tainted: boolean;
  taintSources: string[];
  /** Capability token claims when the caller is a delegated agent. */
  capability?: CapabilityClaims;
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * Policy Firewall. Rules are evaluated top to bottom; first match wins.
 * Built-in safety defaults apply after user rules:
 *   1. destructive or external actions whose inputs are tainted → approve
 *   2. destructive actions → approve
 * A capability token can only narrow what is allowed.
 */
export class PolicyEngine {
  constructor(
    private rules: PolicyRule[],
    private defaults = { approveDestructive: true, approveTaintedSideEffects: true },
  ) {}

  decide(ctx: CallContext): Decision {
    const { tool } = ctx;
    if (ctx.capability) {
      const c = ctx.capability;
      if (c.tools && !c.tools.some((g) => globToRegExp(g).test(tool.id))) return { action: "deny", reason: `capability token does not grant ${tool.id}` };
      if (c.maxEffect && EFFECT_RANK[tool.contract.effect] > EFFECT_RANK[c.maxEffect as Effect]) {
        return { action: "deny", reason: `capability token limits effects to ≤ ${c.maxEffect}; ${tool.id} is ${tool.contract.effect}` };
      }
    }
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      const m = r.match;
      if (m.tool && !globToRegExp(m.tool).test(tool.id)) continue;
      if (m.server && !globToRegExp(m.server).test(tool.server)) continue;
      if (m.effect && m.effect !== tool.contract.effect) continue;
      if (m.tainted !== undefined && m.tainted !== ctx.tainted) continue;
      return { action: r.action, reason: r.reason ?? `policy rule #${i + 1}`, rule: i };
    }
    const sideEffect = tool.contract.effect === "destructive" || tool.contract.effect === "external";
    if (this.defaults.approveTaintedSideEffects && ctx.tainted && sideEffect) {
      return { action: "approve", reason: `inputs derive from untrusted content (${ctx.taintSources.join(", ")}) and ${tool.id} is ${tool.contract.effect}` };
    }
    if (this.defaults.approveDestructive && tool.contract.effect === "destructive") {
      return { action: "approve", reason: `${tool.id} is destructive` };
    }
    return { action: "allow", reason: "default allow" };
  }
}

// ------------------------------------------------------------------ approvals
export interface Approval {
  id: string;
  tool: string;
  args: unknown;
  reason: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  decidedBy?: string;
}

/**
 * Pending approvals. Clients that support MCP elicitation get an inline prompt;
 * otherwise the model receives an approval id and a human approves with
 * `mycel approve <id>` or the dashboard. Approvals are bound to the exact args.
 */
export class ApprovalQueue {
  private items = new Map<string, Approval>();
  private waiters = new Map<string, Array<(a: Approval) => void>>();

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      for (const a of JSON.parse(readFileSync(file, "utf8")) as Approval[]) this.items.set(a.id, a);
    }
  }

  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.items.values()].slice(-500), null, 2));
  }

  /** Re-read from disk so approvals given by another process (CLI) are seen. */
  reload() {
    if (this.file && existsSync(this.file)) {
      for (const a of JSON.parse(readFileSync(this.file, "utf8")) as Approval[]) {
        const prev = this.items.get(a.id);
        this.items.set(a.id, a);
        if (prev?.status === "pending" && a.status !== "pending") this.notify(a);
      }
    }
  }

  request(tool: string, args: unknown, reason: string): Approval {
    const key = JSON.stringify([tool, args]);
    for (const a of this.items.values()) {
      if (a.status === "pending" && JSON.stringify([a.tool, a.args]) === key) return a;
    }
    const a: Approval = { id: `apv_${randomUUID().slice(0, 8)}`, tool, args, reason, createdAt: new Date().toISOString(), status: "pending" };
    this.items.set(a.id, a);
    this.persist();
    return a;
  }

  /** Consume an approval for exactly this tool + args (one-shot). */
  consume(id: string, tool: string, args: unknown): boolean {
    this.reload();
    const a = this.items.get(id);
    if (!a || a.status !== "approved" || a.tool !== tool || JSON.stringify(a.args) !== JSON.stringify(args)) return false;
    a.status = "expired";
    this.persist();
    return true;
  }

  decide(id: string, approved: boolean, by = "cli"): Approval {
    this.reload();
    const a = this.items.get(id);
    if (!a) throw new Error(`No approval ${id}`);
    if (a.status !== "pending") throw new Error(`Approval ${id} is already ${a.status}`);
    a.status = approved ? "approved" : "denied";
    a.decidedAt = new Date().toISOString();
    a.decidedBy = by;
    this.persist();
    this.notify(a);
    return a;
  }

  get(id: string) {
    this.reload();
    return this.items.get(id);
  }

  pending(): Approval[] {
    this.reload();
    return [...this.items.values()].filter((a) => a.status === "pending");
  }

  wait(id: string, timeoutMs: number): Promise<Approval | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.items.get(id)), timeoutMs);
      const list = this.waiters.get(id) ?? [];
      list.push((a) => {
        clearTimeout(t);
        resolve(a);
      });
      this.waiters.set(id, list);
    });
  }

  private notify(a: Approval) {
    for (const w of this.waiters.get(a.id) ?? []) w(a);
    this.waiters.delete(a.id);
  }
}

// ------------------------------------------------------------------ pinning
export interface Lock {
  version: 1;
  tools: Record<string, string>; // id → definition hash
}

export interface DriftReport {
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * Manifest pinning (rug-pull protection). The first time a tool is seen its
 * definition hash is written to mycel.lock. If a server later changes a tool's
 * description or schema, the tool is blocked (or warned) until re-approved
 * with `mycel pin --accept`.
 */
export class ManifestLock {
  lock: Lock;
  constructor(private file: string) {
    this.lock = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, tools: {} };
  }

  check(tools: ToolEntry[], servers?: string[]): DriftReport {
    const report: DriftReport = { added: [], changed: [], removed: [] };
    const seen = new Set<string>();
    for (const t of tools) {
      seen.add(t.id);
      const prev = this.lock.tools[t.id];
      if (!prev) report.added.push(t.id);
      else if (prev !== t.hash) report.changed.push(t.id);
    }
    const scope = servers ? new Set(servers) : null;
    for (const id of Object.keys(this.lock.tools)) {
      const server = id.split(".")[0];
      if (!seen.has(id) && (!scope || scope.has(server))) report.removed.push(id);
    }
    return report;
  }

  /** Pin new tools automatically (trust on first use); keep changed ones unpinned. */
  pinNew(tools: ToolEntry[]) {
    let dirty = false;
    for (const t of tools) {
      if (!this.lock.tools[t.id]) {
        this.lock.tools[t.id] = t.hash;
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  accept(tools: ToolEntry[], ids?: string[]) {
    for (const t of tools) if (!ids || ids.includes(t.id)) this.lock.tools[t.id] = t.hash;
    this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.lock.tools).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.file, JSON.stringify({ version: 1, tools: sorted }, null, 2) + "\n");
  }
}
