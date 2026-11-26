import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const DEFAULT_CALLBACK_PORT = 33418;

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
  discovery?: unknown;
}

export class LoginRequired extends Error {
  constructor(public server: string) {
    super(`${server} needs you to sign in. Run: mycel login ${server}`);
  }
}

/**
 * OAuth for remote MCP servers (Canva, Notion, Linear, …), using the MCP
 * authorization spec via the official SDK: discovery, dynamic client
 * registration, PKCE and refresh. Tokens live in <home>/oauth/<server>.json (0600).
 *
 * In `serve` mode there is no browser, so a missing login throws LoginRequired.
 * `mycel login <server>` passes `onRedirect` to open the browser instead.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private file: string;
  constructor(
    private server: string,
    home: string,
    private opts: { callbackPort?: number; clientId?: string; clientSecret?: string; scope?: string; onRedirect?: (url: URL) => void | Promise<void> } = {},
  ) {
    this.file = join(home, "oauth", `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  private load(): Stored {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Stored) : {};
  }
  private save(patch: Partial<Stored>) {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ ...this.load(), ...patch }, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  get redirectUrl() {
    return `http://127.0.0.1:${this.opts.callbackPort ?? DEFAULT_CALLBACK_PORT}/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Mycel gateway",
      client_uri: "https://github.com/SpeakQuery/mycel",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }
  state() {
    const state = randomBytes(16).toString("hex");
    this.save({ state });
    return state;
  }
  expectedState() {
    return this.load().state;
  }
  clientInformation() {
    if (this.opts.clientId) return { client_id: this.opts.clientId, ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}) };
    return this.load().client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.save({ client });
  }
  tokens() {
    return this.load().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.save({ tokens });
  }
  async redirectToAuthorization(url: URL) {
    if (!this.opts.onRedirect) throw new LoginRequired(this.server);
    await this.opts.onRedirect(url);
  }
  saveCodeVerifier(verifier: string) {
    this.save({ verifier });
  }
  codeVerifier() {
    const v = this.load().verifier;
    if (!v) throw new Error("No PKCE verifier saved; start the login again.");
    return v;
  }
  saveDiscoveryState(discovery: unknown) {
    this.save({ discovery });
  }
  discoveryState() {
    return this.load().discovery as never;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") return void (existsSync(this.file) && rmSync(this.file));
    const key = ({ client: "client", tokens: "tokens", verifier: "verifier", discovery: "discovery" } as const)[scope];
    this.save({ [key]: undefined });
  }
  hasTokens() {
    return !!this.load().tokens?.access_token;
  }
}

/**
 * Listen on the local callback for ?code=…&state=… . Start it before the flow
 * begins so the browser can't come back too early; close() if not needed.
 */
export function waitForCallback(port: number, expectedState: () => string | undefined, timeoutMs = 300_000): { code: Promise<string>; close: () => void; ready: Promise<void> } {
  let close = () => {};
  let ready!: Promise<void>;
  const code = new Promise<string>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (u.pathname !== "/callback") return void res.writeHead(404).end();
      const got = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      const ok = !!got && u.searchParams.get("state") === expectedState();
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>Mycel</title><body style="font:16px system-ui;padding:3rem">${ok ? "Signed in. You can close this tab and return to your terminal." : `Sign-in failed: ${escapeHtml(err ?? "state mismatch")}`}</body>`);
      close();
      if (ok) resolve(got!);
      else reject(new Error(`OAuth callback failed: ${err ?? "state mismatch"}`));
    });
    const t = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for the browser sign-in."));
    }, timeoutMs);
    close = () => {
      clearTimeout(t);
      srv.close();
    };
    ready = new Promise<void>((ok, bad) => {
      srv.once("error", (e) => {
        bad(e);
        reject(e);
      });
      srv.listen(port, "127.0.0.1", () => ok());
    });
  });
  code.catch(() => {});
  return { code, close: () => close(), ready };
}

/** Open a URL in the default browser on macOS, Windows or Linux. */
export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* printed URL is the fallback */
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
