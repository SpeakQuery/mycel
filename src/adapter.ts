import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Effect } from "./config.js";
import type { ToolProvider, UpstreamToolResult } from "./upstream.js";

export interface AdapterTool<A = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  input?: Record<string, unknown>;
  effect?: Effect;
  /** Long-running (video, render…) → Mycel runs it as a job. */
  async?: boolean;
  costUsd?: number;
  run(args: A, ctx: { progress: (done: number, total?: number, message?: string) => void; signal?: AbortSignal }): Promise<unknown>;
}

/** Binary output helper: return `file(buffer, "video/mp4", "clip.mp4")` from run(). */
export function file(bytes: Buffer, mimeType: string, name?: string) {
  return { __mycelFile: true as const, bytes, mimeType, name };
}

function toResult(v: unknown): UpstreamToolResult {
  if (v && typeof v === "object" && (v as { __mycelFile?: boolean }).__mycelFile) {
    const f = v as ReturnType<typeof file>;
    if (f.mimeType.startsWith("image/")) return { content: [{ type: "image", data: f.bytes.toString("base64"), mimeType: f.mimeType }] };
    return { content: [{ type: "resource", resource: { uri: `file:///${f.name ?? "output"}`, mimeType: f.mimeType, blob: f.bytes.toString("base64") } }] };
  }
  return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] };
}

const annotationsFor = (e?: Effect) =>
  e === "read" ? { readOnlyHint: true } : e === "destructive" ? { readOnlyHint: false, destructiveHint: true } : e === "external" ? { readOnlyHint: false, destructiveHint: false, openWorldHint: true } : e === "write" ? { readOnlyHint: false, destructiveHint: false } : undefined;

/**
 * Write a provider adapter (a new video model, an internal API…) in a few lines.
 * The same definition works in-process (`.provider`) or as a stdio MCP server (`.serve()`),
 * so it also works with any MCP client, with or without Mycel.
 */
export function defineAdapter(def: { name: string; version?: string; tools: AdapterTool<any>[] }) {
  const byName = new Map(def.tools.map((t) => [t.name, t]));
  const list = () =>
    def.tools.map((t) => ({
      name: t.name,
      description: t.description + (t.async ? " (long-running)" : "") + (t.costUsd ? ` Cost ≈ $${t.costUsd}.` : ""),
      inputSchema: t.input ?? { type: "object", properties: {} },
      ...(annotationsFor(t.effect) ? { annotations: annotationsFor(t.effect) } : {}),
    }));

  const provider: ToolProvider = {
    listTools: async () => list(),
    callTool: async (name, args, opts) => {
      const t = byName.get(name);
      if (!t) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
      try {
        return toResult(await t.run(args, { progress: (p, total, message) => opts.onProgress?.({ progress: p, total, message }), signal: opts.signal }));
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  };

  /** Contract overrides to paste into mycel.yaml (servers.<name>.tools). */
  const contracts = Object.fromEntries(def.tools.map((t) => [t.name, { ...(t.effect ? { effect: t.effect } : {}), ...(t.async ? { async: true } : {}), ...(t.costUsd ? { costUsd: t.costUsd } : {}) }]));

  async function serve() {
    const server = new Server({ name: def.name, version: def.version ?? "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list() }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const token = req.params._meta?.progressToken;
      return (await provider.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, {
        signal: extra.signal,
        onProgress: token !== undefined ? (p) => void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, ...p } }) : undefined,
      })) as never;
    });
    await server.connect(new StdioServerTransport());
  }

  return { name: def.name, provider, contracts, serve };
}
