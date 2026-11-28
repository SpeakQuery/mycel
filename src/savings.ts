/**
 * Savings accounting, kept honest by separating two kinds of numbers:
 *
 * MEASURED  — result savings. For one tool call: the size of the raw upstream result vs the size Mycel
 *             actually returned to the model, both with the same chars/4 estimator used everywhere else
 *             (`estimateTokens`). Exact for what Mycel saw; "tokens" are the estimator's tokens.
 * ESTIMATED — tool-definition savings. What a client that loads every tool definition up front would
 *             send per turn, minus what Mycel exposes. Mycel cannot see how many turns the client makes
 *             or whether it already loads tools on demand, so this is counted once per `tools/list`
 *             request served and always labelled as an estimate.
 */

export const TOKEN_UNIT = "chars/4 tokens (approx.)";
export const ESTIMATE_CAVEAT = "estimated — only applies if your client sends every tool definition each turn (Claude Code and recent Cursor load tools on demand)";

export interface MeasuredSavings {
  /** Raw upstream result size in tokens. */
  rawTokens: number;
  /** What Mycel returned to the model for the same call, in tokens. */
  returnedTokens: number;
  /** rawTokens − returnedTokens when the result shrank, otherwise 0. Never negative. */
  savedTokens: number;
  /** returnedTokens − rawTokens when Mycel returned MORE than raw (small results plus metadata), otherwise 0. */
  addedTokens: number;
  /** Whole-number percent saved (0 unless the result shrank). */
  pct: number;
}

export function measure(rawTokens: number, returnedTokens: number): MeasuredSavings {
  const delta = rawTokens - returnedTokens;
  return {
    rawTokens,
    returnedTokens,
    savedTokens: delta > 0 ? delta : 0,
    addedTokens: delta < 0 ? -delta : 0,
    pct: delta > 0 && rawTokens > 0 ? Math.round((delta / rawTokens) * 100) : 0,
  };
}

/** The `savings` field of a recorder event. */
export interface EventSavings {
  /** Gateway session id, so `mycel stats` can total one session. */
  session: string;
  measured?: MeasuredSavings;
  /** false for a tool call made inside mycel_run: the run event carries the counted total. */
  counted?: boolean;
  /** Only on tools/list events. */
  estimated?: { perTurnTokens: number; basis: "tools/list" };
}

export interface SessionSavings {
  /** Calls with a measured result (counted ones only). */
  calls: number;
  /** Raw upstream size of those calls, in tokens (what the model would have read without Mycel). */
  rawTokens?: number;
  /** Tokens saved on calls whose result shrank. */
  savedTokens: number;
  /** Tokens added on calls where Mycel returned more than raw. */
  addedTokens: number;
  /** savedTokens − addedTokens; negative means the session cost more than it saved. */
  netTokens: number;
}

const COMMA = /\B(?=(\d{3})+(?!\d))/g;
export const fmtInt = (n: number): string => String(Math.round(n)).replace(COMMA, ",");
const fmtCompact = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : fmtInt(n));

export function fmtSigned(net: number): string {
  return net > 0 ? `−${fmtInt(net)}` : net < 0 ? `+${fmtInt(-net)}` : "0";
}

/**
 * What saved tokens are worth, as an ESTIMATE: input price per million tokens and how fast a model reads input.
 * Both are configurable (`ui.usdPerMTok`, `ui.tokensPerSecond`) and always labelled "estimated".
 */
export interface ValueRates {
  usdPerMTok: number;
  tokensPerSecond: number;
}
export const DEFAULT_RATES: ValueRates = { usdPerMTok: 3, tokensPerSecond: 3000 };

