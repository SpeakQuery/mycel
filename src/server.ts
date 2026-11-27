import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Mycel, CallContext } from "./core.js";
import { META_TOOLS } from "./meta.js";
import { estimateTokens, type ToolEntry } from "./catalog.js";
import { newId } from "./recorder.js";

const VERSION = "0.1.4";

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
    m.recorder.record({ traceId, kind: "session", ok: true, tokensToModel: shown, tokensSaved: Math.max(0, fp.directTokens - shown), meta: { event: "tools/list", exposed: tools.length, catalog: fp.tools } });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = req.params._meta?.progressToken;
    const caps = server.getClientCapabilities();
    const ctx: CallContext = {
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
    try {
      const meta = exposedMeta().find((t) => t.name === name);
      let result: unknown;
      if (meta) result = await meta.handler(args, ctx);
      else {
        const t = m.catalog.all().find((x) => directName(x) === name);
        if (!t) throw new Error(`Unknown tool ${name}`);
        result = await m.call(t.id, args, ctx);
      }
      const isError = !!result && typeof result === "object" && ["error", "denied"].includes((result as { status?: string }).status ?? "");
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], isError };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  return server;
}
