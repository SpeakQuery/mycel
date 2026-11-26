import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, waitForCallback } from "../src/oauth.js";
import { Mycel } from "../src/core.js";
import { MycelConfig } from "../src/config.js";

/** A remote MCP server protected by OAuth, like Canva or Notion (the demo provider auto-approves). */
let http: HttpServer;
let base: URL;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  http = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}`);
  const mcpUrl = new URL("/mcp", base);
  const provider = new DemoInMemoryAuthProvider();
  app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, scopesSupported: ["mcp:tools"] }));
  app.post("/mcp", requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) }), async (req, res) => {
    const server = new McpServer({ name: "oauth-demo", version: "1" });
    server.registerTool("whoami", { description: "Return the signed-in user" }, async () => ({ content: [{ type: "text", text: "demo_user" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
});
afterAll(() => http?.close());

const freePort = () => 34000 + Math.floor(Math.random() * 2000);

/** Plays the user's browser: follow the authorize redirect back to the local callback. */
const browser = async (url: URL) => {
  const r = await fetch(url, { redirect: "manual" });
  const back = r.headers.get("location");
  if (back) await fetch(back);
};

describe("OAuth for remote MCP servers", () => {
  it("signs in, stores tokens privately, and Mycel connects with them", async () => {
    const home = mkdtempSync(join(tmpdir(), "mycel-oauth-"));
    const callbackPort = freePort();
    const mcpUrl = new URL("/mcp", base);

    // Before signing in, Mycel reports exactly what to do.
    const cfg = MycelConfig.parse({ servers: { demo: { url: mcpUrl.href, oauth: { callbackPort } } } });
    const before = await new Mycel({ config: cfg, path: undefined, home } as never, { log: () => {} }).start();
    const up = before.upstreams.get("demo")!;
    expect(up.status).toBe("error");
    expect(up.error).toMatch(/mycel login demo/);
    await before.close();

    // `mycel login demo`, minus the real browser.
    const provider = new FileOAuthProvider("demo", home, { callbackPort, onRedirect: (u) => void browser(u) });
    const cb = waitForCallback(callbackPort, () => provider.expectedState(), 10_000);
    await cb.ready;
    const client = new Client({ name: "t", version: "1" });
    await expect(client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }))).rejects.toBeInstanceOf(UnauthorizedError);
    const code = await cb.code;
    await new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }).finishAuth(code);
    expect(provider.hasTokens()).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(home, "oauth", "demo.json")).mode & 0o777).toBe(0o600);

    // `mycel serve` now just works, no browser involved.
    const m = await new Mycel({ config: cfg, path: undefined, home } as never, { log: () => {} }).start();
    expect(m.upstreams.get("demo")!.status).toBe("ready");
    const r = await m.call("demo.whoami", {}, {});
    expect(JSON.stringify(r)).toContain("demo_user");
    await m.close();
  });

  it("rejects a callback with the wrong state", async () => {
    const port = freePort();
    const cb = waitForCallback(port, () => "expected", 5_000);
    await cb.ready;
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=forged`);
    expect(res.status).toBe(400);
    await expect(cb.code).rejects.toThrow(/state mismatch/);
  });
});
