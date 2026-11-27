import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { round } from "./recorder.js";
import { dispositionOf, CallError } from "./upstream.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";

export type DispatchOutcome = "succeeded" | "rejected" | "unknown" | "interrupted";

export interface Dispatch {
  tool: string;
  at: string;
  /** The tool's contract costUsd in force at dispatch: what an unknown/interrupted/cancelled attempt is charged. */
  estCostUsd?: number;
  /** That tool's own idempotent flag and key arg name (not the job's primary tool's). */
  idempotent: boolean;
  idempotencyKeyArg?: string;
  /** The key value actually sent for idempotencyKeyArg (the job's stable key, or one the caller put in the args). */
  idempotencyKey?: string;
  /** Unset while the request is in flight. */
  outcome?: DispatchOutcome;
  /** True once an estimate for this attempt was charged to the budget. */
  charged: boolean;
  /** True once this attempt's charged estimate was taken back because a later attempt with the same tool and key succeeded. */
  replaced?: boolean;
  /** Internal: money accounting for this attempt is finished (charged, covered by a later same-key attempt, or nothing owed). */
  settled?: boolean;
}

export interface Job {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: JobStatus;
  progress?: number;
  total?: number;
  message?: string;
  result?: unknown;
  error?: string;
  attempts: number;
  maxAttempts: number;
  /** Tools to try, in order. The first is the primary; the rest are fallbacks. */
  chain: string[];
  usedTool?: string;
  idempotent: boolean;
  traceId?: string;
  /** Capability token that submitted the job; its budget is charged on completion. */
  tokenId?: string;
  costUsd: number;
  /** True when costUsd is the tool contract's estimate (outcome unknown / interrupted after dispatch), not a confirmed charge. */
  costEstimated?: boolean;
  /**
   * Every attempt sent to a provider, in order (persisted before sending). Each carries the contract of the tool that was
   * actually sent, so every money decision (retry, resume, estimate) uses that tool's contract, not the primary's.
   */
  dispatches: Dispatch[];
  /** Stable key for the tool's idempotencyKeyArg: generated once per job, reused on every attempt and after restarts. */
  idempotencyKey?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type JobRunner = (
  tool: string,
  args: Record<string, unknown>,
  ctx: { signal: AbortSignal; progress: (p: number, total?: number, message?: string) => void; job: Job },
) => Promise<{ result: unknown; costUsd?: number }>;

/**
 * Job Queue for long-running AI work (video generation, renders, batch jobs).
 * Survives restarts, reports progress, supports cancel, retries with backoff,
 * and falls back to alternative providers when one fails.
 */
export class JobQueue extends EventEmitter {
  /** Jobs do not run until ready() is called (when opts.deferStart is set). */
  private started: boolean;
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running = 0;

  constructor(
    private runner: JobRunner,
    private opts: {
      file?: string;
      concurrency: number;
      backoffMs?: number;
      deferStart?: boolean;
      /** Called when an attempt is dispatched: the tool's current price and idempotency-key arg name. */
      dispatchInfo?: (tool: string) => { estCostUsd?: number; idempotencyKeyArg?: string; idempotent?: boolean; retries?: number };
    },
  ) {
    super();
    this.started = !opts.deferStart;
    this.load();
    if (this.started) queueMicrotask(() => this.pump());
  }

  private load() {
    const f = this.opts.file;
    if (!f || !existsSync(f)) return;
    for (const j of JSON.parse(readFileSync(f, "utf8")) as Job[]) {
      migrateLegacy(j);
      if (j.status === "running" || j.status === "queued") {
        // A request that was in flight when the gateway died may have been accepted.
        for (const d of j.dispatches) if (!d.outcome) d.outcome = "interrupted";
        const open = openDispatch(j);
        // Resume only what is safe, by the contract of the tool that was last actually sent: a paid request needs
        // idempotent + idempotencyKeyArg (the same key is re-sent); anything else is marked interrupted.
        const safe = open ? ((open.estCostUsd ?? 0) > 0 ? open.idempotent && !!open.idempotencyKeyArg : open.idempotent) : j.idempotent;
        if (safe) j.status = "queued";
        else {
          j.status = "interrupted";
          j.error = open
            ? "Gateway restarted while this job had a request in flight to a provider that cannot safely be repeated; re-submit to retry."
            : "Gateway restarted while this non-idempotent job was running; re-submit to retry.";
        }
      }
      this.jobs.set(j.id, j);
    }
  }

