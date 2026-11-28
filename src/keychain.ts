import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { mycelHomeDir } from "./update.js";

/**
 * API keys in the operating system's keychain instead of a file:
 * macOS Keychain (`security`), Linux Secret Service (`secret-tool`). Windows and systems without one keep the
 * private secrets file. Values never appear on a command line: they go through stdin.
 * Every entry uses service "mycel" and the secret's name as the account.
 */
const SERVICE = "mycel";

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

export function keychainKind(): "macos" | "secret-service" | null {
  if (process.env.MYCEL_NO_KEYCHAIN === "1") return null;
  if (process.platform === "darwin" && (existsSync("/usr/bin/security") || onPath("security"))) return "macos";
  if (process.platform === "linux" && onPath("secret-tool") && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_RUNTIME_DIR)) return "secret-service";
  return null;
}

const indexFile = () => join(mycelHomeDir(), "keychain.json");
/** Names (never values) Mycel stored in the keychain, so uninstall can remove them. */
export function keychainNames(): string[] {
  try {
    return (JSON.parse(readFileSync(indexFile(), "utf8")) as { names?: string[] }).names ?? [];
  } catch {
    return [];
  }
}
function saveNames(names: string[]) {
  mkdirSync(mycelHomeDir(), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify({ service: SERVICE, names: [...new Set(names)].sort() }, null, 2) + "\n");
}

const securityBin = () => (existsSync("/usr/bin/security") ? "/usr/bin/security" : "security");

export function keychainGet(name: string): string | undefined {
  const k = keychainKind();
  try {
    if (k === "macos") return execFileSync(securityBin(), ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).replace(/\n$/, "");
    if (k === "secret-service") {
      const v = execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
      return v === "" ? undefined : v.replace(/\n$/, "");
    }
  } catch {
    /* not found or locked */
  }
  return undefined;
}

/** Store one secret. Returns false when it could not (caller falls back to the private file). */
export function keychainSet(name: string, value: string): boolean {
  const k = keychainKind();
  if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(value)) return false;
  let ok = false;
  if (k === "macos") {
    // `security -i` reads commands from stdin, so the value never shows up in the process list.
    if (/["\\]/.test(value)) return false;
    const r = spawnSync(securityBin(), ["-i"], { input: `add-generic-password -U -s ${SERVICE} -a ${name} -l "Mycel ${name}" -w "${value}"\n`, stdio: ["pipe", "ignore", "ignore"], timeout: 15000 });
    ok = r.status === 0;
  } else {
    const r = spawnSync("secret-tool", ["store", `--label=Mycel ${name}`, "service", SERVICE, "account", name], { input: value, stdio: ["pipe", "ignore", "ignore"], timeout: 15000 });
    ok = r.status === 0;
  }
  ok = ok && keychainGet(name) === value;
  if (ok) saveNames([...keychainNames(), name]);
  return ok;
}

/** Remove every secret Mycel stored. Returns how many were removed. */
export function keychainRemoveAll(): number {
  const k = keychainKind();
  let n = 0;
  for (const name of keychainNames()) {
    try {
      if (k === "macos") execFileSync(securityBin(), ["delete-generic-password", "-s", SERVICE, "-a", name], { stdio: "ignore", timeout: 10000 });
      else if (k === "secret-service") execFileSync("secret-tool", ["clear", "service", SERVICE, "account", name], { stdio: "ignore", timeout: 10000 });
      else continue;
      n++;
    } catch {
      /* already gone */
    }
  }
  if (k) saveNames([]);
  return n;
}
