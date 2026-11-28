import { randomUUID } from "node:crypto";
import type { Mycel, CallContext, CallOutcome } from "./core.js";
import type { A2AMessage, A2ATask, AgentCard, Part, TaskState } from "./a2a-client.js";

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

const TERMINAL: TaskState[] = ["completed", "canceled", "failed", "rejected"];

/** Tasks belong to whoever created them: a capability token id, or the local operator. */
const ownerOf = (ctx: CallContext) => (ctx.capability ? `cap:${ctx.capability.id}` : `local:${ctx.agent ?? "a2a"}`);

interface Pending {
  kind: "call";
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A2A server: Mycel speaks Agent2Agent so other agents can use everything
 * behind it — with the same policy, budget, taint and recording as MCP clients.
 *
 * Message parts Mycel understands:
 *   {kind:"data", data:{tool, args}}        → call a tool
 *   {kind:"data", data:{code}}              → run a code-mode script
 *   {kind:"data", data:{search, limit?}}    → search the catalog
 *   {kind:"data", data:{approval}} + taskId → resume a call a human approved
 *   {kind:"text", text}                     → JSON of the above, or a search query
 */
export class A2AServer {
  private tasks = new Map<string, { task: A2ATask; pending?: Pending; job?: string; ctx: CallContext; owner: string }>();

  private own(id: unknown, ctx: CallContext) {
    const t = this.tasks.get(String(id));
    // Unknown and foreign tasks look the same, so ids can't be probed.
    if (!t || t.owner !== ownerOf(ctx)) throw new RpcError(-32001, "Task not found");
    return t;
  }
  constructor(private m: Mycel) {}

  card(baseUrl: string): AgentCard {
    const ov = this.m.catalog.overview();
    return {
      protocolVersion: "0.3.0",
      name: this.m.config.a2a.name,
      description: this.m.config.a2a.description,
      url: new URL("/a2a", baseUrl).toString(),
      version: "0.2.0",
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json", "text/plain"],
      skills: [
        { id: "search", name: "Search tools", description: `Search ${this.m.catalog.size} tools. Send {"search":"query"}.`, tags: ["discovery"] },
        { id: "code-mode", name: "Run a script", description: 'Chain many tool calls in one sandboxed script. Send {"code":"return await tools.call(...)"}.', tags: ["orchestration"] },
        ...ov.map((s) => ({ id: s.server, name: s.server, description: `${s.tools} tools, e.g. ${s.sample.slice(0, 4).join(", ")}. Send {"tool":"${s.server}.<name>","args":{...}}.`, tags: Object.keys(s.effects) })),
      ],
      securitySchemes: { mycel: { type: "http", scheme: "bearer", description: "Mycel capability token (myc1.…)" } },
      security: [{ mycel: [] }],
    };
  }

