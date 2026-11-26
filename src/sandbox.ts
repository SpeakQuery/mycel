import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten";

/** Host operations a script may perform. Every one goes through Mycel's trust layer. */
export interface HostApi {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  search(query: string, limit?: number): Promise<unknown>;
  refRead(id: string, opts?: Record<string, unknown>): Promise<unknown>;
  refPut(value: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  jobSubmit(tool: string, args: Record<string, unknown>): Promise<unknown>;
  jobWait(id: string, timeoutMs?: number): Promise<unknown>;
  ask?(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface RunResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  toolCalls: number;
  durationMs: number;
}

let modulePromise: Promise<QuickJSWASMModule> | null = null;
const loadQuickJS = () => (modulePromise ??= getQuickJS());

/**
 * Prelude evaluated inside the sandbox. The only bridge to the outside world is
 * `__host(op, json)`, which returns a Promise of a JSON string.
 */
const PRELUDE = `
const __j = (op, ...a) => __host(op, JSON.stringify(a)).then((s) => (s === undefined ? undefined : JSON.parse(s)));
const tools = {
  call: (id, args = {}) => __j("call", id, args),
  search: (q, limit) => __j("search", q, limit),
};
const refs = {
  read: (id, opts) => __j("refRead", id, opts),
  put: (value, opts) => __j("refPut", value, opts),
};
const jobs = {
  submit: (tool, args = {}) => __j("jobSubmit", tool, args),
  wait: (id, timeoutMs) => __j("jobWait", id, timeoutMs),
  run: async (tool, args = {}, timeoutMs) => { const j = await jobs.submit(tool, args); return jobs.wait(j.id, timeoutMs); },
};
const ask = (prompt, opts) => __j("ask", prompt, opts);
const __fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
const console = {
  log: (...a) => __log(a.map(__fmt).join(" ")),
  info: (...a) => __log(a.map(__fmt).join(" ")),
  warn: (...a) => __log("[warn] " + a.map(__fmt).join(" ")),
  error: (...a) => __log("[error] " + a.map(__fmt).join(" ")),
};
const sleep = (ms) => __j("sleep", ms);
const daysSince = (d) => (Date.now() - new Date(d).getTime()) / 86400000;
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
`;

/**
 * Code Mode: run a model-written script in a QuickJS WebAssembly sandbox.
 * No filesystem, no network, no Node APIs — only the HostApi bridge.
 * CPU time, memory and number of tool calls are capped.
 */
export async function runScript(
  code: string,
  host: HostApi,
  limits: { timeoutMs: number; memoryMb: number; maxToolCalls: number },
): Promise<RunResult> {
  const QuickJS = await loadQuickJS();
  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const ctx = runtime.newContext();
  const logs: string[] = [];
  let toolCalls = 0;
  let disposed = false;
  const pending = new Set<Promise<unknown>>();

  const pump = () => {
    if (disposed) return;
    const r = runtime.executePendingJobs();
    if (r.error) r.error.dispose();
  };

  try {
    const logFn = ctx.newFunction("__log", (h) => {
      if (logs.length < 500) logs.push(String(ctx.getString(h)).slice(0, 2000));
    });
    ctx.setProp(ctx.global, "__log", logFn);
    logFn.dispose();

    const hostFn = ctx.newFunction("__host", (opH, argsH) => {
      const op = ctx.getString(opH);
      const args = JSON.parse(ctx.getString(argsH)) as unknown[];
      const deferred = ctx.newPromise();
      const task = (async () => {
        if (["call", "jobSubmit"].includes(op) && ++toolCalls > limits.maxToolCalls) {
          throw new Error(`Tool call limit (${limits.maxToolCalls}) exceeded`);
        }
        switch (op) {
          case "call":
            return host.call(String(args[0]), (args[1] ?? {}) as Record<string, unknown>);
          case "search":
            return host.search(String(args[0]), args[1] as number | undefined);
          case "refRead":
            return host.refRead(String(args[0]), args[1] as Record<string, unknown>);
          case "refPut":
            return host.refPut(args[0], args[1] as Record<string, unknown>);
          case "jobSubmit":
            return host.jobSubmit(String(args[0]), (args[1] ?? {}) as Record<string, unknown>);
          case "jobWait":
            return host.jobWait(String(args[0]), args[1] as number | undefined);
          case "ask":
            if (!host.ask) throw new Error("No model router configured (add `models:` to mycel.yaml)");
            return host.ask(String(args[0]), args[1] as Record<string, unknown>);
          case "sleep":
            await new Promise((r) => setTimeout(r, Math.min(Number(args[0]) || 0, Math.max(0, deadline - Date.now()))));
            return undefined;
          default:
            throw new Error(`Unknown host op ${op}`);
        }
      })();
      pending.add(task);
      task
        .then(
          (v) => {
            if (disposed) return;
            const s = v === undefined ? ctx.undefined : ctx.newString(JSON.stringify(v));
            deferred.resolve(s);
            if (s !== ctx.undefined) s.dispose();
          },
          (e: unknown) => {
            if (disposed) return;
            const err = ctx.newError(e instanceof Error ? e.message : String(e));
            deferred.reject(err);
            err.dispose();
          },
        )
        .finally(() => {
          pending.delete(task);
          pump();
        });
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__host", hostFn);
    hostFn.dispose();

    const pre = ctx.evalCode(PRELUDE, "prelude.js");
    ctx.unwrapResult(pre).dispose();

    const wrapped = `(async () => {\n${code}\n})()`;
    const evalRes = ctx.evalCode(wrapped, "script.js");
    if (evalRes.error) {
      const err = ctx.dump(evalRes.error);
      evalRes.error.dispose();
      return { ok: false, error: formatError(err), logs, toolCalls, durationMs: Date.now() - started };
    }
    const promiseHandle: QuickJSHandle = evalRes.value;
    const settled = ctx.resolvePromise(promiseHandle);
    pump();
    promiseHandle.dispose();

    const timeout = new Promise<"timeout">((r) => {
      const t = setTimeout(() => r("timeout"), Math.max(0, deadline - Date.now()) + 50);
      t.unref?.();
    });
    const outcome = await Promise.race([settled, timeout]);
    if (outcome === "timeout") {
      return { ok: false, error: `Script exceeded ${limits.timeoutMs}ms`, logs, toolCalls, durationMs: Date.now() - started };
    }
    if (outcome.error) {
      const err = ctx.dump(outcome.error);
      outcome.error.dispose();
      return { ok: false, error: formatError(err), logs, toolCalls, durationMs: Date.now() - started };
    }
    const value = ctx.dump(outcome.value);
    outcome.value.dispose();
    return { ok: true, value, logs, toolCalls, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: (e as Error).message, logs, toolCalls, durationMs: Date.now() - started };
  } finally {
    disposed = true;
    try {
      ctx.dispose();
      runtime.dispose();
    } catch {
      /* handles leaked by an aborted script; the runtime is gone either way */
    }
  }
}

function formatError(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { name?: string; message?: string; stack?: string };
    const where = o.stack?.split("\n").find((l) => l.includes("script.js"));
    return `${o.name ?? "Error"}: ${o.message ?? JSON.stringify(e)}${where ? ` (${where.trim()})` : ""}`;
  }
  return String(e);
}

export type { QuickJSContext };
