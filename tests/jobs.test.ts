import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Mycel } from "../src/core.js";
import { MycelConfig } from "../src/config.js";
import type { ToolProvider } from "../src/upstream.js";
import { CallError, dispositionOf } from "../src/upstream.js";
import { tmp } from "./helpers.js";

/** In-process paid provider: every accepted `render` costs $0.40. */
function paidProvider(behaviour: "ok" | "lost-reply" | "refused" = "ok", opts: { listDelayMs?: number } = {}) {
  const state = { accepted: 0 };
  const provider: ToolProvider = {
    listTools: async () => {
      if (opts.listDelayMs) await new Promise((r) => setTimeout(r, opts.listDelayMs));
      return [{ name: "render", description: "Render a video", inputSchema: { type: "object", properties: {} } }];
    },
    callTool: async () => {
      if (behaviour === "refused") throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
      state.accepted++; // the provider took the job (and the money)
      if (behaviour === "lost-reply") throw new McpError(ErrorCode.ConnectionClosed, "Connection closed");
      return { content: [{ type: "text", text: JSON.stringify({ video: "v1" }) }] };
    },
  };
  return { provider, state };
}

const contract = (extra: Record<string, unknown> = {}) => ({ render: { async: true, costUsd: 0.4, effect: "write", ...extra } }) as never;

async function boot(home: string, providers: Record<string, { provider: ToolProvider; tools?: unknown }>, config: Record<string, unknown> = {}) {
  const cfg = MycelConfig.parse({ refs: { dir: join(home, "refs") }, pinning: { enabled: false }, jobs: { asyncThresholdMs: 3000 }, budget: { perDayUsd: 10 }, ...config });
  return new Mycel({ config: cfg, path: null, home }, { noConnect: true, providers: providers as never }).start();
}

function persistJob(home: string, over: Record<string, unknown>) {
  const job = { id: "job_persisted1", tool: "pa.render", args: {}, status: "queued", attempts: 0, maxAttempts: 1, chain: ["pa.render"], idempotent: false, costUsd: 0, createdAt: new Date().toISOString(), ...over };
  writeFileSync(join(home, "jobs.json"), JSON.stringify([job]));
  return job.id;
}

