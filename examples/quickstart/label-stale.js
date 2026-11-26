// Code mode: one script, many tool calls, one small result back to the model.
// Run with:  node ../../dist/cli.js run label-stale.js
// Inside the sandbox you get `tools`, `refs`, `jobs`, `console`, `daysSince`, `chunk`, `pick`.
// No network, no filesystem: every call goes through Mycel's policy layer.

const issues = await tools.call("github.list_issues", { state: "open" });
const stale = issues.filter((i) => daysSince(i.updated_at) > 45);
console.log(`${issues.length} open issues, ${stale.length} not updated in 45+ days`);

for (const issue of stale) {
  await tools.call("github.add_label", { number: issue.number, label: "stale" });
}

return {
  labelled: stale.length,
  issues: stale.map((i) => `#${i.number} ${i.title} (${Math.floor(daysSince(i.updated_at))}d)`).slice(0, 5),
  more: Math.max(0, stale.length - 5),
};
