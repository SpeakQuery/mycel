import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Mycel, CallContext } from "./core.js";
import { META_TOOLS } from "./meta.js";
import { estimateTokens, type ToolEntry } from "./catalog.js";
import { newId, type EventKind } from "./recorder.js";
import type { SavingsMeta } from "./savings.js";

const VERSION = "0.1.7";

/** MCP tool names must be [a-zA-Z0-9_-]; direct tools are exposed as `server__tool`. */
export const directName = (t: ToolEntry) => `${t.server}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

/**
 * Build the MCP server that clients (Claude, Cursor, VS Code, …) connect to.
 * One Server instance per client session.
 */
export function createMcpServer(m: Mycel, session: { capability?: CallContext["capability"]; agent?: string } = {}): Server {
  const server = new Server(
    { name: "mycel", version: VERSION, title: "Mycel gateway" } as { name: string; version: string },
    { capabilities: { tools: { listChanged: true } }, instructions: m.instructions() },
  );
  const traceId = newId();

  const directTools = (): ToolEntry[] => {
    const mode = m.routerMode();
    if (mode === "passthrough" || mode === "compact") return m.catalog.all();
    if (mode === "hybrid") {
      const usage = m.recorder.historicalStats(14).byTool;
      return m.catalog
        .all()
        .sort((a, b) => (usage[b.id]?.calls ?? 0) - (usage[a.id]?.calls ?? 0))
        .slice(0, m.config.router.hybridTop);
    }
    return [];
  };

  /** Meta-tools exposed in the current mode. Compact mode keeps only what direct tools can't do. */
  const exposedMeta = () => {
    const mode = m.routerMode();
    if (mode === "passthrough") return [];
    const all = META_TOOLS(m);
    return mode === "compact" ? all.filter((t) => ["mycel_run", "mycel_ref", "mycel_job"].includes(t.name)) : all;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const meta = exposedMeta();
    const direct = directTools();
    const tools = [
      ...meta.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
      ...direct.map((t) => ({ name: directName(t), description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
    ];
    const fp = m.contextFootprint();
    const shown = estimateTokens(tools) + estimateTokens(m.instructions());
    const perTurn = Math.max(0, fp.directTokens - shown);
    m.savings.noteToolsList(perTurn); // ESTIMATED: counted once per tools/list served, not per model turn
    m.recorder.record({ traceId, kind: "session", ok: true, tokensToModel: shown, savings: { session: m.sessionId, estimated: { perTurnTokens: perTurn, basis: "tools/list" } }, meta: { event: "tools/list", exposed: tools.length, catalog: fp.tools } });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = req.params._meta?.progressToken;
    const caps = server.getClientCapabilities();
    let savings: SavingsMeta | undefined;
    const ctx: CallContext = {
      onSavings: (s) => {
        savings = s;
      },
      traceId,
      capability: session.capability,
      agent: session.agent,
      signal: extra.signal,
      onProgress: progressToken !== undefined
        ? (p) => void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: p.progress, total: p.total, message: p.message } })
        : undefined,
      elicit: caps?.elicitation
        ? async (message) => {
            try {
              const r = await server.elicitInput({
                mode: "form",
                message,
                requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve this action?" } }, required: ["approve"] },
              } as never);
              if (r.action !== "accept") return false;
              return (r.content as { approve?: boolean } | undefined)?.approve === true;
            } catch {
              return undefined; // client couldn't elicit → fall back to out-of-band approval
            }
          }
        : undefined,
    };
    const t0 = Date.now();
    const metaKind: Record<string, EventKind> = { mycel_search: "search", mycel_describe: "describe", mycel_call: "call", mycel_run: "run", mycel_ref: "ref", mycel_job: "job", mycel_delegate: "a2a", mycel_ask: "ask" };
    try {
      const meta = exposedMeta().find((t) => t.name === name);
      let result: unknown;
      if (meta) {
        result = await meta.handler(args, ctx);
        // describe / ref / job reads have no event of their own in core: record size and ids only, never content or arguments.
        if (name === "mycel_describe" || name === "mycel_ref" || name === "mycel_job") {
          const ids = name === "mycel_describe" ? (Array.isArray(args.tools) ? args.tools : [args.tool ?? args.tools]).filter((x) => typeof x === "string").slice(0, 10) : undefined;
          const failed = !!result && typeof result === "object" && ["error", "denied"].includes((result as { status?: string }).status ?? "");
          m.recorder.record({ traceId, kind: metaKind[name], tool: name, ok: !failed, durationMs: Date.now() - t0, tokensToModel: estimateTokens(result), agent: session.agent, meta: { action: args.action ?? (name === "mycel_ref" ? (args.ref ? "read" : "list") : undefined), ...(typeof args.ref === "string" ? { ref: args.ref.slice(0, 40) } : {}), ...(typeof args.id === "string" ? { id: args.id.slice(0, 40) } : {}), ...(ids ? { tools: ids } : {}) } });
        }
      }
      else {
        const t = m.catalog.all().find((x) => directName(x) === name);
        if (!t) throw new Error(`Unknown tool ${name}`);
        result = await m.call(t.id, args, ctx);
      }
      const isError = !!result && typeof result === "object" && ["error", "denied"].includes((result as { status?: string }).status ?? "");
      const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
      // Opt-in (ui.savingsLine): the one-line summary as a last text block, visible to the model. ~30-40 tokens per call.
      if (savings && m.config.ui.savingsLine && !isError) content.push({ type: "text", text: savings.line });
      return { content, isError, ...(savings ? { _meta: { "mycel/savings": savings } } : {}) };
    } catch (e) {
      // Every request that reaches Mycel leaves a trace, including meta-tool and unknown-tool failures.
      m.recorder.record({ traceId, kind: metaKind[name] ?? "call", tool: name, ok: false, durationMs: Date.now() - t0, error: m.vault.scrub((e as Error).message).slice(0, 500), agent: session.agent });
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  return server;
}