describe("job queue: money safety", () => {
  it("normal success: provider accepts once, ledger shows $0.40", async () => {
    const home = tmp();
    const a = paidProvider();
    const m = await boot(home, { pa: { provider: a.provider, tools: contract() } });
    const out = await m.call("pa.render", {});
    expect(out.status).toBe("ok");
    expect(a.state.accepted).toBe(1);
    expect(m.budget.spent().day).toBe(0.4);
  });

  it("restart with an idempotent queued job waits for the catalog (slow upstream) and runs exactly once", async () => {
    const home = tmp();
    const id = persistJob(home, { idempotent: true });
    const a = paidProvider("ok", { listDelayMs: 250 });
    const m = await boot(home, { pa: { provider: a.provider, tools: contract({ idempotent: true }) } });
    const job = await m.jobs.wait(id, 3000);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("succeeded");
    expect(a.state.accepted).toBe(1);
    expect(m.budget.spent().day).toBe(0.4);
  });

  it("a resumed job whose upstream never connects fails with a message naming the server and tool", async () => {
    const home = tmp();
    const id = persistJob(home, { tool: "ghost.render", chain: ["ghost.render"], idempotent: true });
    const m = await boot(home, {});
    const job = await m.jobs.wait(id, 3000);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/ghost\.render/);
    expect(job.error).toMatch(/ghost/);
    expect(job.error).toMatch(/not connected/);
  });

  it("lost reply with a fallback configured: status unknown, one accept, no fallback, estimated $0.40", async () => {
    const home = tmp();
    const a = paidProvider("lost-reply");
    const b = paidProvider("ok");
    const m = await boot(home, { pa: { provider: a.provider, tools: contract({ fallback: ["pb.render"] }) }, pb: { provider: b.provider, tools: contract() } });
    const out = await m.call("pa.render", {});
    expect(out.status).toBe("error");
    expect((out as { error: string }).error).toContain("The provider may have accepted this job; check the provider before retrying. Mycel did not fall back to avoid paying twice.");
    expect(a.state.accepted).toBe(1);
    expect(b.state.accepted).toBe(0);
    const [job] = m.jobs.list();
    expect(job).toMatchObject({ status: "unknown", costUsd: 0.4, costEstimated: true });
    expect(m.budget.spent().day).toBe(0.4);
    expect(m.jobView(job)).toMatchObject({ status: "unknown", costUsd: 0.4, costEstimated: true });
    // persisted
    expect(JSON.parse(readFileSync(join(home, "jobs.json"), "utf8"))[0]).toMatchObject({ status: "unknown", costEstimated: true });
  });

  it("lost reply is never auto-retried for a non-idempotent tool, even with retries configured", async () => {
    const a = paidProvider("lost-reply");
    const m = await boot(tmp(), { pa: { provider: a.provider, tools: contract({ retries: 3 }) } });
    await m.call("pa.render", {});
    expect(a.state.accepted).toBe(1);
  });

  it("provider down (connect refused) falls back; total accepts is 1", async () => {
    const a = paidProvider("refused");
    const b = paidProvider("ok");
    const m = await boot(tmp(), { pa: { provider: a.provider, tools: contract({ fallback: ["pb.render"] }) }, pb: { provider: b.provider, tools: contract() } });
    const out = await m.call("pa.render", {});
    expect(out).toMatchObject({ status: "ok", tool: "pb.render" });
    expect(a.state.accepted + b.state.accepted).toBe(1);
    expect(m.budget.spent().day).toBe(0.4);
  });

  it("restart of a non-idempotent job after dispatch: interrupted, charged an estimated $0.40 once", async () => {
    const home = tmp();
    const id = persistJob(home, { status: "running", attempts: 1, dispatchedAt: new Date().toISOString(), dispatchedTool: "pa.render" });
    const a = paidProvider();
    const m = await boot(home, { pa: { provider: a.provider, tools: contract() } });
    const job = m.jobs.get(id)!;
    expect(job).toMatchObject({ status: "interrupted", costUsd: 0.4, costEstimated: true });
    expect(job.error).toMatch(/already been sent to the provider/);
    expect(job.error).toMatch(/\$0\.4/);
    expect(a.state.accepted).toBe(0);
    expect(m.budget.spent().day).toBe(0.4);
    await m.close();
    // a second restart must not charge again
    const m2 = await boot(home, { pa: { provider: paidProvider().provider, tools: contract() } });
    expect(m2.budget.spent().day).toBe(0.4);
  });

  it("restart of a non-idempotent job that was never dispatched costs $0", async () => {
    const home = tmp();
    const id = persistJob(home, { status: "queued" });
    const m = await boot(home, { pa: { provider: paidProvider().provider, tools: contract() } });
    expect(m.jobs.get(id)).toMatchObject({ status: "interrupted", costUsd: 0 });
    expect(m.budget.spent().day).toBe(0);
  });
});

/**
 * A provider that, like a real stdio MCP server wrapping a paid HTTP API, accepts the job (and the money)
 * and then reports "fetch failed" as a normal tool result with isError:true.
 */
function errorResultProvider(opts: { dedupKeyArg?: string } = {}) {
  const state = { accepted: 0, receipts: [] as string[], args: [] as Array<Record<string, unknown>> };
  const provider: ToolProvider = {
    listTools: async () => [{ name: "render", description: "Render a video", inputSchema: { type: "object", properties: {} } }],
    callTool: async (_n, args) => {
      state.accepted++;
      state.args.push(args);
      return { isError: true, content: [{ type: "text", text: "fetch failed" }] };
    },
  };
  return { provider, state };
}

/** A provider that accepts, then hangs until its request is aborted. Dedups by an idempotency key arg when asked. */
function holdingProvider(keyArg?: string, seen: Set<string> = new Set()) {
  const state = { accepted: 0, receipts: 0, args: [] as Array<Record<string, unknown>> };
  let hold = true;
  const provider: ToolProvider = {
    listTools: async () => [{ name: "render", description: "Render a video", inputSchema: { type: "object", properties: {} } }],
    callTool: async (_n, args, o) => {
      state.accepted++;
      state.args.push(args);
      const key = keyArg ? (args[keyArg] as string | undefined) : undefined;
      if (!key || !seen.has(key)) state.receipts++; // a new receipt = a new charge
      if (key) seen.add(key);
      if (hold) await new Promise<never>((_, rej) => o.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      return { content: [{ type: "text", text: JSON.stringify({ video: "v1" }) }] };
    },
  };
  return { provider, state, release: () => (hold = false) };
}

const until = async (f: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!f()) throw new Error("condition not reached");
};