  /**
   * Start running jobs. Core calls this once the tool catalog is built, so resumed jobs never race
   * the upstream connections. `costOf` maps a tool id to its contract cost: interrupted jobs that
   * had already been sent to a provider are charged that estimate (emitted as "estimatedCharge").
   */
  ready(costOf?: (tool: string) => number | undefined) {
    this.started = true;
    let dirty = false;
    for (const j of this.jobs.values()) {
      if (j.status !== "interrupted") continue;
      const owed = j.dispatches.filter((d) => !d.settled && (d.outcome === "unknown" || d.outcome === "interrupted"));
      if (!owed.length) continue;
      // Prefer the price recorded at dispatch; the catalog may no longer have the tool (or have a new price).
      let unpriced = false;
      let zero = false;
      for (const d of owed) {
        d.estCostUsd ??= costOf?.(d.tool);
        if (d.estCostUsd === undefined) unpriced = true;
        else if (d.estCostUsd === 0) zero = true;
      }
      const usd = this.settle(j);
      j.error = `${j.error} The request had already been sent to the provider, so it may have been accepted and charged.`;
      if (usd > 0) j.error += ` Mycel charged the estimated cost ($${usd}) to the budget; check the provider before re-submitting.`;
      else if (unpriced) j.error += " No price was recorded for this job and its tool is not in the catalog, so nothing was charged to the budget; check the provider before re-submitting.";
      else if (zero) j.error += " The tool declares no cost, so nothing was charged to the budget; check the provider before re-submitting.";
      dirty = true;
    }
    if (dirty) this.persist();
    this.pump();
  }

  /** A later attempt with the same tool and key succeeded: its actual charge replaces the earlier estimate(s) for that key. */
  private replaceEstimates(j: Job, d: Dispatch) {
    const k = keyOf(j, d);
    if (k === undefined) return;
    for (const x of j.dispatches) {
      if (x === d || !x.charged || x.replaced || x.tool !== d.tool || keyOf(j, x) !== k) continue;
      const usd = x.estCostUsd ?? 0;
      x.replaced = true;
      x.charged = false;
      if (usd > 0) {
        j.costUsd = round(Math.max(0, j.costUsd - usd));
        this.emit("estimateRefund", j, usd);
      }
    }
    if (!j.dispatches.some((x) => x.charged && !x.replaced)) j.costEstimated = undefined;
  }

  private chargeEstimate(j: Job, usd: number) {
    j.costUsd = round(j.costUsd + usd);
    j.costEstimated = true;
    this.emit("estimatedCharge", j, usd);
  }

  /**
   * Charge, exactly once per attempt, the estimate of every dispatch whose outcome was never recorded (unknown or interrupted).
   * An earlier attempt is covered (not charged again) by a later attempt of the same tool that re-sent the same idempotency key
   * and was not definitely rejected: the provider saw one request. Returns the total charged now.
   */
  private settle(j: Job): number {
    let total = 0;
    j.dispatches.forEach((d, i) => {
      if (d.settled || !d.outcome) return;
      if (d.outcome !== "unknown" && d.outcome !== "interrupted") {
        d.settled = true;
        return;
      }
      if (d.idempotencyKeyArg && j.dispatches.slice(i + 1).some((x) => x.tool === d.tool && x.idempotencyKeyArg && x.outcome !== "rejected")) {
        d.settled = true;
        return;
      }
      // One estimate per (tool, idempotency key): the provider can only have one receipt for a key, however many times it was sent.
      const k = keyOf(j, d);
      if (k !== undefined && j.dispatches.some((x) => x !== d && x.charged && !x.replaced && x.tool === d.tool && keyOf(j, x) === k)) {
        d.settled = true;
        return;
      }
      d.settled = true;
      const usd = d.estCostUsd ?? 0;
      if (usd > 0) {
        d.charged = true;
        this.chargeEstimate(j, usd);
        total = round(total + usd);
      }
    });
    return total;
  }

  /** A job abandoned after dispatch may still have been accepted: charge the dispatch-time estimates once. */
  private chargeAbandoned(j: Job, what: string): string {
    for (const d of j.dispatches) if (!d.outcome) d.outcome = "interrupted";
    const usd = this.settle(j);
    if (usd <= 0) return "";
    return `${what} after the request was sent to the provider, so it may have been accepted and charged. Mycel charged the estimated cost ($${usd}) to the budget; check the provider.`;
  }

