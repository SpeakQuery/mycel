import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { round } from "./recorder.js";
import { dispositionOf, CallError } from "./upstream.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "unknown";

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
  /** Set (and persisted) just before the call is sent to a provider; cleared if the provider definitely rejected it. */
  dispatchedAt?: string;
  dispatchedTool?: string;
  /** The contract costUsd in force when the attempt was dispatched (persisted): what an unknown/interrupted/cancelled job is charged. */
  estCostUsd?: number;
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
      dispatchInfo?: (tool: string) => { estCostUsd?: number; idempotencyKeyArg?: string };
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
      if (j.status === "running" || j.status === "queued") {
        // Resume safe work; mark the rest interrupted so nothing runs twice by surprise.
        if (j.idempotent) j.status = "queued";
        else {
          j.status = "interrupted";
          j.error = "Gateway restarted while this non-idempotent job was running; re-submit to retry.";
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
      if (j.status !== "interrupted" || !j.dispatchedAt || j.costEstimated) continue;
      // Prefer the price recorded at dispatch; the catalog may no longer have the tool (or have a new price).
      const known = j.estCostUsd ?? costOf?.(j.dispatchedTool ?? j.tool);
      const usd = known ?? 0;
      j.error = `${j.error} The request had already been sent to the provider, so it may have been accepted and charged.`;
      if (usd > 0) {
        this.chargeEstimate(j, usd);
        j.error += ` Mycel charged the estimated cost ($${usd}) to the budget; check the provider before re-submitting.`;
      } else if (known === 0) j.error += " The tool declares no cost, so nothing was charged to the budget; check the provider before re-submitting.";
      else j.error += " No price was recorded for this job and its tool is not in the catalog, so nothing was charged to the budget; check the provider before re-submitting.";
      dirty = true;
    }
    if (dirty) this.persist();
    this.pump();
  }

  private chargeEstimate(j: Job, usd: number) {
    j.costUsd = round(j.costUsd + usd);
    j.costEstimated = true;
    this.emit("estimatedCharge", j, usd);
  }

  /** A job abandoned after dispatch may still have been accepted: charge the dispatch-time estimate once. */
  private chargeAbandoned(j: Job, what: string): string {
    const usd = j.estCostUsd ?? 0;
    if (!j.dispatchedAt || j.costEstimated || usd <= 0) return "";
    this.chargeEstimate(j, usd);
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
    Object.assign(j, { status: "queued", attempts: 0, error: undefined, finishedAt: undefined, startedAt: undefined, dispatchedAt: undefined, dispatchedTool: undefined, estCostUsd: undefined });
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
      // A dispatch recorded before a restart may have been accepted; a later rejection must not erase that memory.
      const carried = job.dispatchedAt ? { at: job.dispatchedAt, tool: job.dispatchedTool, est: job.estCostUsd } : undefined;
      let unknownErr: CallError | undefined;
      outer: for (const tool of job.chain) {
        for (let attempt = 0; attempt < job.maxAttempts; attempt++) {
          if (ac.signal.aborted) break outer;
          job.attempts++;
          job.dispatchedAt = new Date().toISOString();
          job.dispatchedTool = tool;
          const info = this.opts.dispatchInfo?.(tool);
          if (info?.estCostUsd !== undefined) job.estCostUsd = info.estCostUsd;
          if (info?.idempotencyKeyArg) job.idempotencyKey ??= `mycel-${job.id}`;
          this.persist();
          try {
            const { result, costUsd } = await this.runner(tool, job.args, { signal: ac.signal, progress, job });
            if (ac.signal.aborted) break outer;
            job.usedTool = tool;
            job.result = result;
            job.costUsd = round(job.costUsd + (costUsd ?? 0));
            job.status = "succeeded";
            lastErr = undefined;
            break outer;
          } catch (e) {
            lastErr = e;
            if (ac.signal.aborted) break outer;
            if (dispositionOf(e) === "unknown") {
              // The provider may have accepted this. Never fall back; only an idempotent tool may be retried.
              unknownErr = e instanceof CallError ? e : new CallError(e instanceof Error ? e.message : String(e), "unknown");
              if (!job.idempotent) break outer;
            } else {
              unknownErr = undefined;
              job.dispatchedAt = carried?.at;
              job.dispatchedTool = carried?.tool;
              job.estCostUsd = carried?.est;
            }
            if (attempt + 1 < job.maxAttempts) await sleep((this.opts.backoffMs ?? 500) * 2 ** attempt, ac.signal);
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
          const est = job.estCostUsd ?? unknownErr.estimatedCostUsd ?? 0;
          if (est > 0) this.chargeEstimate(job, est);
          job.error = `The provider may have accepted this job; check the provider before retrying. Mycel did not fall back to avoid paying twice.${est > 0 ? ` Estimated cost $${est} was charged to the budget.` : ""} (${unknownErr.message})`;
        } else {
          job.status = "failed";
          job.error = lastErr instanceof Error ? lastErr.message : String(lastErr);
          if (carried) {
            const note = this.chargeAbandoned(job, "This job had been dispatched before the gateway restarted");
            if (note) job.error = `${job.error} ${note}`;
          }
        }
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