describe("paid tool isError results", () => {
  it("is disposition unknown: estimate charged, no fallback, status unknown (with and without a fallback)", async () => {
    for (const fallback of [["pb.render"], []]) {
      const a = errorResultProvider();
      const b = paidProvider("ok");
      const m = await boot(tmp(), { pa: { provider: a.provider, tools: contract({ fallback }) }, pb: { provider: b.provider, tools: contract() } });
      const out = await m.call("pa.render", {});
      expect(out.status).toBe("error");
      expect(a.state.accepted).toBe(1);
      expect(b.state.accepted).toBe(0);
      const [job] = m.jobs.list();
      expect(job).toMatchObject({ status: "unknown", costUsd: 0.4, costEstimated: true });
      expect(job.error).toContain("Mycel did not fall back");
      expect(m.budget.spent().day).toBe(0.4);
    }
  });

  it("errorsAreRejections: true keeps today's behaviour: rejected, falls back, no estimate for the failed attempt", async () => {
    const a = errorResultProvider();
    const b = paidProvider("ok");
    const m = await boot(tmp(), { pa: { provider: a.provider, tools: contract({ fallback: ["pb.render"], errorsAreRejections: true }) }, pb: { provider: b.provider, tools: contract() } });
    const out = await m.call("pa.render", {});
    expect(out).toMatchObject({ status: "ok", tool: "pb.render" });
    expect(b.state.accepted).toBe(1);
    expect(m.budget.spent().day).toBe(0.4); // only the fallback's real charge
    expect(m.jobs.list()[0].costEstimated).toBeUndefined();
  });

  it("a free tool (costUsd 0) keeps isError = rejected", async () => {
    const a = errorResultProvider();
    const m = await boot(tmp(), { pa: { provider: a.provider, tools: contract({ costUsd: 0 }) } });
    await m.call("pa.render", {});
    const [job] = m.jobs.list();
    expect(job.status).toBe("failed");
    expect(job.costEstimated).toBeUndefined();
    expect(m.budget.spent().day).toBe(0);
  });

  it("errorsAreRejections is an allowed, boolean-only contract key", () => {
    const ok = MycelConfig.safeParse({ servers: { s: { command: "x", tools: { t: { errorsAreRejections: true } } } } });
    expect(ok.success).toBe(true);
    expect(MycelConfig.safeParse({ servers: { s: { command: "x", tools: { t: { errorsAreRejections: "yes" } } } } }).success).toBe(false);
    const bad = MycelConfig.safeParse({ servers: { s: { command: "x", tools: { t: { errorsAreRejection: true } } } } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("errorsAreRejections");
  });
});

describe("price persisted at dispatch", () => {
  it("estCostUsd is stored on the job when dispatched", async () => {
    const home = tmp();
    const h = holdingProvider();
    const m = await boot(home, { pa: { provider: h.provider, tools: contract() } });
    m.call("pa.render", {}, { mode: "async" });
    await until(() => h.state.accepted === 1);
    expect(JSON.parse(readFileSync(join(home, "jobs.json"), "utf8"))[0]).toMatchObject({ status: "running", estCostUsd: 0.4 });
  });

  it("restart while the paid tool's upstream is missing: interrupted, estimate charged once, no 'declares no cost'", async () => {
    const home = tmp();
    const id = persistJob(home, { status: "running", attempts: 1, dispatchedAt: new Date().toISOString(), dispatchedTool: "pa.render", estCostUsd: 0.4 });
    const m = await boot(home, {});
    const job = m.jobs.get(id)!;
    expect(job).toMatchObject({ status: "interrupted", costUsd: 0.4, costEstimated: true });
    expect(job.error).not.toMatch(/declares no cost/);
    expect(job.error).toMatch(/\$0\.4/);
    expect(m.budget.spent().day).toBe(0.4);
    await m.close();
    expect((await boot(home, {})).budget.spent().day).toBe(0.4);
  });

  it("charges the dispatch-time price, not the current catalog price", async () => {
    const home = tmp();
    const id = persistJob(home, { status: "running", attempts: 1, dispatchedAt: new Date().toISOString(), dispatchedTool: "pa.render", estCostUsd: 0.4 });
    const m = await boot(home, { pa: { provider: paidProvider().provider, tools: contract({ costUsd: 0.9 }) } });
    expect(m.jobs.get(id)).toMatchObject({ costUsd: 0.4, costEstimated: true });
    expect(m.budget.spent().day).toBe(0.4);
  });

  it("an idempotent job that was dispatched before the restart and then fails because its upstream is missing is charged the estimate once", async () => {
    const home = tmp();
    const id = persistJob(home, { status: "running", idempotent: true, attempts: 1, dispatchedAt: new Date().toISOString(), dispatchedTool: "pa.render", estCostUsd: 0.4 });
    const m = await boot(home, {});
    const job = await m.jobs.wait(id, 3000);
    expect(job.status).toBe("failed");
    expect(job).toMatchObject({ costUsd: 0.4, costEstimated: true });
    expect(job.error).toMatch(/may have been accepted/);
    expect(m.budget.spent().day).toBe(0.4);
  });
});

describe("cancel after dispatch", () => {
  it("charges the estimate once and says the provider may have charged", async () => {
    const home = tmp();
    const h = holdingProvider();
    const m = await boot(home, { pa: { provider: h.provider, tools: contract() } });
    const r = await m.call("pa.render", {}, { mode: "async" });
    const id = (r as { job: { id: string } }).job.id;
    await until(() => h.state.accepted === 1);
    const j = m.jobs.cancel(id);
    await new Promise((r2) => setTimeout(r2, 100));
    expect(j).toMatchObject({ status: "cancelled", costUsd: 0.4, costEstimated: true });
    expect(m.jobView(j).message).toMatch(/may have been accepted and charged/);
    expect(m.budget.spent().day).toBe(0.4);
    m.jobs.cancel(id); // idempotent
    expect(m.budget.spent().day).toBe(0.4);
    expect(h.state.receipts).toBe(1);
  });

  it("cancelling a queued job that never dispatched costs nothing", async () => {
    const m = await boot(tmp(), { pa: { provider: holdingProvider().provider, tools: contract() } }, { jobs: { concurrency: 1, asyncThresholdMs: 3000 } });
    await m.call("pa.render", {}, { mode: "async" }); // occupies the only slot
    const second = (await m.call("pa.render", {}, { mode: "async" })) as { job: { id: string } };
    expect(m.jobs.cancel(second.job.id)).toMatchObject({ status: "cancelled", costUsd: 0 });
    expect(m.budget.spent().day).toBe(0);
  });
});

describe("idempotency key", () => {
  const kc = (extra: Record<string, unknown> = {}) => contract({ idempotent: true, idempotencyKeyArg: "requestId", ...extra });

  it("kill-and-resume an idempotent job with idempotencyKeyArg: the same key is sent, provider sees one receipt", async () => {
    const home1 = tmp();
    const seen = new Set<string>(); // the provider's own dedup memory
    const h1 = holdingProvider("requestId", seen);
    const m1 = await boot(home1, { pa: { provider: h1.provider, tools: kc() } });
    await m1.call("pa.render", { prompt: "x" }, { mode: "async" });
    await until(() => h1.state.accepted === 1);
    const persisted = JSON.parse(readFileSync(join(home1, "jobs.json"), "utf8"))[0];
    expect(persisted.idempotencyKey).toMatch(/^mycel-job_/);
    expect(h1.state.args[0]).toMatchObject({ prompt: "x", requestId: persisted.idempotencyKey });
    // "kill": a second gateway starts from the same jobs.json while the first request is still unanswered
    const home2 = tmp();
    writeFileSync(join(home2, "jobs.json"), JSON.stringify([persisted]));
    const h2 = holdingProvider("requestId", seen);
    h2.release();
    const m2 = await boot(home2, { pa: { provider: h2.provider, tools: kc() } });
    const job = await m2.jobs.wait(persisted.id, 3000);
    expect(job.status).toBe("succeeded");
    expect(h2.state.args[0].requestId).toBe(persisted.idempotencyKey);
    expect(h1.state.receipts + h2.state.receipts).toBe(1);
  });

  it("without idempotencyKeyArg the same resume produces a second receipt", async () => {
    const seen = new Set<string>();
    const h1 = holdingProvider("requestId", seen);
    const home1 = tmp();
    const m1 = await boot(home1, { pa: { provider: h1.provider, tools: contract({ idempotent: true }) } });
    await m1.call("pa.render", {}, { mode: "async" });
    await until(() => h1.state.accepted === 1);
    const persisted = JSON.parse(readFileSync(join(home1, "jobs.json"), "utf8"))[0];
    expect(persisted.idempotencyKey).toBeUndefined();
    const home2 = tmp();
    writeFileSync(join(home2, "jobs.json"), JSON.stringify([persisted]));
    const h2 = holdingProvider("requestId", seen);
    h2.release();
    await (await boot(home2, { pa: { provider: h2.provider, tools: contract({ idempotent: true }) } })).jobs.wait(persisted.id, 3000);
    expect(h1.state.receipts + h2.state.receipts).toBe(2);
  });

  it("never overwrites a caller-provided value", async () => {
    const h = holdingProvider("requestId");
    h.release();
    const m = await boot(tmp(), { pa: { provider: h.provider, tools: kc() } });
    await m.call("pa.render", { requestId: "mine" });
    expect(h.state.args[0].requestId).toBe("mine");
  });

  it("the key is stable across retries within a job", async () => {
    let n = 0;
    const keys: unknown[] = [];
    const provider: ToolProvider = {
      listTools: async () => [{ name: "render", description: "Render", inputSchema: { type: "object", properties: {} } }],
      callTool: async (_n, args) => {
        keys.push(args.requestId);
        if (++n < 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
    const m = await boot(tmp(), { pa: { provider, tools: kc({ retries: 3 }) } });
    const out = await m.call("pa.render", {});
    expect(out.status).toBe("ok");
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("idempotencyKeyArg is an allowed string key", () => {
    expect(MycelConfig.safeParse({ servers: { s: { command: "x", tools: { t: { idempotencyKeyArg: "requestId" } } } } }).success).toBe(true);
    expect(MycelConfig.safeParse({ servers: { s: { command: "x", tools: { t: { idempotencyKeyArg: 3 } } } } }).success).toBe(false);
  });
});

describe("call error classification", () => {
  it("only positively identified rejections are rejected", () => {
    expect(dispositionOf(new CallError("x", "rejected"))).toBe("rejected");
    expect(dispositionOf(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe("rejected");
    expect(dispositionOf(new Error("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }))).toBe("rejected");
    expect(dispositionOf(new Error("Not connected"))).toBe("rejected");
    expect(dispositionOf(new McpError(ErrorCode.InvalidParams, "bad args"))).toBe("rejected");
    expect(dispositionOf(new McpError(ErrorCode.InternalError, "boom"))).toBe("rejected");
    expect(dispositionOf(new McpError(ErrorCode.RequestTimeout, "timed out"))).toBe("unknown");
    expect(dispositionOf(new McpError(ErrorCode.ConnectionClosed, "closed"))).toBe("unknown");
    expect(dispositionOf(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("unknown");
    expect(dispositionOf(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe("unknown");
    expect(dispositionOf(new Error("something odd"))).toBe("unknown");
    expect(dispositionOf("string")).toBe("unknown");
  });
});

describe("headless approval", () => {
  const cfg = { policy: [{ match: { effect: "write" }, action: "approve" }] };
  const tools = { pa: { provider: paidProvider().provider, tools: { render: { effect: "write", async: false } } } };

  it("with no approver, approval_required says so and quotes the policy rule that pre-approves", async () => {
    const m = await boot(tmp(), tools, cfg);
    const out = await m.call("pa.render", {});
    expect(out.status).toBe("approval_required");
    const o = out as { how: string; approverAvailable: boolean };
    expect(o.approverAvailable).toBe(false);
    expect(o.how).toContain("no approver is available in this client (non-interactive)");
    expect(o.how).toContain("policy:");
    expect(o.how).toContain('match: { tool: "pa.render" }');
    expect(o.how).toContain("action: allow");
    expect(o.how).toContain("above policy rule #1");
    expect(o.how).toContain("mycel approve apv_");
  });

  it("an interactive client that declines is reported as denied by the user", async () => {
    const m = await boot(tmp(), tools, cfg);
    const out = await m.call("pa.render", {}, { elicit: async () => false });
    expect(out).toMatchObject({ status: "denied" });
    expect((out as { reason: string }).reason).toMatch(/^Denied by the user/);
  });

  it("an approval denied out of band is reported as denied by the user", async () => {
    const m = await boot(tmp(), tools, cfg);
    const first = (await m.call("pa.render", {})) as { approval: string };
    m.approvals.decide(first.approval, false);
    const out = await m.call("pa.render", {}, { approval: first.approval });
    expect(out.status).toBe("denied");
    expect((out as { reason: string }).reason).toMatch(/^Denied by the user/);
  });

  it("a pre-approving allow rule really lets the call through", async () => {
    const m = await boot(tmp(), tools, { policy: [{ match: { tool: "pa.render" }, action: "allow" }, ...cfg.policy] });
    expect((await m.call("pa.render", {})).status).toBe("ok");
  });
});
