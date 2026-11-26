#!/usr/bin/env node
// A mock data-warehouse MCP server (stdio). `query` returns a 5,000-row CSV
// (~300 KB), which Mycel stores as a ref and replaces with a table digest.
import { defineAdapter } from "../../dist/index.js";

const REGIONS = ["us-east", "us-west", "eu-central", "eu-west", "ap-south", "ap-northeast"];
const PLANS = ["starter", "team", "enterprise"];

// Small deterministic PRNG so every run returns the same table.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function ordersCsv(rows) {
  const r = rng(42);
  const start = Date.UTC(2026, 0, 1);
  const lines = ["order_id,created_at,customer_id,region,plan,seats,amount_usd,refunded"];
  for (let i = 1; i <= rows; i++) {
    const plan = PLANS[Math.floor(r() * (r() < 0.6 ? 1.5 : 3))];
    const seats = plan === "starter" ? 1 : 1 + Math.floor(r() * (plan === "team" ? 40 : 400));
    const amount = plan === "starter" ? 0 : plan === "team" ? seats * 29 : Math.round(seats * (45 + r() * 30));
    lines.push([
      `ord_${String(i).padStart(5, "0")}`,
      new Date(start + Math.floor(r() * 300) * 86_400_000).toISOString().slice(0, 10),
      `cus_${String(Math.floor(r() * 1800)).padStart(4, "0")}`,
      REGIONS[Math.floor(r() * REGIONS.length)],
      plan,
      seats,
      amount,
      r() < 0.03 ? 1 : 0,
    ].join(","));
  }
  return lines.join("\n") + "\n";
}

defineAdapter({
  name: "warehouse-mock",
  tools: [
    {
      name: "query",
      description: "Run a read-only SQL query against the analytics warehouse. Returns CSV.",
      effect: "read",
      input: { type: "object", properties: { sql: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 5000 } } },
      // The mock ignores the SQL and always returns the orders table.
      run: async ({ limit = 5000 }) => ordersCsv(Math.min(Number(limit) || 5000, 5000)),
    },
  ],
}).serve();
