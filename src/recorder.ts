import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EventSavings } from "./savings.js";

export type EventKind = "session" | "search" | "describe" | "call" | "run" | "ref" | "job" | "approval" | "policy" | "a2a" | "ask" | "drift";

export interface TraceEvent {
  ts: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: EventKind;
  tool?: string;
  server?: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  costUsd?: number;
  /** Tokens actually sent to the model for this step (estimate). */
  tokensToModel?: number;
  /** Tokens the model did NOT have to see thanks to refs / code mode / the router (estimate). */
  tokensSaved?: number;
  bytesOffloaded?: number;
  /** Measured result savings per call/run, and the estimated tool-definition savings per tools/list. See savings.ts. */
  savings?: EventSavings;
  decision?: string;
  tainted?: boolean;
  agent?: string;
  args?: unknown;
  result?: unknown;
  meta?: Record<string, unknown>;
}

export interface Stats {
  calls: number;
  errors: number;
  runs: number;
  searches: number;
  tokensSaved: number;
  tokensToModel: number;
  bytesOffloaded: number;
  costUsd: number;
  approvals: number;
  denied: number;
  /** Measured result savings (exact, chars/4). Only counted calls. */
  measured: { calls: number; savedTokens: number; addedTokens: number };
  /** Estimated tool-definition savings, once per tools/list served. */
  estimated: { toolsListServed: number; definitionTokens: number };
  byTool: Record<string, { calls: number; errors: number; totalMs: number; costUsd: number }>;
  since: string;
}

export const newId = (bytes = 8) => randomBytes(bytes).toString("hex");

/**
 * Flight Recorder: every step is appended to a JSONL file per day, streamed to
 * the dashboard, and optionally exported to an OpenTelemetry collector.
 */
export class Recorder extends EventEmitter {
  readonly dir: string;
  private stats: Stats;
  private otlpQueue: TraceEvent[] = [];
  private otlpTimer?: NodeJS.Timeout;

  constructor(
    dir: string,
    private opts: { enabled: boolean; otlpEndpoint?: string; redact: boolean; serviceName?: string } = { enabled: true, redact: true },
  ) {
    super();
    this.dir = dir;
    this.setMaxListeners(100);
    if (opts.enabled) mkdirSync(dir, { recursive: true });
    this.stats = emptyStats();
  }

  record(e: Omit<TraceEvent, "ts" | "spanId"> & { spanId?: string }): TraceEvent {
    const ev: TraceEvent = { ts: new Date().toISOString(), spanId: e.spanId ?? newId(), ...e };
    if (this.opts.redact) {
      ev.args = clip(ev.args);
      ev.result = clip(ev.result);
    }
    this.accumulate(this.stats, ev);
    if (this.opts.enabled) {
      appendFileSync(join(this.dir, `${ev.ts.slice(0, 10)}.jsonl`), JSON.stringify(ev) + "\n");
    }
    if (this.opts.otlpEndpoint) this.queueOtlp(ev);
    this.emit("event", ev);
    return ev;
  }

  liveStats(): Stats {
    return this.stats;
  }