export function valueOf(tokens: number, r: ValueRates = DEFAULT_RATES): { usd: number; seconds: number } {
  const t = Math.max(0, tokens);
  return { usd: (t / 1_000_000) * r.usdPerMTok, seconds: r.tokensPerSecond > 0 ? t / r.tokensPerSecond : 0 };
}
export const fmtUsd = (usd: number): string => (usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? "<$0.01" : "$0");
export function fmtDuration(seconds: number): string {
  if (seconds < 1) return seconds > 0 ? "<1 s" : "0 s";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
/** Percent of the raw size saved over a session (0 when unknown or nothing saved). */
export function sessionPct(s: SessionSavings): number {
  return s.rawTokens && s.netTokens > 0 ? Math.round((s.netTokens / s.rawTokens) * 100) : 0;
}

/**
 * One line, e.g.
 * `Mycel · this call −87% (≈13,240 → ≈1,710 tokens, measured) · session −46,600 tokens (−81%) ≈ $0.14 · ≈16 s (estimated) · tool definitions ~−202k/turn (estimated)`.
 * What is measured is the SIZE (characters); "tokens" are chars/4. Money and time are estimates from `rates`.
 */
export function formatSavingsLine(m: MeasuredSavings, session: SessionSavings, definitionsPerTurn = 0, rates: ValueRates = DEFAULT_RATES): string {
  const change = m.savedTokens > 0 ? `−${m.pct}%` : m.addedTokens > 0 ? `+${fmtInt(m.addedTokens)} tokens` : "no change";
  const parts = ["Mycel", `this call ${change} (≈${fmtInt(m.rawTokens)} → ≈${fmtInt(m.returnedTokens)} tokens, measured)`];
  if (session.netTokens > 0) {
    const v = valueOf(session.netTokens, rates);
    const pct = sessionPct(session);
    parts.push(`session −${fmtInt(session.netTokens)} tokens${pct ? ` (−${pct}%)` : ""} ≈ ${fmtUsd(v.usd)} · ≈${fmtDuration(v.seconds)} (estimated)`);
  } else parts.push(`session ≈${fmtSigned(session.netTokens)} tokens`);
  if (definitionsPerTurn > 0) parts.push(`tool definitions ~−${fmtCompact(definitionsPerTurn)}/turn (estimated)`);
  return parts.join(" · ");
}

/** Running totals for one gateway session. */
export class SavingsTracker {
  private totals: SessionSavings = { calls: 0, rawTokens: 0, savedTokens: 0, addedTokens: 0, netTokens: 0 };
  private perTurn?: number;
  private lists = 0;

  /** Add one measured call. Pass counted=false for calls whose savings are accounted for elsewhere (inside mycel_run). */
  record(m: MeasuredSavings, counted = true): SessionSavings {
    if (counted) {
      this.totals.calls++;
      this.totals.rawTokens = (this.totals.rawTokens ?? 0) + m.rawTokens;
      this.totals.savedTokens += m.savedTokens;
      this.totals.addedTokens += m.addedTokens;
      this.totals.netTokens = this.totals.savedTokens - this.totals.addedTokens;
    }
    return this.snapshot();
  }

  /** A tools/list was served; `perTurnTokens` = catalog definitions minus what Mycel exposed. */
  noteToolsList(perTurnTokens: number) {
    this.perTurn = Math.max(0, perTurnTokens);
    this.lists++;
  }

  snapshot(): SessionSavings {
    return { ...this.totals };
  }

  /** Last per-turn definition estimate from a served tools/list, if any. */
  lastDefinitionsPerTurn(): number | undefined {
    return this.perTurn;
  }

  toolsListServed(): number {
    return this.lists;
  }
}

/** What goes into `_meta["mycel/savings"]` on an MCP tool result. */
export interface SavingsMeta {
  line: string;
  unit: typeof TOKEN_UNIT;
  measured: MeasuredSavings;
  session: SessionSavings;
  estimated: { toolDefinitionTokensPerTurn: number; label: string };
}

/** Text for `mycel stats`: measured and estimated are printed separately and never summed. */
export function formatStats(
  r: { session?: { id: string; start: string; measured: SessionSavings & { calls: number }; estimated: { toolsListServed: number; definitionTokens: number } }; day: { date: string; measured: SessionSavings & { calls: number }; estimated: { toolsListServed: number; definitionTokens: number } } },
  rates: ValueRates = DEFAULT_RATES,
): string {
  const block = (title: string, t: NonNullable<typeof r.session>["measured"], e: { toolsListServed: number; definitionTokens: number }) => [
    title,
    `  measured    ≈${fmtSigned(t.netTokens)} tokens (chars/4) net over ${fmtInt(t.calls)} call${t.calls === 1 ? "" : "s"} (saved ${fmtInt(t.savedTokens)}, added ${fmtInt(t.addedTokens)})${sessionPct(t) ? `: −${sessionPct(t)}% of what the tools returned` : ""}`,
    ...(t.netTokens > 0
      ? [`  worth       ≈ ${fmtUsd(valueOf(t.netTokens, rates).usd)} and ≈${fmtDuration(valueOf(t.netTokens, rates).seconds)} of model reading (estimated at $${rates.usdPerMTok}/M input tokens and ${fmtInt(rates.tokensPerSecond)} tokens/s; change with ui.usdPerMTok / ui.tokensPerSecond)`]
      : []),
    `  estimated   ${e.toolsListServed ? `~−${fmtInt(e.definitionTokens)} tokens (chars/4) of tool definitions over ${fmtInt(e.toolsListServed)} tools/list served` : "no tools/list served"}`,
  ];
  return [
    ...(r.session ? block(`session ${r.session.id} (since ${r.session.start})`, r.session.measured, r.session.estimated) : ["session: nothing recorded yet"]),
    ...block(`today ${r.day.date} (UTC)`, r.day.measured, r.day.estimated),
    `measured = size of the raw upstream result vs what Mycel returned. Tokens are approximated as chars/4; real tokenizers differ (sometimes by tens of percent on a small body). Counted per call; calls inside mycel_run are counted once, as the run.`,
    `${ESTIMATE_CAVEAT}. Counted once per tools/list served, not per model turn.`,
  ].join("\n");
}