  async handle(body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }, ctx: CallContext): Promise<unknown> {
    const id = body.id ?? null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (body.method) {
        case "message/send":
          return ok(await this.send(body.params?.message as A2AMessage, ctx));
        case "tasks/get": {
          const t = this.own(body.params?.id, ctx);
          await this.refresh(t);
          return ok(t.task);
        }
        case "tasks/cancel": {
          const t = this.own(body.params?.id, ctx);
          await this.refresh(t);
          if (TERMINAL.includes(t.task.status.state)) return fail(-32002, `Task is ${t.task.status.state} and cannot be canceled`);
          if (t.job) this.m.jobs.cancel(t.job);
          t.pending = undefined;
          this.setState(t.task, "canceled");
          return ok(t.task);
        }
        default:
          return fail(-32601, `Method not found: ${body.method}`);
      }
    } catch (e) {
      return fail(e instanceof RpcError ? e.code : -32603, (e as Error).message);
    }
  }

  private async send(msg: A2AMessage, ctx: CallContext): Promise<A2ATask> {
    if (!msg?.parts?.length) throw new Error("message.parts is required");
    const intent = parseIntent(msg.parts);
    const contextId = msg.contextId ?? randomUUID();

    // Resuming an existing task (e.g. after approval).
    if (msg.taskId) {
      const t = this.own(msg.taskId, ctx);
      const expected = t.task.metadata?.approval;
      if (t.task.status.state !== "input-required" || !t.pending || !expected) throw new RpcError(-32002, `Task is ${t.task.status.state}; nothing to resume`);
      if (intent.approval !== expected) throw new RpcError(-32602, "Approval id does not match this task");
      // Run with the resuming caller's (same owner's) current rights, not a stored context.
      const out = await this.m.call(t.pending.tool, t.pending.args, { ...ctx, approval: intent.approval });
      this.apply(t, out);
      return t.task;
    }

    const task: A2ATask = { kind: "task", id: randomUUID(), contextId, status: { state: "working", timestamp: new Date().toISOString() }, history: [msg] };
    const entry: { task: A2ATask; pending?: Pending; job?: string; ctx: CallContext; owner: string } = { task, ctx, owner: ownerOf(ctx) };
    this.tasks.set(task.id, entry);
    if (this.tasks.size > 1000) this.tasks.delete(this.tasks.keys().next().value!);

    if (intent.tool) {
      entry.pending = { kind: "call", tool: intent.tool, args: intent.args ?? {} };
      this.apply(entry, await this.m.call(intent.tool, intent.args ?? {}, ctx));
    } else if (intent.code) {
      const r = await this.m.run(intent.code, ctx);
      if (r.ok) this.complete(task, r.result);
      else this.fail(task, r.error ?? "script failed");
    } else {
      const q = intent.search ?? "";
      this.complete(task, { tools: this.m.search(q, { limit: intent.limit ?? 8 }, ctx), hint: 'Call one with {"tool":"<id>","args":{...}}' });
    }
    return task;
  }

  private apply(t: { task: A2ATask; job?: string }, out: CallOutcome) {
    switch (out.status) {
      case "ok":
        return this.complete(t.task, out.result);
      case "job":
        t.job = out.job.id;
        t.task.metadata = { job: out.job.id };
        return this.setState(t.task, "working", { text: `Running as job ${out.job.id}. Poll tasks/get.` });
      case "approval_required":
        t.task.metadata = { approval: out.approval };
        return this.setState(t.task, "input-required", { text: `Human approval required: ${out.reason.replace(/\.$/, "")}. Once approved, send {"approval":"${out.approval}"} with this taskId.` });
      case "denied":
        return this.setState(t.task, "rejected", { text: out.reason });
      case "error":
        return this.fail(t.task, out.error);
      case "estimate":
        return this.complete(t.task, out);
    }
  }

  private async refresh(t: { task: A2ATask; job?: string }) {
    if (!t.job || t.task.status.state !== "working") return;
    const j = this.m.jobs.get(t.job);
    if (!j) return;
    if (j.status === "succeeded") this.complete(t.task, this.m.jobView(j).result);
    else if (j.status === "failed" || j.status === "interrupted" || j.status === "unknown") this.fail(t.task, j.error ?? "job failed");
    else if (j.status === "cancelled") this.setState(t.task, "canceled");
    else this.setState(t.task, "working", { text: `Job ${j.id}: ${j.status}${j.progress !== undefined ? ` ${j.progress}/${j.total ?? "?"}` : ""}${j.message ? ` — ${j.message}` : ""}` });
  }

  private complete(task: A2ATask, value: unknown) {
    task.artifacts = [{ artifactId: randomUUID(), name: "result", parts: [toPart(value)] }];
    this.setState(task, "completed");
  }

  private fail(task: A2ATask, error: string) {
    this.setState(task, "failed", { text: error });
  }

  private setState(task: A2ATask, state: TaskState, msg?: { text: string }) {
    if (TERMINAL.includes(state)) {
      const e = this.tasks.get(task.id);
      if (e) e.pending = undefined;
    }
    task.status = {
      state,
      timestamp: new Date().toISOString(),
      ...(msg ? { message: { kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text: msg.text }], taskId: task.id, contextId: task.contextId } } : {}),
    };
  }
}

function toPart(v: unknown): Part {
  return typeof v === "string" ? { kind: "text", text: v } : { kind: "data", data: v };
}

function parseIntent(parts: Part[]): { tool?: string; args?: Record<string, unknown>; code?: string; search?: string; limit?: number; approval?: string } {
  for (const p of parts) {
    let d: unknown;
    if (p.kind === "data") d = p.data;
    else if (p.kind === "text") {
      const t = p.text.trim();
      if (t.startsWith("{")) {
        try {
          d = JSON.parse(t);
        } catch {
          /* plain text */
        }
      }
      if (d === undefined) return { search: t };
    }
    if (d && typeof d === "object") {
      const o = d as Record<string, unknown>;
      return {
        tool: o.tool as string | undefined,
        args: o.args as Record<string, unknown> | undefined,
        code: o.code as string | undefined,
        search: o.search as string | undefined,
        limit: o.limit as number | undefined,
        approval: o.approval as string | undefined,
      };
    }
  }
  return {};
}
