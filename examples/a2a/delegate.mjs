#!/usr/bin/env node
// Agent A delegates to agent B over A2A — the library equivalent of the model calling
//   mycel_delegate { agent: "builder", data: { tool: "github.list_issues", args: {} } }
//
// Prereqs (see README): agent B running on :4801, BUILDER_TOKEN exported.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, Mycel, inspect } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.BUILDER_TOKEN) {
  console.error("Set BUILDER_TOKEN first (mint it with agent B's MYCEL_TOKEN_SECRET; see README.md).");
  process.exit(1);
}

const m = await new Mycel(loadConfig(join(here, "agent-a.yaml"))).start();
const meta = (await import("../../dist/meta.js")).META_TOOLS(m).map((t) => t.name);
console.log(`planner meta-tools: ${meta.join(", ")}`);
console.log(`delegating with token rights: ${JSON.stringify(inspect(process.env.BUILDER_TOKEN).effective)}\n`);

// 1) What can builder do? (Agent Card)
const card = await m.peers.card("builder");
console.log(`builder card: ${card.name} — ${card.description}`);
for (const s of card.skills) console.log(`  skill ${s.id.padEnd(10)} ${s.description}`);

// 2) Delegate a read: list issues.
const list = await m.delegate("builder", { data: { tool: "github.list_issues", args: {} } });
const task = list.data ?? list; // peer results come back wrapped as provenance: untrusted
const artifact = task.artifacts?.[0]?.content?.[0];
console.log(`\nlist_issues → task ${task.state} · provenance ${list.provenance ?? "trusted"}`);
if (artifact?.ref) console.log(`  artifact: ${artifact.ref} (${artifact.mime}, ${artifact.size}, ${artifact.digest.length} issues)`);
else if (Array.isArray(artifact)) console.log(`  artifact: ${artifact.length} issues inline`);
// Note: a ref:// handle lives in builder's ref store, not ours. To get the data itself,
// ask builder to do the work where the data is and send back only the answer:

// 3) Delegate a code-mode script: builder runs it in its sandbox, under our token.
const code = `const issues = await tools.call("github.list_issues", {});
const stale = issues.filter((i) => daysSince(i.updated_at) > 45);
return { open: issues.length, stale: stale.length, oldest: stale.sort((a, b) => a.updated_at.localeCompare(b.updated_at))[0].title };`;
const summary = await m.delegate("builder", { data: { code } });
const st = summary.data ?? summary;
console.log(`code-mode → task ${st.state}: ${JSON.stringify(st.artifacts?.[0]?.content?.[0])}`);

// 4) Delegate a write the token does not allow.
const write = await m.delegate("builder", { data: { tool: "github.close_issue", args: { number: 100 } } });
const wt = write.data ?? write;
console.log(`close_issue → task ${wt.state}: ${wt.message?.[0] ?? ""}`);

await m.close();
const okRun = task.state === "completed" && st.state === "completed" && wt.state === "rejected";
console.log(okRun ? "\n✓ delegation works and the token's limits hold" : "\n✗ unexpected result");
process.exit(okRun ? 0 : 1);
