import type { MycelConfig } from "./config.js";
import type { SecretVault } from "./secrets.js";
import { round } from "./recorder.js";

export const TIER_ORDER = ["fast", "balanced", "deep"];

export interface AskResult {
  text: string;
  tier: string;
  model: string;
  tokens: { input: number; output: number };
  costUsd: number;
}

/**
 * Model Router: route sub-tasks to the cheapest model tier that fits.
 * Tiers are arbitrary names; "fast" / "balanced" / "deep" get fallback order.
 * Works with any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, LM Studio,
 * OpenRouter, …) and with Anthropic's Messages API.
 */
export class ModelRouter {
  constructor(
    private tiers: MycelConfig["models"],
    private vault: SecretVault,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get configured() {
    return Object.keys(this.tiers).length > 0;
  }

  list() {
    return Object.entries(this.tiers).map(([tier, t]) => ({ tier, provider: t.provider, model: t.model, costPer1kTokensUsd: t.costPer1kTokensUsd }));
  }

  resolve(tier?: string): [string, MycelConfig["models"][string]] {
    const names = Object.keys(this.tiers);
    if (!names.length) throw new Error("No models configured. Add a `models:` section to mycel.yaml.");
    if (tier && this.tiers[tier]) return [tier, this.tiers[tier]];
    // Fallback: the requested tier's nearest neighbour upward, then downward, then anything.
    const idx = tier ? TIER_ORDER.indexOf(tier) : 0;
    const order = idx >= 0 ? [...TIER_ORDER.slice(idx), ...TIER_ORDER.slice(0, idx).reverse()] : TIER_ORDER;
    for (const t of order) if (this.tiers[t]) return [t, this.tiers[t]];
    return [names[0], this.tiers[names[0]]];
  }

  async ask(prompt: string, o: { tier?: string; system?: string; maxTokens?: number } = {}): Promise<AskResult> {
    const [tier, cfg] = this.resolve(o.tier);
    const apiKey = cfg.apiKey ? this.vault.inject(cfg.apiKey) : cfg.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    const maxTokens = o.maxTokens ?? 1024;
    let text = "";
    let input = 0;
    let output = 0;
    if (cfg.provider === "anthropic") {
      const res = await this.fetchImpl((cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, ...(o.system ? { system: o.system } : {}), messages: [{ role: "user", content: prompt }] }),
      });
      const j = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number }; error?: { message: string } };
      if (!res.ok) throw new Error(`Model ${cfg.model} failed: ${j.error?.message ?? res.status}`);
      text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      input = j.usage?.input_tokens ?? 0;
      output = j.usage?.output_tokens ?? 0;
    } else {
      const res = await this.fetchImpl((cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: prompt }] }),
      });
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens: number; completion_tokens: number }; error?: { message: string } };
      if (!res.ok) throw new Error(`Model ${cfg.model} failed: ${j.error?.message ?? res.status}`);
      text = j.choices?.[0]?.message?.content ?? "";
      input = j.usage?.prompt_tokens ?? 0;
      output = j.usage?.completion_tokens ?? 0;
    }
    const costUsd = cfg.costPer1kTokensUsd ? round(((input + output) / 1000) * cfg.costPer1kTokensUsd) : 0;
    return { text, tier, model: cfg.model, tokens: { input, output }, costUsd };
  }
}
