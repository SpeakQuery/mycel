import type { Effect, ContractOverride } from "./config.js";

/** MCP tool annotations (subset of the spec). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Contract {
  effect: Effect;
  idempotent: boolean;
  costUsd: number;
  latencyMs: number | null;
  async: boolean;
  fallback: string[];
  retries: number;
  /** Where each field came from, so users can see what is declared vs inferred. */
  source: "declared" | "annotations" | "inferred";
}

const DESTRUCTIVE = /\b(delete|remove|drop|destroy|purge|truncate|wipe|kill|revoke|terminate|uninstall|reset|force[_-]?push|unsafe|exec|execute|eval|evaluate|shell)\b/i;
const EXEC = /\b(shell|terminal|spawn|command|start process|interact with process)\b/i;
const WRITE = /\b(create|update|write|set|add|put|post|edit|insert|upsert|move|rename|merge|commit|push|upload|patch|apply|enable|disable|label|assign|close|open|archive)\b/i;
const EXTERNAL = /\b(send|email|mail|message|notify|publish|tweet|post_to|sms|call|pay|charge|transfer|invite|share|deploy)\b/i;
const READ = /\b(get|list|read|search|find|fetch|query|describe|show|view|count|stat|lookup|inspect|download)\b/i;
const SLOW = /\b(video|render|generate|train|transcode|upscale|animate|synthesize|batch|export|build)\b/i;

/** Split snake_case / camelCase / kebab names into words so regexes can match them. */
function words(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/]+/g, " ")
    .toLowerCase();
}

/**
 * Infer a contract for a tool. Declared overrides win, then MCP annotations,
 * then name/description heuristics. Heuristics err on the side of caution.
 */
export function inferContract(
  name: string,
  description: string | undefined,
  annotations: ToolAnnotations | undefined,
  override: ContractOverride | undefined,
  annotationMode: "balanced" | "strict" = "balanced",
): Contract {
  const n = words(name);
  const text = `${n} ${words(description ?? "")}`;
  let effect: Effect;
  let source: Contract["source"] = "inferred";

  if (annotations && (annotations.readOnlyHint !== undefined || annotations.destructiveHint !== undefined)) {
    source = "annotations";
    if (annotations.readOnlyHint) effect = "read";
    else if (annotations.destructiveHint) {
      // Many servers mark every non-read tool destructive (e.g. a browser "hover").
      // Unless the name corroborates it, treat it as an outside-world action instead.
      const corroborated = DESTRUCTIVE.test(n) || EXEC.test(n) || WRITE.test(n);
      effect = annotationMode === "strict" || corroborated ? "destructive" : annotations.openWorldHint === false ? "write" : "external";
    }
    else if (annotations.openWorldHint) effect = "external";
    else effect = "write";
  } else if (DESTRUCTIVE.test(n) || EXEC.test(n)) effect = "destructive";
  else if (EXTERNAL.test(n)) effect = "external";
  else if (WRITE.test(n)) effect = "write";
  else if (READ.test(n)) effect = "read";
  else if (DESTRUCTIVE.test(text) || EXEC.test(text)) effect = "destructive";
  else effect = "write"; // unknown → assume it changes something

  const contract: Contract = {
    effect,
    idempotent: annotations?.idempotentHint ?? effect === "read",
    costUsd: 0,
    latencyMs: null,
    async: SLOW.test(n),
    fallback: [],
    retries: effect === "read" ? 2 : 0,
    source,
  };
  if (override) {
    Object.assign(
      contract,
      Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)),
    );
    contract.source = "declared";
  }
  return contract;
}

export const EFFECT_RANK: Record<Effect, number> = { read: 0, write: 1, external: 2, destructive: 3 };