  /** Load historical events (newest last). */
  load(opts: { days?: number; traceId?: string; limit?: number } = {}): TraceEvent[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .slice(-(opts.days ?? 7));
    const out: TraceEvent[] = [];
    for (const f of files) {
      for (const line of readFileSync(join(this.dir, f), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as TraceEvent;
          if (!opts.traceId || ev.traceId === opts.traceId) out.push(ev);
        } catch {
          /* skip corrupt line */
        }
      }
    }
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  historicalStats(days = 30): Stats {
    const s = emptyStats();
    const events = this.load({ days });
    if (events[0]) s.since = events[0].ts;
    for (const e of events) this.accumulate(s, e);
    return s;
  }

  /**
   * Savings totals for `mycel stats`: the most recent gateway session in the log, and everything recorded today (UTC).
   * Measured and estimated are kept apart; the estimate is per tools/list served, not per model turn.
   */
  savingsReport(now = new Date()): { session?: SavingsTotals & { id: string; start: string }; day: SavingsTotals & { date: string } } {
    const date = now.toISOString().slice(0, 10);
    const events = this.load({ days: 2 }).filter((e) => e.savings);
    const today = events.filter((e) => e.ts.slice(0, 10) === date);
    const lastId = events.length ? events[events.length - 1].savings!.session : undefined;
    const mine = lastId ? events.filter((e) => e.savings!.session === lastId) : [];
    return {
      session: lastId ? { id: lastId, start: mine[0].ts, ...sumSavings(mine) } : undefined,
      day: { date, ...sumSavings(today) },
    };
  }

  traces(limit = 50): Array<{ traceId: string; start: string; steps: number; errors: number; costUsd: number; tokensSaved: number; agent?: string; title: string }> {
    const by = new Map<string, TraceEvent[]>();
    for (const e of this.load({ days: 7 })) by.set(e.traceId, [...(by.get(e.traceId) ?? []), e]);
    return [...by.entries()]
      .map(([traceId, evs]) => ({
        traceId,
        start: evs[0].ts,
        steps: evs.length,
        errors: evs.filter((e) => !e.ok).length,
        costUsd: round(evs.reduce((a, e) => a + (e.costUsd ?? 0), 0)),
        tokensSaved: evs.reduce((a, e) => a + (e.tokensSaved ?? 0), 0),
        agent: evs.find((e) => e.agent)?.agent,
        title: evs.find((e) => e.tool)?.tool ?? evs[0].kind,
      }))
      .sort((a, b) => b.start.localeCompare(a.start))
      .slice(0, limit);
  }

  private accumulate(s: Stats, e: TraceEvent) {
    if (e.kind === "call") {
      s.calls++;
      if (e.tool) {
        const t = (s.byTool[e.tool] ??= { calls: 0, errors: 0, totalMs: 0, costUsd: 0 });
        t.calls++;
        if (!e.ok) t.errors++;
        t.totalMs += e.durationMs ?? 0;
        t.costUsd = round(t.costUsd + (e.costUsd ?? 0));
      }
    }
    if (e.kind === "run") s.runs++;
    if (e.kind === "search") s.searches++;
    if (!e.ok && e.kind !== "policy") s.errors++;
    if (e.kind === "approval") s.approvals++;
    if (e.kind === "policy" && e.decision === "deny") s.denied++;
    const sv = e.savings;
    if (sv?.measured && sv.counted !== false) {
      s.measured.calls++;
      s.measured.savedTokens += sv.measured.savedTokens;
      s.measured.addedTokens += sv.measured.addedTokens;
    }
    if (sv?.estimated) {
      s.estimated.toolsListServed++;
      s.estimated.definitionTokens += sv.estimated.perTurnTokens;
    }
    s.tokensSaved += e.tokensSaved ?? 0;
    s.tokensToModel += e.tokensToModel ?? 0;
    s.bytesOffloaded += e.bytesOffloaded ?? 0;
    s.costUsd = round(s.costUsd + (e.costUsd ?? 0));
  }

  // ------------------------------------------------------------- OpenTelemetry
  private queueOtlp(ev: TraceEvent) {
    this.otlpQueue.push(ev);
    if (!this.otlpTimer) {
      this.otlpTimer = setTimeout(() => void this.flushOtlp(), 2000);
      this.otlpTimer.unref?.();
    }
  }

  async flushOtlp() {
    this.otlpTimer = undefined;
    const batch = this.otlpQueue.splice(0);
    if (!batch.length || !this.opts.otlpEndpoint) return;
    const toNs = (iso: string, plusMs = 0) => String(BigInt(Date.parse(iso) + plusMs) * 1_000_000n);
    const attr = (k: string, v: unknown) =>
      v === undefined
        ? null
        : { key: k, value: typeof v === "number" ? { doubleValue: v } : typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v) } };
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [attr("service.name", this.opts.serviceName ?? "mycel")] },
          scopeSpans: [
            {
              scope: { name: "mycel", version: "0.1.5" },
              spans: batch.map((e) => ({
                traceId: e.traceId.padEnd(32, "0").slice(0, 32),
                spanId: e.spanId.padEnd(16, "0").slice(0, 16),
                parentSpanId: e.parentSpanId,
                name: `${e.kind}${e.tool ? ` ${e.tool}` : ""}`,
                kind: 3,
                startTimeUnixNano: toNs(e.ts, -(e.durationMs ?? 0)),
                endTimeUnixNano: toNs(e.ts),
                status: { code: e.ok ? 1 : 2, message: e.error },
                attributes: [
                  attr("mycel.kind", e.kind),
                  attr("mcp.tool", e.tool),
                  attr("mcp.server", e.server),
                  attr("mycel.cost_usd", e.costUsd),
                  attr("mycel.tokens_saved", e.tokensSaved),
                  attr("mycel.decision", e.decision),
                  attr("mycel.tainted", e.tainted),
                  attr("mycel.agent", e.agent),
                ].filter(Boolean),
              })),
            },
          ],
        },
      ],
    };
    try {
      const url = this.opts.otlpEndpoint.replace(/\/$/, "") + (this.opts.otlpEndpoint.endsWith("/v1/traces") ? "" : "/v1/traces");
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      /* exporter must never break the gateway */
    }
  }
}

export interface SavingsTotals {
  measured: { calls: number; savedTokens: number; addedTokens: number; netTokens: number };
  estimated: { toolsListServed: number; definitionTokens: number };
}

function sumSavings(events: TraceEvent[]): SavingsTotals {
  const t: SavingsTotals = { measured: { calls: 0, savedTokens: 0, addedTokens: 0, netTokens: 0 }, estimated: { toolsListServed: 0, definitionTokens: 0 } };
  for (const e of events) {
    const sv = e.savings;
    if (sv?.measured && sv.counted !== false) {
      t.measured.calls++;
      t.measured.savedTokens += sv.measured.savedTokens;
      t.measured.addedTokens += sv.measured.addedTokens;
    }
    if (sv?.estimated) {
      t.estimated.toolsListServed++;
      t.estimated.definitionTokens += sv.estimated.perTurnTokens;
    }
  }
  t.measured.netTokens = t.measured.savedTokens - t.measured.addedTokens;
  return t;
}

function emptyStats(): Stats {
  return { calls: 0, errors: 0, runs: 0, searches: 0, tokensSaved: 0, tokensToModel: 0, bytesOffloaded: 0, costUsd: 0, approvals: 0, denied: 0, measured: { calls: 0, savedTokens: 0, addedTokens: 0 }, estimated: { toolsListServed: 0, definitionTokens: 0 }, byTool: {}, since: new Date().toISOString() };
}

function clip(v: unknown): unknown {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  if (s === undefined) return undefined;
  return s.length > 2000 ? s.slice(0, 2000) + "…" : v;
}

export function round(n: number) {
  return Math.round(n * 10000) / 10000;
}