  private persist() {
    const f = this.opts.file;
    if (!f) return;
    mkdirSync(dirname(f), { recursive: true });
    const keep = [...this.jobs.values()].slice(-1000);
    writeFileSync(f, JSON.stringify(keep, null, 2));
  }

  submit(tool: string, args: Record<string, unknown>, o: { fallback?: string[]; retries?: number; idempotent?: boolean; traceId?: string; tokenId?: string } = {}): Job {
    const job: Job = {
      id: `job_${randomUUID().slice(0, 12)}`,
      tool,
      args,
      status: "queued",
      attempts: 0,
      dispatches: [],
      maxAttempts: 1 + (o.retries ?? 0),
      chain: [tool, ...(o.fallback ?? [])],
      idempotent: o.idempotent ?? false,
      traceId: o.traceId,
      tokenId: o.tokenId,
      costUsd: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.persist();
    this.emit("update", job);
    this.pump();
    return job;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  list(filter?: { status?: JobStatus }) {
    return [...this.jobs.values()].filter((j) => !filter?.status || j.status === filter.status).reverse();
  }

  cancel(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`No job ${id}`);
    if (j.status === "queued" || j.status === "running") {
      this.controllers.get(id)?.abort();
      j.status = "cancelled";
      j.finishedAt = new Date().toISOString();
      const note = this.chargeAbandoned(j, "Cancelled");
      if (note) j.message = note;
      this.persist();
      this.emit("update", j);
    }
    return j;
  }

  /** Re-queue a failed / interrupted / cancelled job. */
  retry(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`No job ${id}`);
    if (!["failed", "interrupted", "cancelled", "unknown"].includes(j.status)) throw new Error(`Job ${id} is ${j.status}`);
    // Deliberate: a manual retry keeps the job's idempotency key, even when the last paid dispatch is unresolved. A deduplicating
    // provider then collapses it into the original request (one receipt), and Mycel settles one estimate per (tool, key): a later
    // success replaces the earlier estimate with the actual charge. A provider that ignores the key may bill again; reconcile with it.
    Object.assign(j, { status: "queued", attempts: 0, error: undefined, finishedAt: undefined, startedAt: undefined });
    this.persist();
    this.emit("update", j);
    this.pump();
    return j;
  }

  /** Resolve when the job reaches a terminal state (or the timeout passes). */
  wait(id: string, timeoutMs: number): Promise<Job> {
    const j = this.jobs.get(id);
    if (!j) return Promise.reject(new Error(`No job ${id}`));
    if (isTerminal(j.status)) return Promise.resolve(j);
    return new Promise((resolve) => {
      const onUpdate = (u: Job) => {
        if (u.id === id && isTerminal(u.status)) done();
      };
      const done = () => {
        clearTimeout(t);
        this.off("update", onUpdate);
        resolve(this.jobs.get(id)!);
      };
      const t = setTimeout(done, timeoutMs);
      this.on("update", onUpdate);
    });
  }

  private pump() {
    if (!this.started) return;
    while (this.running < this.opts.concurrency) {
      const next = [...this.jobs.values()].find((j) => j.status === "queued");
      if (!next) return;
      void this.execute(next);
    }
  }

