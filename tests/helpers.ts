import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mycel } from "../src/core.js";
import { MycelConfig } from "../src/config.js";
import type { ToolProvider } from "../src/upstream.js";

export function tmp() {
  return mkdtempSync(join(tmpdir(), "mycel-test-"));
}

export type FakeTool = { name: string; description?: string; annotations?: Record<string, boolean>; handler?: (args: Record<string, unknown>, opts: Parameters<ToolProvider["callTool"]>[2]) => Promise<unknown> | unknown };

export function fakeProvider(tools: FakeTool[], calls: Array<{ name: string; args: Record<string, unknown> }> = []): ToolProvider {
  return {
    listTools: async () => tools.map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: t.annotations })),
    callTool: async (name, args, opts) => {
      calls.push({ name, args });
      const t = tools.find((x) => x.name === name)!;
      const v = t.handler ? await t.handler(args, opts) : { ok: true, name, args };
      if (v && typeof v === "object" && "content" in (v as object)) return v as never;
      return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] };
    },
  };
}

export async function makeMycel(
  providers: Record<string, { tools: FakeTool[]; trust?: "trusted" | "untrusted"; contracts?: Record<string, Record<string, unknown>> }>,
  config: Record<string, unknown> = {},
) {
  const home = tmp();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const cfg = MycelConfig.parse({ refs: { dir: join(home, "refs") }, ...config });
  const m = await new Mycel(
    { config: cfg, path: null, home },
    {
      noConnect: true,
      providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { provider: fakeProvider(v.tools, calls), trust: v.trust, tools: v.contracts as never }])),
    },
  ).start();
  return { m, calls, home };
}
