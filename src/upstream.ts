import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolve } from "node:path";
import { isStdio, type ServerConfig } from "./config.js";
import { hashDefinition, type ToolEntry } from "./catalog.js";
import { inferContract, type ToolAnnotations } from "./contracts.js";
import type { SecretVault } from "./secrets.js";

export interface UpstreamToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface Upstream {
  name: string;
  status: "connecting" | "ready" | "error" | "disabled";
  error?: string;
  tools: ToolEntry[];
  call(tool: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; onProgress?: (p: { progress: number; total?: number; message?: string }) => void; timeoutMs?: number }): Promise<UpstreamToolResult>;
  close(): Promise<void>;
}

/** Anything that can serve tools: a real MCP server, or an in-process provider (tests, adapters). */
export interface ToolProvider {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: ToolAnnotations }>>;
  callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; onProgress?: (p: { progress: number; total?: number; message?: string }) => void; timeoutMs?: number }): Promise<UpstreamToolResult>;
  close?(): Promise<void>;
}

export function toEntries(server: string, cfg: Pick<ServerConfig, "trust" | "tools">, tools: Awaited<ReturnType<ToolProvider["listTools"]>>): ToolEntry[] {
  return tools.map((t) => ({
    id: `${server}.${t.name}`,
    server,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    outputSchema: t.outputSchema,
    annotations: t.annotations,
    contract: inferContract(t.name, t.description, t.annotations, cfg.tools?.[t.name]),
    trust: cfg.trust,
    hash: hashDefinition(t),
  }));
}

/** Wrap an MCP SDK client as a ToolProvider. */
export class McpProvider implements ToolProvider {
  private client: Client;
  constructor(client: Client) {
    this.client = client;
  }
  async listTools() {
    const all: Awaited<ReturnType<ToolProvider["listTools"]>> = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.listTools(cursor ? { cursor } : {});
      all.push(...(res.tools as typeof all));
      cursor = res.nextCursor;
    } while (cursor);
    return all;
  }
  async callTool(name: string, args: Record<string, unknown>, opts: Parameters<ToolProvider["callTool"]>[2]) {
    const res = await this.client.callTool({ name, arguments: args }, undefined, {
      signal: opts.signal,
      timeout: opts.timeoutMs ?? 120_000,
      resetTimeoutOnProgress: true,
      onprogress: opts.onProgress ? (p) => opts.onProgress!({ progress: p.progress, total: p.total, message: (p as { message?: string }).message }) : undefined,
    });
    return res as UpstreamToolResult;
  }
  async close() {
    await this.client.close();
  }
}

export async function connectMcp(name: string, cfg: ServerConfig, vault: SecretVault, baseDir = process.cwd()): Promise<McpProvider> {
  let transport: Transport;
  if (isStdio(cfg)) {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...getDefaultEnvironment(), ...vault.inject(cfg.env) },
      // Desktop clients start Mycel from anywhere: relative paths are relative to mycel.yaml.
      cwd: cfg.cwd ? resolve(baseDir, cfg.cwd) : baseDir,
      stderr: "pipe",
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: vault.inject(cfg.headers) },
    });
  }
  const client = new Client({ name: `mycel:${name}`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return new McpProvider(client);
}

export class ProviderUpstream implements Upstream {
  status: Upstream["status"] = "connecting";
  error?: string;
  tools: ToolEntry[] = [];
  constructor(
    public name: string,
    private provider: ToolProvider,
    private cfg: Pick<ServerConfig, "trust" | "tools">,
  ) {}

  async refresh() {
    try {
      this.tools = toEntries(this.name, this.cfg, await this.provider.listTools());
      this.status = "ready";
    } catch (e) {
      this.status = "error";
      this.error = (e as Error).message;
    }
    return this;
  }

  call(tool: string, args: Record<string, unknown>, opts: Parameters<Upstream["call"]>[2] = {}) {
    return this.provider.callTool(tool, args, opts);
  }

  async close() {
    await this.provider.close?.();
  }
}

/** Connect to every enabled server in parallel; failures don't block the others. */
export async function connectAll(
  servers: Record<string, ServerConfig>,
  vault: SecretVault,
  log: (msg: string) => void = () => {},
  baseDir = process.cwd(),
): Promise<ProviderUpstream[]> {
  const entries = Object.entries(servers).filter(([, s]) => s.enabled !== false);
  return Promise.all(
    entries.map(async ([name, cfg]) => {
      try {
        const provider = await withTimeout(connectMcp(name, cfg, vault, baseDir), 30_000, `connect ${name}`);
        const up = await new ProviderUpstream(name, provider, cfg).refresh();
        log(`✓ ${name}: ${up.tools.length} tools`);
        return up;
      } catch (e) {
        const up = new ProviderUpstream(name, { listTools: async () => [], callTool: async () => ({ content: [], isError: true }) }, cfg);
        up.status = "error";
        up.error = (e as Error).message;
        log(`✗ ${name}: ${up.error}`);
        return up;
      }
    }),
  );
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
