import { randomUUID } from "node:crypto";
import type { MycelConfig } from "./config.js";
import type { SecretVault } from "./secrets.js";

/** Minimal A2A (Agent2Agent) types — protocol v0.3 JSON-RPC binding. */
export type Part = { kind: "text"; text: string } | { kind: "data"; data: unknown } | { kind: "file"; file: { uri?: string; bytes?: string; mimeType?: string; name?: string } };
export interface A2AMessage {
  kind: "message";
  role: "user" | "agent";
  parts: Part[];
  messageId: string;
  contextId?: string;
  taskId?: string;
}
export type TaskState = "submitted" | "working" | "input-required" | "auth-required" | "completed" | "canceled" | "failed" | "rejected";
export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string; message?: A2AMessage };
  artifacts?: Array<{ artifactId: string; name?: string; parts: Part[] }>;
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  preferredTransport?: string;
  capabilities: { streaming?: boolean; pushNotifications?: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description: string; tags: string[]; examples?: string[] }>;
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
}

/** Talk to remote A2A agents. Each configured peer shows up for mycel_delegate. */
export class A2AClient {
  private cards = new Map<string, AgentCard>();
  constructor(
    private peers: MycelConfig["a2a"]["peers"],
    private vault: SecretVault,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  names() {
    return Object.keys(this.peers);
  }

  async card(name: string): Promise<AgentCard> {
    const cached = this.cards.get(name);
    if (cached) return cached;
    const peer = this.peer(name);
    const base = new URL(peer.url);
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      try {
        const res = await this.fetchImpl(new URL(path, base));
        if (res.ok) {
          const c = (await res.json()) as AgentCard;
          this.cards.set(name, c);
          return c;
        }
      } catch {
        /* try next */
      }
    }
    throw new Error(`Could not fetch agent card for ${name} at ${peer.url}`);
  }

  private peer(name: string) {
    const p = this.peers[name];
    if (!p) throw new Error(`Unknown agent "${name}". Configured: ${this.names().join(", ") || "none"}`);
    return p;
  }

  async rpc<T>(name: string, method: string, params: unknown, tokenOverride?: string): Promise<T> {
    const peer = this.peer(name);
    let url = peer.url;
    try {
      const card = await this.card(name);
      if (card.url) url = card.url;
    } catch {
      /* fall back to configured url */
    }
    const token = tokenOverride ?? (peer.token ? this.vault.inject(peer.token) : undefined);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    });
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new Error(`A2A ${name} ${method}: ${j.error.message}`);
    return j.result as T;
  }

  /** Send a message; optionally poll until the task is terminal. */
  async send(name: string, input: { text?: string; data?: unknown; wait?: boolean; taskId?: string; contextId?: string; token?: string }) {
    const parts: Part[] = [];
    if (input.text) parts.push({ kind: "text", text: input.text });
    if (input.data !== undefined) parts.push({ kind: "data", data: input.data });
    if (!parts.length) throw new Error("Provide text or data to send");
    const message: A2AMessage = { kind: "message", role: "user", parts, messageId: randomUUID(), ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.contextId ? { contextId: input.contextId } : {}) };
    let result = await this.rpc<A2ATask | A2AMessage>(name, "message/send", { message }, input.token);
    if (input.wait !== false && result.kind === "task") {
      const deadline = Date.now() + 120_000;
      while (["submitted", "working"].includes(result.status.state) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        result = await this.rpc<A2ATask>(name, "tasks/get", { id: result.id }, input.token);
      }
    }
    return summarize(result);
  }

  async cancel(name: string, taskId: string) {
    return this.rpc<A2ATask>(name, "tasks/cancel", { id: taskId });
  }
}

function summarize(r: A2ATask | A2AMessage) {
  if (r.kind === "message") return { kind: "message", parts: r.parts.map(partValue) };
  return {
    kind: "task",
    id: r.id,
    contextId: r.contextId,
    state: r.status.state,
    ...(r.status.message ? { message: r.status.message.parts.map(partValue) } : {}),
    ...(r.artifacts?.length ? { artifacts: r.artifacts.map((a) => ({ name: a.name, content: a.parts.map(partValue) })) } : {}),
  };
}

export function partValue(p: Part): unknown {
  if (p.kind === "text") return p.text;
  if (p.kind === "data") return p.data;
  return { file: p.file.name ?? p.file.uri, mimeType: p.file.mimeType };
}