  private async execute(job: Job) {
    this.running++;
    job.status = "running";
    job.startedAt ??= new Date().toISOString();
    this.persist();
    this.emit("update", job);
    const ac = new AbortController();
    this.controllers.set(job.id, ac);
    const progress = (p: number, total?: number, message?: string) => {
      job.progress = p;
      job.total = total;
      job.message = message;
      this.emit("update", job);
    };
    try {
      let lastErr: unknown;
      let unknownErr: CallError | undefined;
      // Resuming with a request still unresolved at a keyed paid tool: continue at that tool, never earlier in the chain.
      const open = openDispatch(job);
      const startAt = open ? Math.max(0, job.chain.indexOf(open.tool)) : 0;
      outer: for (const tool of job.chain.slice(startAt)) {
        const info = this.opts.dispatchInfo?.(tool);
        const primary = tool === job.chain[0];
        const idempotent = info?.idempotent ?? (primary ? job.idempotent : false);
        const maxAttempts = info?.retries !== undefined ? 1 + info.retries : primary ? job.maxAttempts : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (ac.signal.aborted) break outer;
          job.attempts++;
          const d: Dispatch = { tool, at: new Date().toISOString(), estCostUsd: info?.estCostUsd, idempotent, idempotencyKeyArg: info?.idempotencyKeyArg, charged: false };
          if (info?.idempotencyKeyArg) job.idempotencyKey ??= `mycel-${job.id}`;
          if (info?.idempotencyKeyArg) {
            const given = job.args[info.idempotencyKeyArg];
            d.idempotencyKey = given !== undefined ? String(given) : job.idempotencyKey;
          }
          job.dispatches.push(d);
          this.persist();
          try {
            const { result, costUsd } = await this.runner(tool, job.args, { signal: ac.signal, progress, job });
            if (ac.signal.aborted) break outer;
            d.outcome = "succeeded";
            d.settled = true;
            this.replaceEstimates(job, d);
            job.usedTool = tool;
            job.result = result;
            job.costUsd = round(job.costUsd + (costUsd ?? 0));
            job.status = "succeeded";
            lastErr = undefined;
            unknownErr = undefined;
            break outer;
          } catch (e) {
            lastErr = e;
            if (ac.signal.aborted) break outer;
            if (dispositionOf(e) === "unknown") {
              // The provider may have accepted this. Never fall back. Retrying the same tool is allowed only when that tool's own
              // contract makes it safe: idempotent, and for a paid tool also a key the provider can dedup on.
              d.outcome = "unknown";
              unknownErr = e instanceof CallError ? e : new CallError(e instanceof Error ? e.message : String(e), "unknown");
              if (d.estCostUsd === undefined && unknownErr.estimatedCostUsd !== undefined) d.estCostUsd = unknownErr.estimatedCostUsd;
              const paid = (d.estCostUsd ?? 0) > 0;
              if (!d.idempotent || (paid && !d.idempotencyKeyArg)) break outer;
            } else {
              d.outcome = "rejected";
              d.settled = true;
              if (unknownErr) break outer; // an earlier attempt may have been accepted: a later rejection does not clear that
            }
            if (attempt + 1 < maxAttempts) await sleep((this.opts.backoffMs ?? 500) * 2 ** attempt, ac.signal);
          }
        }
        if (unknownErr) break; // retries exhausted on an unknown outcome: do not fall back
      }
      if (job.status === "running") {
        if (ac.signal.aborted) {
          job.status = "cancelled";
          const note = this.chargeAbandoned(job, "Cancelled");
          if (note) job.message = note;
        } else if (unknownErr) {
          job.status = "unknown";
          const est = this.settle(job);
          job.error = `The provider may have accepted this job; check the provider before retrying. Mycel did not fall back to avoid paying twice.${est > 0 ? ` Estimated cost $${est} was charged to the budget.` : ""} (${unknownErr.message})`;
        } else {
          job.status = "failed";
          job.error = lastErr instanceof Error ? lastErr.message : String(lastErr);
          const note = this.chargeAbandoned(job, "This job had been dispatched before the gateway restarted");
          if (note) job.error = `${job.error} ${note}`;
        }
      } else if (job.status === "succeeded") {
        // Another attempt (e.g. before a restart) may also have been accepted: its estimate is never dropped.
        const owed = this.settle(job);
        if (owed > 0) job.message = `An earlier request was sent to a provider before this one succeeded; Mycel charged its estimate ($${owed}) as well.`;
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      this.controllers.delete(job.id);
      this.running--;
      this.persist();
      this.emit("update", job);
      this.pump();
    }
  }
}

/** The idempotency key value an attempt carried (older records only have the job's key). */
function keyOf(j: Job, d: Dispatch): string | undefined {
  if (!d.idempotencyKeyArg) return undefined;
  return d.idempotencyKey ?? j.idempotencyKey;
}

/** The most recent attempt whose outcome was never recorded and not yet accounted for: the request that may be in flight. */
function openDispatch(j: Job): Dispatch | undefined {
  return [...j.dispatches].reverse().find((d) => !d.settled && (d.outcome === "unknown" || d.outcome === "interrupted" || !d.outcome));
}

/** Jobs persisted by 0.1.3 and earlier tracked a single dispatchedAt/dispatchedTool/estCostUsd. */
function migrateLegacy(j: Job & { dispatchedAt?: string; dispatchedTool?: string; estCostUsd?: number }) {
  if (!j.dispatches) {
    j.dispatches = [];
    if (j.dispatchedAt) {
      j.dispatches.push({
        tool: j.dispatchedTool ?? j.tool,
        at: j.dispatchedAt,
        estCostUsd: j.estCostUsd,
        idempotent: j.idempotent,
        idempotencyKeyArg: j.idempotencyKey ? "(legacy)" : undefined,
        outcome: j.status === "succeeded" ? "succeeded" : "interrupted",
        charged: !!j.costEstimated,
        settled: j.status === "succeeded" || !!j.costEstimated || undefined,
      });
    }
  }
  delete j.dispatchedAt;
  delete j.dispatchedTool;
  delete j.estCostUsd;
}

export function isTerminal(s: JobStatus) {
  return s === "succeeded" || s === "failed" || s === "cancelled" || s === "interrupted" || s === "unknown";
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      r();
    });
  });
}

