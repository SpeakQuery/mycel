import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolve } from "node:path";
import { isStdio, type ServerConfig } from "./config.js";
import { hashDefinition, type ToolEntry } from "./catalog.js";
import { inferContract, type ToolAnnotations } from "./contracts.js";
import type { SecretVault } from "./secrets.js";
import { FileOAuthProvider } from "./oauth.js";
import { VERSION } from "./update.js";

/**
 * Did the provider possibly accept the call?
 *  - "rejected": definitely not accepted (could not connect, not connected, failed before the request
 *    was sent, JSON-RPC/MCP error response, or a tool result with isError from a free tool or from a paid tool
 *    whose contract sets errorsAreRejections: true). Safe to fall back / retry.
 *  - "unknown": timeout, connection closed or reset after sending, abort, or anything we cannot
 *    positively classify as rejected, and an isError result from a paid tool (costUsd > 0) unless its contract
 *    sets errorsAreRejections: true (a stdio MCP server wrapping a paid HTTP API reports a lost provider reply
 *    that way). The provider may have accepted (and charged for) the call.
 */
export type CallDisposition = "rejected" | "unknown";

export class CallError extends Error {
  /** Contract cost to charge as an estimate when the disposition is "unknown" (set by the job runner). */
  estimatedCostUsd?: number;
  constructor(
    message: string,
    public disposition: CallDisposition,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CallError";
  }
}

const REFUSED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENOENT", "EACCES"]);
const MCP_CONNECTION_CLOSED = -32000;
const MCP_REQUEST_TIMEOUT = -32001;

/** Disposition of an arbitrary error: only positively identified rejections are "rejected". */
export function dispositionOf(e: unknown): CallDisposition {
  if (e instanceof CallError) return e.disposition;
  return classify(e) ?? "unknown";
}

function classify(e: unknown): CallDisposition | undefined {
  if (!e || typeof e !== "object") return undefined;
  const err = e as { code?: unknown; name?: string; message?: string; cause?: unknown };
  const d = (err as { disposition?: unknown }).disposition;
  if (d === "rejected" || d === "unknown") return d;
  if (typeof err.code === "string" && REFUSED_CODES.has(err.code)) return "rejected";
  if (err.name === "AbortError") return "unknown";
  if (typeof err.code === "number") {
    // MCP/JSON-RPC: the server answered with an error, except the SDK's own timeout / closed markers.
    if (err.code === MCP_CONNECTION_CLOSED || err.code === MCP_REQUEST_TIMEOUT) return "unknown";
    return err.name === "McpError" || /^MCP error/.test(err.message ?? "") ? "rejected" : undefined;
  }
  if (/^Not connected$/i.test(err.message ?? "")) return "rejected";
  if (err.cause) return classify(err.cause);
  return undefined;
}

/** Tag an error from a provider call with its disposition. */
export function tagCallError(e: unknown, signal?: AbortSignal): CallError {
  if (e instanceof CallError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const disposition: CallDisposition = signal?.aborted ? "unknown" : dispositionOf(e);
  return new CallError(msg, disposition, { cause: e });
}

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

export function toEntries(server: string, cfg: Pick<ServerConfig, "trust" | "tools"> & { annotations?: "balanced" | "strict" }, tools: Awaited<ReturnType<ToolProvider["listTools"]>>): ToolEntry[] {
  return tools.map((t) => ({
    id: `${server}.${t.name}`,
    server,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    outputSchema: t.outputSchema,
    annotations: t.annotations,
    contract: inferContract(t.name, t.description, t.annotations, cfg.tools?.[t.name], cfg.annotations),
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

export interface ConnectOptions {
  /** Mycel home; OAuth tokens are stored under <home>/oauth. Without it, OAuth is off. */
  home?: string;
  /** Interactive sign-in (mycel login): open the browser instead of failing. */
  onRedirect?: (url: URL) => void | Promise<void>;
}

/** The OAuth provider Mycel would use for an HTTP server, or undefined if OAuth doesn't apply. */
export function oauthFor(name: string, cfg: ServerConfig, vault: SecretVault, opts: ConnectOptions = {}) {
  if (isStdio(cfg) || cfg.oauth === false || !opts.home) return undefined;
  const headers = vault.inject(cfg.headers) as Record<string, string>;
  if (Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) return undefined; // static token wins
  const o = cfg.oauth ?? {};
  return new FileOAuthProvider(name, opts.home, {
    ...o,
    clientSecret: o.clientSecret ? String(vault.inject({ s: o.clientSecret }).s) : undefined,
    onRedirect: opts.onRedirect,
  });
}

export async function connectMcp(name: string, cfg: ServerConfig, vault: SecretVault, baseDir = process.cwd(), opts: ConnectOptions = {}): Promise<McpProvider> {
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
      authProvider: oauthFor(name, cfg, vault, opts),
    });
  }
  const client = new Client({ name: `mycel:${name}`, version: VERSION }, { capabilities: {} });
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
    private cfg: Pick<ServerConfig, "trust" | "tools"> & { annotations?: "balanced" | "strict" },
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

  async call(tool: string, args: Record<string, unknown>, opts: Parameters<Upstream["call"]>[2] = {}) {
    try {
      return await this.provider.callTool(tool, args, opts);
    } catch (e) {
      throw tagCallError(e, opts.signal);
    }
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
  opts: ConnectOptions = {},
): Promise<ProviderUpstream[]> {
  const entries = Object.entries(servers).filter(([, s]) => s.enabled !== false);
  return Promise.all(
    entries.map(async ([name, cfg]) => {
      try {
        const provider = await withTimeout(connectMcp(name, cfg, vault, baseDir, opts), 30_000, `connect ${name}`);
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
