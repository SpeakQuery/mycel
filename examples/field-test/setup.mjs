// Creates the test data: a 20,000-row CSV, 15 notes (5 stale) and a tiny git repo.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
mkdirSync("data", { recursive: true });
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const rows = ["id,region,product,units,revenue"];
for (let i = 0; i < 20000; i++) rows.push([i, pick(["EU", "US", "APAC", "TR"]), `sku-${1 + Math.floor(rnd() * 300)}`, 1 + Math.floor(rnd() * 50), (5 + rnd() * 895).toFixed(2)].join(","));
writeFileSync("data/sales.csv", rows.join("\n") + "\n");
for (let i = 0; i < 15; i++) writeFileSync(`data/note-${i}.md`, `# Note ${i}\nstatus: ${i % 3 === 0 ? "stale" : "fresh"}\n`);
if (!existsSync("gitrepo/.git")) {
  mkdirSync("gitrepo", { recursive: true });
  writeFileSync("gitrepo/README.md", "# lab\n");
  const git = (...a) => execFileSync("git", a, { cwd: "gitrepo", stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=lab@example.com", "-c", "user.name=lab", "commit", "-qm", "init");
}
console.log("Test data ready.");
