import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Mycel, CallContext } from "./core.js";
import { createMcpServer } from "./server.js";
import { A2AServer } from "./a2a-server.js";
import type { CapabilityClaims } from "./tokens.js";
import type { TraceEvent } from "./recorder.js";
import type { Job } from "./jobs.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Serve MCP at /mcp and A2A at /a2a in addition to the dashboard. */
  gateway: boolean;
  log?: (msg: string) => void;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function dashboardDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "dashboard"), join(here, "..", "..", "dashboard")]) if (existsSync(join(p, "index.html"))) return p;
  return join(here, "..", "dashboard");
}

/**
 * One HTTP server for everything:
 *   /            dashboard (local only, protected by a per-process token)
 *   /api/*       dashboard API
 *   /mcp         MCP Streamable HTTP
 *   /a2a         A2A JSON-RPC
 *   /.well-known/agent-card.json
 */
export function startHttp(m: Mycel, o: HttpOptions): Promise<{ server: HttpServer; url: string; token: string }> {
  const token = randomBytes(18).toString("base64url");
  const a2a = new A2AServer(m);
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const local = LOCAL_HOSTS.has(o.host);
  const sse = new Set<ServerResponse>();
  const log = o.log ?? (() => {});

  const broadcast = (type: string, data: unknown) => {
    const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of sse) r.write(line);
  };
  m.recorder.on("event", (e: TraceEvent) => broadcast("trace", e));
  m.jobs.on("update", (j: Job) => broadcast("job", { ...m.jobView(j), tool: j.tool, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, costUsd: j.costUsd, attempts: j.attempts }));

  const checkToken = (req: IncomingMessage, url: URL) => {
    const given = String(req.headers["x-mycel-token"] ?? url.searchParams.get("token") ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** Authenticate an agent: capability token, or implicit full access on a local bind. */
  const agentAuth = (req: IncomingMessage): { ok: true; capability?: CapabilityClaims; agent?: string } | { ok: false; error: string } => {
    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (bearer) {
      try {
        const claims = m.verifyToken(bearer);
        return { ok: true, capability: claims, agent: claims.chain.at(-1) ?? `token:${claims.id}` };
      } catch (e) {
        const msg = (e as Error).message;
        return { ok: false, error: /secret configured/.test(msg) ? "Invalid capability token" : msg };
      }
    }
    // Loopback callers on a local bind get full access unless tokens are required for A2A too.
    if (local && isLoopback(req) && !(m.config.a2a.requireToken && req.url?.startsWith("/a2a") && m.config.a2a.tokenSecret)) return { ok: true };
    return { ok: false, error: "A capability token is required (Authorization: Bearer myc1.…). Mint one with `mycel token mint`." };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // DNS-rebinding protection for local binds.
    if (local && !LOCAL_HOSTS.has(url.hostname)) return send(res, 403, { error: "Forbidden host" });
    try {
      // ------------------------------------------------------------- A2A
      if (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json") {
        const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
        return send(res, 200, a2a.card(`${proto === "https" ? "https" : "http"}://${req.headers["x-forwarded-host"] ?? req.headers.host}`));
      }
      if (url.pathname === "/a2a" && req.method === "POST") {
        const auth = agentAuth(req);
        if (!auth.ok) return send(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32000, message: auth.error } });
        const body = JSON.parse((await readBody(req)) || "{}");
        const ctx: CallContext = { capability: auth.capability, agent: auth.agent ?? "a2a" };
        return send(res, 200, await a2a.handle(body, ctx));
      }
      // Refs returned in A2A artifacts can be fetched by the same authenticated agents.
      const a2aRef = url.pathname.match(/^\/a2a\/refs\/([a-f0-9]{24})$/);
      if (a2aRef && req.method === "GET") {
        const auth = agentAuth(req);
        if (!auth.ok) return send(res, 401, { error: auth.error });
        const id = `ref://${a2aRef[1]}`;
        if (!m.refs.has(id)) return send(res, 404, { error: "Unknown ref" });
        const meta = m.refs.meta(id);
        const rows = url.searchParams.get("rows");
        if (url.searchParams.has("path") || rows || url.searchParams.has("grep")) {
          return send(res, 200, m.refs.read(id, { path: url.searchParams.get("path") ?? undefined, grep: url.searchParams.get("grep") ?? undefined, rows: rows ? (rows.split(",").map(Number) as [number, number]) : undefined }));
        }
        res.writeHead(200, { "content-type": meta.mime, "content-length": meta.size, "x-content-type-options": "nosniff", "x-mycel-taint": meta.taint });
        return res.end(m.refs.get(id));
      }
      // ------------------------------------------------------------- MCP
      if (url.pathname === "/mcp" && o.gateway) {
        const auth = agentAuth(req);
        if (!auth.ok) return send(res, 401, { error: auth.error });
        const sid = req.headers["mcp-session-id"] as string | undefined;
        let transport = sid ? sessions.get(sid) : undefined;
        if (req.method === "POST") {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : undefined;
          if (!transport) {
            if (!isInitializeRequest(body)) return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "No valid session; send initialize first." } });
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => void sessions.set(id, transport!),
            });
            transport.onclose = () => {
              if (transport!.sessionId) sessions.delete(transport!.sessionId);
            };
            await createMcpServer(m, { capability: auth.capability, agent: auth.agent }).connect(transport);
          }
          return await transport.handleRequest(req, res, body);
        }
        if (!transport) return send(res, 400, { error: "Unknown session" });
        return await transport.handleRequest(req, res);
      }
      // ------------------------------------------------------------- dashboard
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (!local) return send(res, 404, { error: "Dashboard is only served on local binds" });
        const file = join(dashboardDir(), "index.html");
        const html = existsSync(file) ? readFileSync(file, "utf8").replace("__MYCEL_TOKEN__", token) : `<h1>Mycel</h1><p>Dashboard assets not found.</p>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'" });
        return res.end(html);
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/refs/")) {
        if (!local || !checkToken(req, url)) return send(res, 401, { error: "Missing or invalid dashboard token", code: "bad_token" });
        try {
          return await api(m, req, res, url, sse);
        } catch (e) {
          const msg = (e as Error).message;
          return send(res, /^(No job|No approval|Unknown ref|Not found)/.test(msg) ? 404 : /already|is (succeeded|running|queued|failed)/.test(msg) ? 409 : 500, { error: msg });
        }
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : o.port;
      const url = `http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${port}`;
      log(`Mycel HTTP on ${url}${o.gateway ? "  (MCP: /mcp · A2A: /a2a)" : ""}`);
      resolve({ server, url, token });
    });
  });
}

function isLoopback(req: IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

async function api(m: Mycel, req: IncomingMessage, res: ServerResponse, url: URL, sse: Set<ServerResponse>) {
  const p = url.pathname;
  const method = req.method ?? "GET";
  const body = method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

  if (p === "/api/overview") {
    const fp = m.contextFootprint();
    return send(res, 200, {
      version: "0.1.8",
      session: m.sessionId,
      router: m.routerMode(),
      servers: [...m.upstreams.values()].map((u) => ({ name: u.name, status: u.status, error: u.error, tools: u.tools.length, trust: m.config.servers[u.name]?.trust ?? u.tools[0]?.trust ?? "trusted" })),
      footprint: fp,
      live: m.recorder.liveStats(),
      history: m.recorder.historicalStats(30),
      drift: m.drift,
      savings: { session: m.savings.snapshot(), definitionsPerTurn: m.definitionsPerTurn(), toolsListServed: m.savings.toolsListServed(), day: m.recorder.savingsReport().day, recent: m.recorder.load({ days: 1 }).filter((e) => e.savings?.measured && e.savings.counted !== false).slice(-8).map((e) => ({ ts: e.ts, tool: e.tool ?? e.kind, ...e.savings!.measured! })) },
      budget: { spent: m.budget.spent(), limits: m.config.budget },
      models: m.models.list(),
      peers: m.peers.names(),
      approvals: m.approvals.pending().length,
      jobs: { running: m.jobs.list({ status: "running" }).length, queued: m.jobs.list({ status: "queued" }).length },
    });
  }
  if (p === "/api/traces") return send(res, 200, m.recorder.traces(Number(url.searchParams.get("limit") ?? 50)));
  if (p.startsWith("/api/trace/")) return send(res, 200, m.recorder.load({ traceId: decodeURIComponent(p.slice(11)), days: 7 }));
  if (p === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    sse.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      sse.delete(res);
    });
    return;
  }
  if (p === "/api/jobs") return send(res, 200, m.jobs.list().slice(0, 100).map((j) => ({ ...m.jobView(j), tool: j.tool, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, costUsd: j.costUsd, attempts: j.attempts })));
  const jobAct = p.match(/^\/api\/jobs\/([^/]+)\/(cancel|retry)$/);
  if (jobAct && method === "POST") return send(res, 200, m.jobView(jobAct[2] === "cancel" ? m.jobs.cancel(jobAct[1]) : m.jobs.retry(jobAct[1])));
  if (p === "/api/approvals") return send(res, 200, m.approvals.pending());
  const apv = p.match(/^\/api\/approvals\/([^/]+)$/);
  if (apv && method === "POST") return send(res, 200, m.approvals.decide(apv[1], body.approve === true, "dashboard"));
  if (p === "/api/catalog") {
    const q = url.searchParams.get("q");
    const tools = q ? m.catalog.search(q, { limit: 50 }).map((h) => h.tool) : m.catalog.all();
    return send(res, 200, tools.map((t) => ({ id: t.id, server: t.server, description: t.description, contract: t.contract, trust: t.trust })));
  }
  if (p === "/api/refs") return send(res, 200, m.refs.list(100));
  if (p === "/api/pin/accept" && method === "POST") {
    m.lock.accept(m.catalog.all(), body.ids);
    m.rebuildCatalog();
    return send(res, 200, { ok: true, drift: m.drift });
  }
  const ref = p.match(/^\/refs\/([a-f0-9]{24})$/);
  if (ref) {
    const id = `ref://${ref[1]}`;
    const meta = m.refs.meta(id);
    res.writeHead(200, { "content-type": meta.mime, "content-length": meta.size, "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
    return res.end(m.refs.get(id));
  }
  send(res, 404, { error: "Not found" });
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
