import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Mycel } from "../src/core.js";
import { MycelConfig } from "../src/config.js";
import { META_TOOLS } from "../src/meta.js";
import type { ToolProvider } from "../src/upstream.js";
import { tmp } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const schema = {
  type: "object",
  properties: {
    projectId: { type: "string", description: "Numeric project id" },
    prompt: { type: "string", description: "What to design" },
    screenIds: { type: "array", items: { type: "string" } },
    options: { type: "object", properties: { dark: { type: "boolean" }, size: { type: "integer" } }, required: ["size"] },
    deviceType: { type: "string", enum: ["MOBILE", "DESKTOP"] },
  },
  required: ["projectId", "prompt"],
};

function provider(delayMs: number, seen: { calls: number } = { calls: 0 }): ToolProvider {
  const tools = ["generate_screen", "get_thing", "list_things", "fail_rate", "fail_args"];
  return {
    listTools: async () => tools.map((name) => ({ name, description: `${name} for designs and screens`, inputSchema: schema })),
    callTool: async (name, _a, o) => {
      seen.calls++;
      if (name === "generate_screen") {
        for (let i = 1; i <= 3; i++) {
          await sleep(delayMs / 3);
          o?.onProgress?.({ progress: i, total: 3 });
        }
      }
      if (name === "fail_rate") return { isError: true, content: [{ type: "text", text: "rate limited, retry later" }] };
      if (name === "fail_args") return { isError: true, content: [{ type: "text", text: "MCP error -32602: Invalid arguments for tool fail_args: projectId required" }] };
      return { content: [{ type: "text", text: JSON.stringify({ ok: name }) }] };
    },
  };
}

async function boot(delayMs: number, jobs: Record<string, unknown> = {}) {
  const home = tmp();
  const seen = { calls: 0 };
  const cfg = MycelConfig.parse({ refs: { dir: join(home, "refs") }, pinning: { enabled: false }, budget: { perDayUsd: 10 }, router: { mode: "meta" }, jobs });
  const m = await new Mycel({ config: cfg, path: null, home }, { noConnect: true, providers: { d: { provider: provider(delayMs, seen), tools: { generate_screen: { async: true, costUsd: 0.4, effect: "write" } } as never } } }).start();
  return { m, seen };
}
const metaTool = (m: Mycel, name: string) => META_TOOLS(m).find((t) => t.name === name)!;

describe("inline wait for async tools", () => {
  it("returns the result inline when the job finishes within inlineWaitMs (no mycel_job turn), charged once", async () => {
    const { m } = await boot(300, { inlineWaitMs: 5000 });
    const out = await m.call("d.generate_screen", { projectId: "1", prompt: "x" });
    expect(out.status).toBe("ok");
    expect(m.budget.spent().day).toBe(0.4);
    expect(m.jobs.list().filter((j) => j.status === "succeeded")).toHaveLength(1);
  });

  it("defaults to 120 s when nothing is configured; asyncThresholdMs still works as an alias", async () => {
    expect((await boot(10)).m.inlineWaitMs()).toBe(120_000);
    expect((await boot(10, { asyncThresholdMs: 3000 })).m.inlineWaitMs()).toBe(3000);
    expect((await boot(10, { asyncThresholdMs: 3000, inlineWaitMs: 7000 })).m.inlineWaitMs()).toBe(7000);
  });

  it("returns a job id only when the wait runs out, and the job keeps running to success", async () => {
    const { m } = await boot(400, { inlineWaitMs: 50 });
    const out = await m.call("d.generate_screen", { projectId: "1", prompt: "x" });
    expect(out.status).toBe("job");
    const id = (out as { job: { id: string } }).job.id;
    expect((await m.jobs.wait(id, 3000)).status).toBe("succeeded");
    expect(m.budget.spent().day).toBe(0.4);
  });

  it("per-call wait overrides the config, both ways (mycel_call arg is in seconds)", async () => {
    const { m } = await boot(400, { inlineWaitMs: 50 });
    const call = metaTool(m, "mycel_call");
    const ok = (await call.handler({ tool: "d.generate_screen", args: { projectId: "1", prompt: "x" }, wait: 5 }, {})) as { status: string };
    expect(ok.status).toBe("ok");
    const { m: m2 } = await boot(400, { inlineWaitMs: 5000 });
    const job = (await metaTool(m2, "mycel_call").handler({ tool: "d.generate_screen", args: { projectId: "1", prompt: "x" }, wait: 0 }, {})) as { status: string };
    expect(job.status).toBe("job");
  });

  it("sends progress heartbeats while waiting inline", async () => {
    const { m } = await boot(500, { inlineWaitMs: 5000, heartbeatMs: 100 });
    const beats: Array<{ progress: number; message?: string }> = [];
    const out = await m.call("d.generate_screen", { projectId: "1", prompt: "x" }, { onProgress: (p) => beats.push(p) });
    expect(out.status).toBe("ok");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.map((b) => b.progress)).toEqual([...beats.map((b) => b.progress)].sort((a, b) => a - b));
    expect(new Set(beats.map((b) => b.progress)).size).toBe(beats.length); // strictly increasing
    expect(beats[0].message).toMatch(/d\.generate_screen still running/);
  });

  it("mode async still returns the job at once", async () => {
    const { m } = await boot(300, { inlineWaitMs: 5000 });
    expect((await m.call("d.generate_screen", { projectId: "1", prompt: "x" }, { mode: "async" })).status).toBe("job");
  });

  it("mycel_job wait takes several ids", async () => {
    const { m } = await boot(300, { inlineWaitMs: 50 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(((await m.call("d.generate_screen", { projectId: "1", prompt: String(i) }, { mode: "async" })) as { job: { id: string } }).job.id);
    const views = (await metaTool(m, "mycel_job").handler({ action: "wait", ids, timeoutMs: 5000 }, {})) as Array<{ id: string; status: string }>;
    expect(views.map((v) => v.id)).toEqual(ids);
    expect(views.every((v) => v.status === "succeeded")).toBe(true);
  });
});

describe("mycel_search returns what a direct call needs", () => {
  it("limit <= 3 gives the top hits their compact input schema (with descriptions); a wider search stays compact", async () => {
    const { m } = await boot(10);
    const narrow = m.search("generate screen", { limit: 2 }) as Array<Record<string, unknown>>;
    expect(narrow).toHaveLength(2);
    const s = narrow[0].schema as { required: string[]; properties: Record<string, { type?: string; description?: string; enum?: string[] }> };
    expect(s.required).toEqual(["projectId", "prompt"]);
    expect(s.properties.projectId).toMatchObject({ type: "string", description: "Numeric project id" });
    expect(s.properties.deviceType.enum).toEqual(["MOBILE", "DESKTOP"]);
    expect(narrow[0].params).toBeUndefined();
    const wide = m.search("generate screen", { limit: 8 }) as Array<Record<string, unknown>>;
    expect(wide[0].schema).toBeUndefined();
    // array items and small nested objects are visible in the one-line form too (they were `array` / `any` before)
    expect(wide[0].params).toContain("screenIds?: string[]");
    expect(wide[0].params).toContain("options?: { dark?: boolean, size: integer }");
  });

  it("queries: several searches in one call, merged without duplicates", async () => {
    const { m } = await boot(10);
    const search = metaTool(m, "mycel_search");
    const r = (await search.handler({ queries: ["generate screen", "get thing", "list things"], limit: 1 }, {})) as Array<{ tool: string }>;
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.map((x) => x.tool)).size).toBe(r.length);
    await expect(search.handler({}, {})).rejects.toThrow(/query/);
  });
});

