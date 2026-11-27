import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMcpServer } from "../src/server.js";
import { estimateTokens } from "../src/catalog.js";
import { measure, formatSavingsLine, formatStats, SavingsTracker, ESTIMATE_CAVEAT } from "../src/savings.js";
import { Recorder } from "../src/recorder.js";
import { parseConfig } from "../src/config.js";
import { makeMycel, tmp } from "./helpers.js";

const csv = ["id,region,revenue", ...Array.from({ length: 3000 }, (_, i) => `${i},${["EU", "US"][i % 2]},${i * 3}`)].join("\n");

async function connect(config: Record<string, unknown> = {}) {
  const w = await makeMycel(
    {
      warehouse: { tools: [{ name: "export_csv", description: "Export a CSV", handler: () => csv }, { name: "ping", description: "Ping", handler: () => "ok" }] },
      many: { tools: Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}`, description: `A fairly long description of tool number ${i} so that definitions cost tokens` })) },
    },
    { pinning: { enabled: false }, router: { mode: "meta" }, ...config },
  );
  const server = createMcpServer(w.m);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return { ...w, client };
}
type Content = Array<{ type: string; text: string }>;

describe("savings computation", () => {
  it("measures exact numbers and never turns growth into savings", () => {
    expect(measure(13240, 1710)).toEqual({ rawTokens: 13240, returnedTokens: 1710, savedTokens: 11530, addedTokens: 0, pct: 87 });
    expect(measure(40, 66)).toEqual({ rawTokens: 40, returnedTokens: 66, savedTokens: 0, addedTokens: 26, pct: 0 });
    expect(measure(50, 50)).toEqual({ rawTokens: 50, returnedTokens: 50, savedTokens: 0, addedTokens: 0, pct: 0 });
    expect(measure(0, 12).addedTokens).toBe(12);
  });

  it("formats the one-line summary", () => {
    const t = new SavingsTracker();
    const s = t.record(measure(13240, 1710));
    expect(formatSavingsLine(measure(13240, 1710), s, 202_345)).toBe("Mycel · this call: 13,240 → 1,710 tokens (−87%, measured) · session: −11,530 tokens measured · tool definitions: ~−202k/turn (estimated)");
    expect(formatSavingsLine(measure(40, 66), { calls: 1, savedTokens: 0, addedTokens: 26, netTokens: -26 }, 0)).toBe("Mycel · this call: 40 → 66 tokens (+26, measured) · session: +26 tokens measured");
    expect(formatSavingsLine(measure(50, 50), { calls: 1, savedTokens: 0, addedTokens: 0, netTokens: 0 }, 850)).toBe("Mycel · this call: 50 → 50 tokens (no change, measured) · session: 0 tokens measured · tool definitions: ~−850/turn (estimated)");
  });

  it("session totals net saved against added, and uncounted calls do not count", () => {
    const t = new SavingsTracker();
    t.record(measure(1000, 100));
    t.record(measure(10, 40));
    t.record(measure(5000, 0), false);
    expect(t.snapshot()).toEqual({ calls: 2, savedTokens: 900, addedTokens: 30, netTokens: 870 });
    t.noteToolsList(500);
    t.noteToolsList(500);
    expect(t.toolsListServed()).toBe(2);
  });

  it("defaults ui.savingsLine to false", () => {
    expect(parseConfig("").ui.savingsLine).toBe(false);
    expect(parseConfig("ui: { savingsLine: true }").ui.savingsLine).toBe(true);
  });
});

describe("savings through the gateway", () => {
  it("a big CSV result produces measured savings, in _meta and in the flight log, without changing the text", async () => {
    const { client, m } = await connect();
    const r = await client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.export_csv", args: {} } });
    const content = r.content as Content;
    expect(content).toHaveLength(1); // opt-in line is off
    const meta = (r._meta as { "mycel/savings": { line: string; measured: ReturnType<typeof measure>; session: { netTokens: number }; estimated: { toolDefinitionTokensPerTurn: number; label: string } } })["mycel/savings"];
    expect(meta.measured.rawTokens).toBe(estimateTokens(csv.length ? [{ type: "text", text: csv }] : []));
    expect(meta.measured.returnedTokens).toBe(estimateTokens(JSON.parse(content[0].text) && content[0].text));
    expect(meta.measured.savedTokens).toBe(meta.measured.rawTokens - meta.measured.returnedTokens);
    expect(meta.measured.savedTokens).toBeGreaterThan(8000);
    expect(meta.measured.pct).toBeGreaterThan(90);
    expect(meta.session.netTokens).toBe(meta.measured.savedTokens);
    expect(meta.estimated.label).toBe(ESTIMATE_CAVEAT);
    expect(meta.line).toMatch(/^Mycel · this call: .* → .* tokens \(−\d+%, measured\) · session: −.* tokens measured/);
    console.log("sample line:", meta.line);
    const ev = m.recorder.load({ days: 1 }).filter((e) => e.savings?.measured);
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("job"); // export_csv is inferred async: the savings ride on the job's delivery event
    expect(ev[0].savings).toMatchObject({ session: m.sessionId, measured: { savedTokens: meta.measured.savedTokens } });
  });

  it("a small result is reported as added tokens, never as a saving", async () => {
    const { client, m } = await connect();
    const r = await client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.ping", args: {} } });
    const meta = (r._meta as Record<string, { measured: { savedTokens: number; addedTokens: number }; line: string; session: { netTokens: number } }>)["mycel/savings"];
    expect(meta.measured.savedTokens).toBe(0);
    expect(meta.measured.addedTokens).toBeGreaterThan(0);
    expect(meta.session.netTokens).toBe(-meta.measured.addedTokens);
    expect(meta.line).toContain(`(+${meta.measured.addedTokens}, measured)`);
    expect(meta.line).toContain(`session: +${meta.measured.addedTokens} tokens measured`);
    const ev = m.recorder.load({ days: 1 }).filter((e) => e.savings?.measured);
    expect(ev.map((e) => e.kind)).toEqual(["call"]);
    expect(ev[0].savings!.measured).toEqual(meta.measured);
  });

  it("the line is appended to the content only when ui.savingsLine is on", async () => {
    const off = await connect();
    const a = (await off.client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.export_csv", args: {} } })).content as Content;
    expect(a.some((c) => c.text.startsWith("Mycel ·"))).toBe(false);

    const on = await connect({ ui: { savingsLine: true } });
    const r = await on.client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.export_csv", args: {} } });
    const b = r.content as Content;
    expect(b).toHaveLength(2);
    expect(b[1].text).toBe((r._meta as Record<string, { line: string }>)["mycel/savings"].line);
    console.log(`line costs ${estimateTokens(b[1].text)} tokens`);
  });

  it("calls inside mycel_run are counted once, as the run", async () => {
    const { client, m } = await connect();
    const r = await client.callTool({ name: "mycel_run", arguments: { code: `const a = await tools.call("warehouse.export_csv", {}); const b = await tools.call("warehouse.export_csv", {}); return { n: a.length + b.length };` } });
    const meta = (r._meta as Record<string, { measured: { rawTokens: number; savedTokens: number } }>)["mycel/savings"];
    const one = estimateTokens([{ type: "text", text: csv }]);
    expect(meta.measured.rawTokens).toBe(2 * one);
    expect(meta.measured.savedTokens).toBeGreaterThan(2 * one - 100);
    const evs = m.recorder.load({ days: 1 }).filter((e) => e.savings?.measured);
    expect(evs.filter((e) => e.savings!.counted === false)).toHaveLength(2);
    expect(m.recorder.historicalStats(1).measured.calls).toBe(1);
    expect(m.savings.snapshot().calls).toBe(1);
  });

  it("the legacy tokensSaved counter is measured-net only: no estimate, no double count", async () => {
    const { client, m } = await connect();
    await client.listTools();
    await client.callTool({ name: "mycel_run", arguments: { code: `await tools.call("warehouse.export_csv", {}); await tools.call("warehouse.export_csv", {}); return 1;` } });
    await client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.ping", args: {} } });
    const s = m.recorder.liveStats();
    expect(s.measured.calls).toBe(2);
    expect(s.tokensSaved).toBe(s.measured.savedTokens - s.measured.addedTokens);
    expect(s.tokensSaved).toBe(m.savings.snapshot().netTokens);
    const evs = m.recorder.load({ days: 1 });
    expect(evs.filter((e) => e.savings?.counted === false).every((e) => e.tokensSaved === undefined)).toBe(true);
    expect(evs.filter((e) => e.savings?.estimated).every((e) => e.tokensSaved === undefined)).toBe(true);
    expect(evs.reduce((a, e) => a + (e.tokensSaved ?? 0), 0)).toBe(s.measured.savedTokens);
  });

  it("errors and searches carry no savings", async () => {
    const { client } = await connect();
    const e = await client.callTool({ name: "mycel_call", arguments: { tool: "nope.nothing", args: {} } });
    expect(e._meta).toBeUndefined();
    const s = await client.callTool({ name: "mycel_search", arguments: { query: "csv" } });
    expect(s._meta).toBeUndefined();
  });

  it("tools/list records the estimated definition savings per list served", async () => {
    const { client, m } = await connect();
    await client.listTools();
    await client.listTools();
    const lists = m.recorder.load({ days: 1 }).filter((e) => e.savings?.estimated);
    expect(lists).toHaveLength(2);
    expect(lists[0].savings!.estimated!.perTurnTokens).toBeGreaterThan(0);
    expect(m.recorder.liveStats().estimated.toolsListServed).toBe(2);
    expect(m.recorder.liveStats().measured.calls).toBe(0); // estimated is never mixed into measured
    const r = await client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.ping", args: {} } });
    const meta = (r._meta as Record<string, { estimated: { toolDefinitionTokensPerTurn: number } }>)["mycel/savings"];
    expect(meta.estimated.toolDefinitionTokensPerTurn).toBe(lists[1].savings!.estimated!.perTurnTokens);
  });
});

describe("mycel stats", () => {
  it("reports session and day totals, measured and estimated apart", async () => {
    const { client, m, home } = await connect();
    await client.listTools();
    await client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.export_csv", args: {} } });
    await client.callTool({ name: "mycel_call", arguments: { tool: "warehouse.ping", args: {} } });
    const rec = new Recorder(join(home, "traces"), { enabled: false, redact: true });
    const report = rec.savingsReport();
    expect(report.session!.id).toBe(m.sessionId);
    expect(report.session!.measured.calls).toBe(2);
    expect(report.session!.measured.netTokens).toBe(m.savings.snapshot().netTokens);
    expect(report.session!.estimated.toolsListServed).toBe(1);
    expect(report.day.measured.calls).toBe(2);
    const text = formatStats(report);
    expect(text).toMatch(/measured {4}−[\d,]+ tokens net over 2 calls/);
    expect(text).toMatch(/estimated {3}~−[\d,]+ tokens of tool definitions over 1 tools\/list served/);
    expect(text).toContain(ESTIMATE_CAVEAT);

    const cli = join(__dirname, "..", "dist", "cli.js");
    if (existsSync(cli)) {
      const r = spawnSync(process.execPath, [cli, "stats"], { encoding: "utf8", cwd: tmp(), env: { ...process.env, MYCEL_HOME: home } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(text + "\n");
      console.log(r.stdout);
    }
  });
});
