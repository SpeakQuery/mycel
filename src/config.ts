import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { z } from "zod";

/** Effect classes every tool is mapped to. Ordered from safest to most dangerous. */
export const EFFECTS = ["read", "write", "external", "destructive"] as const;
export type Effect = (typeof EFFECTS)[number];

export const Trust = z.enum(["trusted", "untrusted"]);
export type Trust = z.infer<typeof Trust>;

const ContractOverride = z.object({
  effect: z.enum(EFFECTS).optional(),
  idempotent: z.boolean().optional(),
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  async: z.boolean().optional(),
  fallback: z.array(z.string()).optional(),
  retries: z.number().int().min(0).max(10).optional(),
});
export type ContractOverride = z.infer<typeof ContractOverride>;

const StdioServer = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).prefault({}),
  cwd: z.string().optional(),
});
const HttpServer = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()).prefault({}),
});
const ServerCommon = z.object({
  trust: Trust.default("trusted"),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  tools: z.record(z.string(), ContractOverride).prefault({}),
});
export const ServerConfig = z.union([StdioServer.merge(ServerCommon), HttpServer.merge(ServerCommon)]);
export type ServerConfig = z.infer<typeof ServerConfig>;

export const PolicyAction = z.enum(["allow", "deny", "approve"]);
export type PolicyAction = z.infer<typeof PolicyAction>;
export const PolicyRule = z.object({
  match: z
    .object({
      tool: z.string().optional(),
      server: z.string().optional(),
      effect: z.enum(EFFECTS).optional(),
      tainted: z.boolean().optional(),
    })
    .prefault({}),
  action: PolicyAction,
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

const ModelTier = z.object({
  provider: z.enum(["openai", "anthropic"]).default("openai"),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  costPer1kTokensUsd: z.number().optional(),
});

const A2APeer = z.object({
  url: z.url(),
  description: z.string().optional(),
  token: z.string().optional(),
  trust: Trust.default("untrusted"),
});

export const MycelConfig = z.object({
  servers: z.record(z.string(), ServerConfig).prefault({}),
  policy: z.array(PolicyRule).default([]),
  budget: z
    .object({ perTaskUsd: z.number().optional(), perDayUsd: z.number().optional() })
    .prefault({}),
  refs: z
    .object({
      inlineLimitBytes: z.number().int().positive().default(8000),
      dir: z.string().optional(),
    })
    .prefault({}),
  router: z
    .object({
      /** "meta" = expose only Mycel meta-tools. "hybrid" = also expose the top N tools directly. "passthrough" = expose everything (no router). */
      /** auto = "compact" for small catalogs (all tools + run/ref/job), "meta" once definitions exceed autoThresholdTokens. */
      mode: z.enum(["auto", "meta", "hybrid", "passthrough"]).default("auto"),
      autoThresholdTokens: z.number().int().positive().default(4000),
      hybridTop: z.number().int().min(0).default(10),
    })
    .prefault({}),
  sandbox: z
    .object({
      timeoutMs: z.number().int().positive().default(30000),
      memoryMb: z.number().int().positive().default(64),
      maxToolCalls: z.number().int().positive().default(200),
    })
    .prefault({}),
  jobs: z
    .object({
      /** Calls expected to take longer than this become background jobs. */
      asyncThresholdMs: z.number().int().positive().default(20000),
      concurrency: z.number().int().positive().default(4),
    })
    .prefault({}),
  secrets: z
    .object({
      /** Where secret values come from. env = process env; file = a dotenv-style file. */
      source: z.enum(["env", "file"]).default("env"),
      file: z.string().optional(),
      allow: z.array(z.string()).optional(),
    })
    .prefault({}),
  pinning: z.object({ enabled: z.boolean().default(true), onDrift: z.enum(["block", "warn"]).default("block") }).prefault({}),
  recorder: z
    .object({
      enabled: z.boolean().default(true),
      otlpEndpoint: z.string().optional(),
      redact: z.boolean().default(true),
    })
    .prefault({}),
  dashboard: z.object({ port: z.number().int().default(4747), host: z.string().default("127.0.0.1") }).prefault({}),
  a2a: z
    .object({
      name: z.string().default("mycel"),
      description: z.string().default("A Mycel gateway exposing tools as an A2A agent."),
      peers: z.record(z.string(), A2APeer).prefault({}),
      tokenSecret: z.string().optional(),
      requireToken: z.boolean().default(true),
    })
    .prefault({}),
  models: z.record(z.string(), ModelTier).prefault({}),
});
export type MycelConfig = z.infer<typeof MycelConfig>;

export interface LoadedConfig {
  config: MycelConfig;
  path: string | null;
  /** Directory where Mycel stores state (refs, traces, jobs, lock file). */
  home: string;
}

export const DEFAULT_CONFIG_NAMES = ["mycel.yaml", "mycel.yml", "mycel.json"];

export function findConfig(start = process.cwd()): string | null {
  if (process.env.MYCEL_CONFIG) return resolve(process.env.MYCEL_CONFIG);
  let dir = resolve(start);
  for (;;) {
    for (const name of DEFAULT_CONFIG_NAMES) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const global = join(homedir(), ".mycel", "mycel.yaml");
  return existsSync(global) ? global : null;
}

export function parseConfig(text: string, isJson = false): MycelConfig {
  const raw = isJson ? JSON.parse(text) : YAML.parse(text);
  return MycelConfig.parse(raw ?? {});
}

export function loadConfig(path?: string | null): LoadedConfig {
  const p = path === undefined ? findConfig() : path;
  const config = p ? parseConfig(readFileSync(p, "utf8"), p.endsWith(".json")) : MycelConfig.parse({});
  const home = process.env.MYCEL_HOME
    ? resolve(process.env.MYCEL_HOME)
    : p
      ? join(dirname(p), ".mycel")
      : join(homedir(), ".mycel");
  return { config, path: p, home };
}

export type StdioServerConfig = Extract<ServerConfig, { command: string }>;
export function isStdio(s: ServerConfig): s is StdioServerConfig {
  return "command" in s;
}