describe("argument errors carry the schema", () => {
  it("missing required args: error lists them and includes the compact schema (no upstream round trip needed to learn it)", async () => {
    const { m } = await boot(10);
    const out = (await m.call("d.get_thing", { prompt: "x" })) as { status: string; ok?: boolean };
    // the call is still forwarded (the upstream is the authority), here it succeeds; only failures get the schema
    expect(out.status).toBe("ok");
    const bad = (await m.call("d.fail_args", { prompt: "x" })) as { status: string; missingRequired?: string[]; inputSchema?: { required: string[]; properties: Record<string, unknown> } };
    expect(bad.status).toBe("error");
    expect(bad.missingRequired).toEqual(["projectId"]);
    expect(bad.inputSchema?.required).toEqual(["projectId", "prompt"]);
    expect(Object.keys(bad.inputSchema!.properties)).toContain("deviceType");
  });

  it("an upstream error that is about validation includes the schema even when args look complete", async () => {
    const { m } = await boot(10);
    const bad = (await m.call("d.fail_args", { projectId: "1", prompt: "x" })) as { status: string; missingRequired?: string[]; inputSchema?: unknown };
    expect(bad.status).toBe("error");
    expect(bad.missingRequired).toBeUndefined();
    expect(bad.inputSchema).toBeDefined();
  });

  it("an unrelated error (rate limit) does not pay for the schema", async () => {
    const { m } = await boot(10);
    const bad = (await m.call("d.fail_rate", { projectId: "1", prompt: "x" })) as { status: string; inputSchema?: unknown };
    expect(bad.status).toBe("error");
    expect(bad.inputSchema).toBeUndefined();
  });
});

describe("json digest keys", () => {
  it("surfaces ids/names that the depth-limited sample hides, by path, capped", async () => {
    const { RefStore } = await import("../src/refs.js");
    const s = new RefStore(tmp());
    const v = { projectId: "p1", outputComponents: [{ text: "x" }, { design: { screens: [{ id: "s1", name: "projects/p1/screens/s1", title: "Login", htmlCode: { name: "projects/p1/files/f1", mimeType: "text/html" }, junk: "z".repeat(5000) }] } }] };
    const d = s.putJson(v).digest as { keys?: Record<string, string>; sample: unknown };
    expect(d.keys).toMatchObject({
      "$.outputComponents[1].design.screens[0].id": "s1",
      "$.outputComponents[1].design.screens[0].htmlCode.name": "projects/p1/files/f1",
    });
    // nothing to add for shallow data (the sample already shows it) or for long strings
    expect((s.putJson({ id: 1, name: "a", rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `n${i}` })) }).digest as { keys?: unknown }).keys).toBeUndefined();
    const many = { a: { b: { c: Array.from({ length: 50 }, (_, i) => ({ id: `id${i}` })) } } };
    expect(Object.keys((s.putJson(many).digest as { keys: Record<string, string> }).keys).length).toBeLessThanOrEqual(10);
  });
});
