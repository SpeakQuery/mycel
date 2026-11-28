import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const PKG = "@speakquery/mycel";

/** The running version, read from package.json (always shipped). */
export const VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

export function mycelHomeDir(): string {
  return process.env.MYCEL_HOME ? resolve(process.env.MYCEL_HOME) : join(homedir(), ".mycel");
}
/** Private copy used by the installer and the Claude Desktop extension. */
export const appDir = () => join(mycelHomeDir(), "app");
export const appCli = () => join(appDir(), "node_modules", "@speakquery", "mycel", "dist", "cli.js");
const stateFile = () => join(mycelHomeDir(), "update.json");

/** -1, 0, 1 for plain x.y.z versions (pre-release tags sort before the release). */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { n: core.split(".").map((x) => Number(x) || 0), pre: pre ?? "" };
  };
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) < (y.n[i] ?? 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  return x.pre === "" ? 1 : y.pre === "" ? -1 : x.pre < y.pre ? -1 : 1;
}

export async function latestVersion(timeoutMs = 4000): Promise<string | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${PKG.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const v = ((await r.json()) as { version?: string }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

interface UpdateState {
  checkedAt?: string;
  latest?: string;
  installed?: string;
  error?: string;
}
export function readUpdateState(): UpdateState {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}
function writeState(s: UpdateState) {
  try {
    mkdirSync(mycelHomeDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(s, null, 2));
  } catch {
    /* best effort */
  }
}

/** True when this process runs from the private copy in ~/.mycel/app (installer or extension), which Mycel may update itself. */
export function runningFromApp(script = process.argv[1]): boolean {
  if (!script) return false;
  try {
    return realpathSync(script).startsWith(realpathSync(appDir()) + sep);
  } catch {
    return false;
  }
}

/** npm next to the running Node (installer layout), else npm on PATH. */
function npmCommand(): { cmd: string; args: string[] } {
  const win = process.platform === "win32";
  const local = join(dirname(process.execPath), win ? "npm.cmd" : "npm");
  if (existsSync(local)) return { cmd: local, args: [] };
  return { cmd: win ? "npm.cmd" : "npm", args: [] };
}
function installArgs(version: string) {
  return ["install", "--prefix", appDir(), "--no-fund", "--no-audit", "--loglevel=error", `${PKG}@${version}`];
}
const npmEnv = () => ({ ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` });

/**
 * Called when the gateway starts. At most once a day: look up the latest version; when the private copy is older,
 * update it in the background (the new version is used from the next start). Never blocks or fails the gateway.
 */
export async function autoUpdate(opts: { enabled: boolean; log: (s: string) => void; force?: boolean; spawnFn?: typeof spawn }): Promise<{ checked: boolean; latest?: string; updating?: boolean }> {
  if (!opts.enabled || process.env.MYCEL_NO_UPDATE === "1") return { checked: false };
  const st = readUpdateState();
  const last = st.checkedAt ? Date.parse(st.checkedAt) : 0;
  if (!opts.force && Date.now() - last < 24 * 3600 * 1000) {
    if (st.latest && compareVersions(VERSION, st.latest) < 0 && !runningFromApp()) opts.log(`Mycel ${st.latest} is available (you run ${VERSION}). Update with: mycel update`);
    return { checked: false, latest: st.latest };
  }
  const latest = await latestVersion();
  writeState({ ...st, checkedAt: new Date().toISOString(), ...(latest ? { latest } : {}) });
  if (!latest || compareVersions(VERSION, latest) >= 0) return { checked: true, latest: latest ?? undefined };
  if (!runningFromApp() && process.env.MYCEL_EXTENSION !== "1") {
    opts.log(`Mycel ${latest} is available (you run ${VERSION}). Update with: mycel update`);
    return { checked: true, latest };
  }
  const npm = npmCommand();
  try {
    const child = (opts.spawnFn ?? spawn)(npm.cmd, [...npm.args, ...installArgs(latest)], { stdio: "ignore", detached: true, env: npmEnv(), shell: process.platform === "win32" });
    child.on?.("error", (e) => writeState({ ...readUpdateState(), error: e.message }));
    child.on?.("exit", (code) => writeState({ ...readUpdateState(), ...(code === 0 ? { installed: latest, error: undefined } : { error: `npm exited with ${code}` }) }));
    child.unref?.();
    opts.log(`Updating Mycel ${VERSION} → ${latest} in the background; it is used from the next start.`);
    return { checked: true, latest, updating: true };
  } catch (e) {
    writeState({ ...readUpdateState(), error: (e as Error).message });
    return { checked: true, latest };
  }
}

/** `mycel update`: update the private copy now, or explain how for npx / global installs. */
export async function runUpdate(out: (s: string) => void): Promise<number> {
  const latest = await latestVersion(10000);
  if (!latest) {
    out("  Could not reach the npm registry. Try again later.");
    return 1;
  }
  const installed = existsSync(appCli()) ? (JSON.parse(readFileSync(join(dirname(appCli()), "..", "package.json"), "utf8")) as { version: string }).version : null;
  const current = installed ?? VERSION;
  if (compareVersions(current, latest) >= 0) {
    out(`  Mycel is up to date (${current}).`);
    return 0;
  }
  if (!installed) {
    out(`  Mycel ${latest} is available (you run ${VERSION}).`);
    out("  Apps started with `npx -y @speakquery/mycel@latest` pick it up on their next start.");
    out("  Installed with npm -g? Run: npm i -g @speakquery/mycel@latest");
    return 0;
  }
  out(`  Updating Mycel ${current} → ${latest}…`);
  const npm = npmCommand();
  const r = spawnSync(npm.cmd, [...npm.args, ...installArgs(latest)], { stdio: "inherit", env: npmEnv(), shell: process.platform === "win32" });
  if (r.status !== 0) {
    out("  ✗ Update failed. Your current version keeps working.");
    return 1;
  }
  writeState({ ...readUpdateState(), checkedAt: new Date().toISOString(), latest, installed: latest, error: undefined });
  out(`  ✓ Mycel ${latest} installed. Restart your apps to use it.`);
  return 0;
}