// ------------------------------------------------------------------ budget
interface Ledger {
  days: Record<string, number>;
  tasks: Record<string, number>;
  tokens: Record<string, number>;
}

export class BudgetExceeded extends Error {}

/**
 * Cost & Budget: estimate before running, enforce per-task / per-day / per-token caps.
 */
export class Budget {
  private ledger: Ledger = { days: {}, tasks: {}, tokens: {} };
  constructor(
    private limits: { perTaskUsd?: number; perDayUsd?: number },
    private file?: string,
  ) {
    if (file && existsSync(file)) this.ledger = { days: {}, tasks: {}, tokens: {}, ...JSON.parse(readFileSync(file, "utf8")) };
  }

  private today() {
    return new Date().toISOString().slice(0, 10);
  }

  spent(task?: string) {
    return { day: round(this.ledger.days[this.today()] ?? 0), task: task ? round(this.ledger.tasks[task] ?? 0) : undefined };
  }

  /** Throws BudgetExceeded if spending `usd` would break a cap. */
  check(usd: number, task?: string, token?: { id: string; budgetUsd?: number }) {
    if (usd <= 0) return;
    const day = (this.ledger.days[this.today()] ?? 0) + usd;
    if (this.limits.perDayUsd !== undefined && day > this.limits.perDayUsd) {
      throw new BudgetExceeded(`Daily budget $${this.limits.perDayUsd} would be exceeded (spent $${round(day - usd)}, this call ~$${usd}).`);
    }
    if (task && this.limits.perTaskUsd !== undefined) {
      const t = (this.ledger.tasks[task] ?? 0) + usd;
      if (t > this.limits.perTaskUsd) throw new BudgetExceeded(`Per-task budget $${this.limits.perTaskUsd} would be exceeded (spent $${round(t - usd)}, this call ~$${usd}).`);
    }
    if (token?.budgetUsd !== undefined) {
      const k = (this.ledger.tokens[token.id] ?? 0) + usd;
      if (k > token.budgetUsd) throw new BudgetExceeded(`Capability token budget $${token.budgetUsd} would be exceeded.`);
    }
  }

  /** Take back an estimate that a successful, deduplicated later attempt replaced (the actual charge is booked separately). */
  refund(usd: number, task?: string, tokenId?: string) {
    if (usd <= 0) return;
    const d = this.today();
    this.ledger.days[d] = round(Math.max(0, (this.ledger.days[d] ?? 0) - usd));
    if (task && this.ledger.tasks[task] !== undefined) this.ledger.tasks[task] = round(Math.max(0, this.ledger.tasks[task] - usd));
    if (tokenId && this.ledger.tokens[tokenId] !== undefined) this.ledger.tokens[tokenId] = round(Math.max(0, this.ledger.tokens[tokenId] - usd));
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.ledger));
    }
  }

  charge(usd: number, task?: string, tokenId?: string) {
    if (usd <= 0) return;
    const d = this.today();
    this.ledger.days[d] = round((this.ledger.days[d] ?? 0) + usd);
    if (task) this.ledger.tasks[task] = round((this.ledger.tasks[task] ?? 0) + usd);
    if (tokenId) this.ledger.tokens[tokenId] = round((this.ledger.tokens[tokenId] ?? 0) + usd);
    // Keep the ledger small.
    const taskKeys = Object.keys(this.ledger.tasks);
    if (taskKeys.length > 2000) for (const k of taskKeys.slice(0, taskKeys.length - 2000)) delete this.ledger.tasks[k];
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.ledger));
    }
  }
}
