import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EFFECT_RANK } from "./contracts.js";
import type { Effect } from "./config.js";
import { globToRegExp } from "./policy.js";

/**
 * Capability tokens — macaroon-style, attenuable delegation.
 *
 *   sig₀ = HMAC(rootKey, id)
 *   sigᵢ = HMAC(sigᵢ₋₁, caveatᵢ)
 *
 * Anyone holding a token can ADD caveats (narrowing it) without knowing the
 * root key, but nobody can remove one: the signature chain would break.
 * So a sub-agent can hand an even weaker token to its own sub-agent, but can
 * never escalate. Only the issuing Mycel (holding rootKey) can verify.
 */
export interface Caveat {
  /** Tool globs this token may call, e.g. ["github.list_*", "calendar.*"]. Intersected across caveats. */
  tools?: string[];
  /** Highest effect class allowed (read < write < external < destructive). */
  maxEffect?: Effect;
  /** Total USD this token may spend. */
  budgetUsd?: number;
  /** Expiry, unix seconds. */
  exp?: number;
  /** Who this was delegated to (audit label only). */
  sub?: string;
}

export interface CapabilityClaims {
  id: string;
  tools?: string[];
  maxEffect?: Effect;
  budgetUsd?: number;
  exp?: number;
  chain: string[];
}

interface Wire {
  v: 1;
  id: string;
  c: Caveat[];
  s: string;
}

const PREFIX = "myc1.";

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
function enc(w: Wire): string {
  return PREFIX + Buffer.from(JSON.stringify(w)).toString("base64url");
}
function dec(token: string): Wire {
  if (!token.startsWith(PREFIX)) throw new Error("Not a Mycel capability token");
  const w = JSON.parse(Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8")) as Wire;
  if (w.v !== 1 || !w.id || !Array.isArray(w.c) || !w.s) throw new Error("Malformed capability token");
  return w;
}

export function newRootKey(): string {
  return randomBytes(32).toString("base64url");
}

export function mint(rootKey: string, caveat: Caveat = {}): string {
  const id = randomBytes(9).toString("base64url");
  let sig = hmac(rootKey, id);
  const c = [caveat];
  sig = hmac(sig, JSON.stringify(caveat));
  return enc({ v: 1, id, c, s: sig.toString("base64url") });
}

/** Narrow a token. Needs no secret. */
export function attenuate(token: string, caveat: Caveat): string {
  const w = dec(token);
  const sig = hmac(Buffer.from(w.s, "base64url"), JSON.stringify(caveat));
  return enc({ ...w, c: [...w.c, caveat], s: sig.toString("base64url") });
}

/** Inspect without verifying (for display). */
export function inspect(token: string): { id: string; caveats: Caveat[]; effective: CapabilityClaims } {
  const w = dec(token);
  return { id: w.id, caveats: w.c, effective: fold(w) };
}

function fold(w: Wire): CapabilityClaims {
  const out: CapabilityClaims = { id: w.id, chain: [] };
  for (const c of w.c) {
    if (c.sub) out.chain.push(c.sub);
    if (c.tools) {
      if (!out.tools) out.tools = [...c.tools];
      else {
        // Intersection of glob sets: keep a narrower glob only if it is covered by a previous one.
        const prev = out.tools;
        out.tools = c.tools.filter((g) => prev.some((p) => globToRegExp(p).test(g.replace(/\*/g, "x"))));
      }
    }
    if (c.maxEffect) out.maxEffect = !out.maxEffect || EFFECT_RANK[c.maxEffect] < EFFECT_RANK[out.maxEffect] ? c.maxEffect : out.maxEffect;
    if (c.budgetUsd !== undefined) out.budgetUsd = out.budgetUsd === undefined ? c.budgetUsd : Math.min(out.budgetUsd, c.budgetUsd);
    if (c.exp !== undefined) out.exp = out.exp === undefined ? c.exp : Math.min(out.exp, c.exp);
  }
  return out;
}

export function verify(rootKey: string, token: string, now = Date.now() / 1000): CapabilityClaims {
  const w = dec(token);
  let sig = hmac(rootKey, w.id);
  for (const c of w.c) sig = hmac(sig, JSON.stringify(c));
  const given = Buffer.from(w.s, "base64url");
  if (given.length !== sig.length || !timingSafeEqual(given, sig)) throw new Error("Invalid capability token signature");
  const claims = fold(w);
  if (claims.exp !== undefined && now > claims.exp) throw new Error("Capability token expired");
  return claims;
}

/** Parse "1h", "30m", "2d" → seconds. */
export function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/);
  if (!m) throw new Error(`Bad duration "${s}"`);
  const n = Number(m[1]);
  return Math.round(n * ({ s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s") as "s"] ?? 1));
}
