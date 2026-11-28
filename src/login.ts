import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { isStdio, type LoadedConfig } from "./config.js";
import { Mycel } from "./core.js";
import { oauthFor } from "./upstream.js";
import { DEFAULT_CALLBACK_PORT, openBrowser, waitForCallback } from "./oauth.js";

export type SignInResult = { ok: true; tools: number } | { ok: false; reason: string };

/**
 * Sign in to a remote MCP server that uses OAuth: open the browser, wait for the redirect,
 * store the tokens (they refresh automatically). Used by `mycel login` and by the setup wizard.
 */
export async function signIn(loaded: LoadedConfig, name: string, out: (s: string) => void, opts: { browser?: boolean } = {}): Promise<SignInResult> {
  const cfg = loaded.config.servers[name];
  if (!cfg) return { ok: false, reason: `no server "${name}" in ${loaded.path ?? "config"}` };
  if (isStdio(cfg)) return { ok: false, reason: `${name} is a local (stdio) server; it doesn't need a sign-in` };
  const m = new Mycel(loaded, { log: () => {}, noConnect: true });
  const provider = oauthFor(name, cfg, m.vault, {
    home: loaded.home,
    onRedirect: (url) => {
      out(`\n  Sign in to ${name} in your browser:\n  ${url.href}\n`);
      if (opts.browser !== false) openBrowser(url.href);
    },
  });
  if (!provider) return { ok: false, reason: `OAuth is off for ${name} (oauth: false, or an Authorization header is set)` };
  const port = (cfg.oauth || undefined)?.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const cb = waitForCallback(port, () => provider.expectedState());
  await cb.ready;
  const connect = async () => {
    const client = new Client({ name: `mycel:${name}`, version: "0.2.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: m.vault.inject(cfg.headers) }, authProvider: provider });
    await client.connect(transport);
    return { client, transport };
  };
  let conn: Awaited<ReturnType<typeof connect>>;
  try {
    conn = await connect();
    cb.close();
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) {
      cb.close();
      return { ok: false, reason: (e as Error).message };
    }
    out("  Waiting for you to finish signing in…");
    try {
      const code = await cb.code;
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: m.vault.inject(cfg.headers) }, authProvider: provider });
      await transport.finishAuth(code);
      conn = await connect();
    } catch (e2) {
      cb.close();
      return { ok: false, reason: (e2 as Error).message };
    }
  }
  const { tools } = await conn.client.listTools();
  await conn.client.close();
  return { ok: true, tools: tools.length };
}
