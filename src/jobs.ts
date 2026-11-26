import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { round } from "./recorder.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

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
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running = 0;

  constructor(
    private runner: JobRunner,
    private opts: { file?: string; concurrency: number; backoffMs?: number },
  ) {
    super();
    this.load();
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
    queueMicrotask(() => this.pump());
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
      this.persist();
      this.emit("update", j);
    }
    return j;
  }

  /** Re-queue a failed / interrupted / cancelled job. */
  retry(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`No job ${id}`);
    if (!["failed", "interrupted", "cancelled"].includes(j.status)) throw new Error(`Job ${id} is ${j.status}`);
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
      outer: for (const tool of job.chain) {
        for (let attempt = 0; attempt < job.maxAttempts; attempt++) {
          if (ac.signal.aborted) break outer;
          job.attempts++;
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
            if (attempt + 1 < job.maxAttempts) await sleep((this.opts.backoffMs ?? 500) * 2 ** attempt, ac.signal);
          }
        }
      }
      if (job.status === "running") {
        if (ac.signal.aborted) job.status = "cancelled";
        else {
          job.status = "failed";
          job.error = lastErr instanceof Error ? lastErr.message : String(lastErr);
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
  return s === "succeeded" || s === "failed" || s === "cancelled" || s === "interrupted";
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
