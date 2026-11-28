import { readFileSync, existsSync } from "node:fs";
import type { MycelConfig } from "./config.js";
import { keychainGet } from "./keychain.js";

const PLACEHOLDER = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Secret Vault: the model only ever sees `{{secret:NAME}}` placeholders.
 * Real values are injected at call time and scrubbed from anything returned to the model.
 */
export class SecretVault {
  private values = new Map<string, string>();
  private allow: Set<string> | null;

  constructor(cfg: MycelConfig["secrets"], env: NodeJS.ProcessEnv = process.env) {
    this.allow = cfg.allow ? new Set(cfg.allow) : null;
    this.keychain = cfg.source === "keychain";
    if ((cfg.source === "file" || cfg.source === "keychain") && cfg.file && existsSync(cfg.file)) {
      for (const line of readFileSync(cfg.file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) this.values.set(m[1], m[2].replace(/^["']|["']$/g, ""));
      }
    }
    this.env = env;
  }
  private env: NodeJS.ProcessEnv;
  private keychain = false;

  get(name: string): string | undefined {
    if (this.allow && !this.allow.has(name)) return undefined;
    const v = this.values.get(name);
    if (v !== undefined) return v;
    if (this.keychain) {
      const k = keychainGet(name);
      if (k !== undefined) {
        this.values.set(name, k); // cached, and scrubbed from output like file values
        return k;
      }
    }
    return this.env[name];
  }

  /** Names referenced by a value (deep). */
  referenced(value: unknown): string[] {
    const out = new Set<string>();
    walkStrings(value, (s) => {
      for (const m of s.matchAll(PLACEHOLDER)) out.add(m[1]);
      return s;
    });
    return [...out];
  }

  /** Replace placeholders with real values (deep). Throws if a referenced secret is missing. */
  inject<T>(value: T): T {
    return walkStrings(value, (s) =>
      s.replace(PLACEHOLDER, (_, name: string) => {
        const v = this.get(name);
        if (v === undefined) throw new Error(`Secret "${name}" is not available (set it in the environment or secrets file).`);
        this.seen.add(v);
        return v;
      }),
    );
  }

  private seen = new Set<string>();

  /** Remove any injected secret value (and any vault value) that leaks into output. */
  scrub<T>(value: T): T {
    const needles = new Map<string, string>();
    for (const [k, v] of this.values) if (v.length >= 6) needles.set(v, k);
    for (const v of this.seen) if (v.length >= 6 && !needles.has(v)) needles.set(v, "REDACTED");
    if (!needles.size) return value;
    return walkStrings(value, (s) => {
      let r = s;
      for (const [v, k] of needles) if (r.includes(v)) r = r.split(v).join(`{{secret:${k}}}`);
      return r;
    });
  }
}

export function walkStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn)) as T;
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkStrings(v, fn);
    return out as T;
  }
  return value;
}
