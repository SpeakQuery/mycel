// Mycel for Claude Desktop: launcher inside the .mcpb extension.
// Runs the newest Mycel available: the private copy in ~/.mycel/app (kept up to date by Mycel itself)
// when it is newer than the copy bundled in this extension, otherwise the bundled one.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rel = ["node_modules", "@speakquery", "mycel", "dist", "cli.js"];
const bundled = join(here, "..", ...rel);
const home = process.env.MYCEL_HOME || join(homedir(), ".mycel");
const app = join(home, "app", ...rel);

const versionOf = (cli) => {
  try {
    return JSON.parse(readFileSync(join(dirname(cli), "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
};
const newer = (a, b) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

const cli = existsSync(app) && newer(versionOf(app), versionOf(bundled)) ? app : bundled;
process.env.MYCEL_EXTENSION = "1";
process.argv = [process.argv[0], cli, "serve"];
await import(pathToFileURL(cli).href);
