import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { runSetup, runUndo, listBackups, restartPlan, findDesktopExtensions, pluginServers, mycelEntry } from "../src/setup.js";
import { formatSavingsLine, formatStats, measure, valueOf } from "../src/savings.js";

let home: string;
let cwd: string;
let saved: Record<string, string | undefined>;
let lines: string[];

const io = (interactive = false, answer = true) => ({ out: (s: string) => void lines.push(s), ask: async () => answer, interactive });
const put = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
  return s;
};
const rd = (p: string) => readFileSync(p, "utf8");
const srv = { command: "npx", args: ["-y", "some-server"], env: { API_KEY: "sk-SUPERSECRET-123", MODE: "x" } };
const mac = platform() === "darwin";
const win = platform() === "win32";
// Same locations as candidatePaths(): macOS Application Support, Windows %APPDATA% (pointed into the temp home below), Linux ~/.config.
const appDir = () => (mac ? join(home, "Library", "Application Support") : win ? join(home, "AppData", "Roaming") : join(home, ".config"));
const desktop = () => join(appDir(), "Claude", "claude_desktop_config.json");
const vscode = () => join(appDir(), "Code", "User", "mcp.json");

function fixtures() {
  return {
    desktop: put(desktop(), JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { files: { command: "fs-server", args: ["/tmp"] }, gh: srv } }, null, 2) + "\n"),
    claude: put(join(home, ".claude.json"), JSON.stringify({ numStartups: 4, mcpServers: { a: { command: "a-srv" } }, projects: { "/x": { allowedTools: [], mcpServers: { b: { command: "b-srv" } } } } }, null, 2)),
    cursor: put(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { c: { url: "https://example.com/mcp", headers: { Authorization: "Bearer tok-ABC" } } } }, null, 2) + "\n"),
    vscode: put(vscode(), JSON.stringify({ servers: { v: { command: "v-srv" } }, inputs: [] }, null, 2) + "\n"),
    windsurf: put(join(home, ".codeium", "windsurf", "mcp_config.json"), JSON.stringify({ mcpServers: { w: { command: "w-srv" } } }, null, 2) + "\n"),
    gemini: put(join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { g: { command: "g-srv" } } }, null, 2) + "\n"),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mycel-home-"));
  cwd = mkdtempSync(join(tmpdir(), "mycel-cwd-"));
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MYCEL_HOME: process.env.MYCEL_HOME, PATH: process.env.PATH, MYCEL_NO_CLAUDE_CLI: process.env.MYCEL_NO_CLAUDE_CLI, APPDATA: process.env.APPDATA };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  delete process.env.MYCEL_HOME;
  process.env.PATH = "/nonexistent-bin";
  process.env.MYCEL_NO_CLAUDE_CLI = "1";
  lines = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("mycel setup / undo", () => {
  it("rewrites each client to only the mycel entry, with backups and a manifest", async () => {
    const f = fixtures();
    await runSetup({ yes: true, cwd }, io());
    const mcfg = join(home, ".mycel", "mycel.yaml");
    const y = YAML.parse(rd(mcfg));
    expect(Object.keys(y.servers).sort()).toEqual(["a", "b", "c", "files", "g", "gh", "v", "w"]);
    expect(rd(mcfg)).not.toContain("SUPERSECRET");
    expect(rd(mcfg)).toContain("{{secret:API_KEY}}");

    const entry = { command: "npx", args: ["-y", "@speakquery/mycel", "serve", "--config", mcfg] };
    expect(JSON.parse(rd(desktop())).mcpServers).toEqual({ mycel: entry });
    expect(JSON.parse(rd(desktop())).globalShortcut).toBe("Ctrl+Space");
    const cl = JSON.parse(rd(join(home, ".claude.json")));
    expect(cl.mcpServers).toEqual({ mycel: entry });
    expect(cl.numStartups).toBe(4);
    expect(cl.projects["/x"].mcpServers).toEqual({});
    expect(cl.projects["/x"].allowedTools).toEqual([]);
    expect(JSON.parse(rd(join(home, ".cursor", "mcp.json"))).mcpServers).toEqual({ mycel: entry });
    const vs = JSON.parse(rd(vscode()));
    expect(vs.servers).toEqual({ mycel: entry });
    expect(vs.inputs).toEqual([]);
    expect(JSON.parse(rd(join(home, ".gemini", "settings.json"))).theme).toBe("dark");
    expect(lines.join("\n")).not.toContain("SUPERSECRET");
    expect(lines.join("\n")).toMatch(/Done\. Restart .*mycel stats .*mycel undo/);

    const [m] = listBackups();
    expect(m.files.length).toBe(6);
    const dir = join(home, ".mycel", "backups", m.id);
    for (const b of m.files) expect(rd(join(dir, b.backup))).toBe(Object.values(f).find((v) => v === rd(join(dir, b.backup))));
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);

    const r = readdirSync(join(home, ".mycel", "backups"));
    expect(r.length).toBe(1);
  });

  it("undo restores byte-identical files", async () => {
    const f = fixtures();
    await runSetup({ yes: true, cwd }, io());
    lines = [];
    await runUndo({}, io());
    expect(rd(desktop())).toBe(f.desktop);
    expect(rd(join(home, ".claude.json"))).toBe(f.claude);
    expect(rd(join(home, ".cursor", "mcp.json"))).toBe(f.cursor);
    expect(rd(vscode())).toBe(f.vscode);
    expect(rd(join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(f.windsurf);
    expect(rd(join(home, ".gemini", "settings.json"))).toBe(f.gemini);
    expect(lines.join("\n")).toContain("Restored 6 file(s)");
  });

  it("undo asks before overwriting a file changed since setup; --yes forces", async () => {
    const f = fixtures();
    await runSetup({ yes: true, cwd }, io());
    writeFileSync(desktop(), '{"mcpServers":{"mine":{"command":"x"}}}');
    await runUndo({}, io(false));
    expect(rd(desktop())).toContain("mine");
    expect(lines.join("\n")).toMatch(/changed since setup/);
    await runUndo({}, io(true, false));
    expect(rd(desktop())).toContain("mine");
    await runUndo({ yes: true }, io());
    expect(rd(desktop())).toBe(f.desktop);
  });

  it("skips JSONC files with comments instead of corrupting them", async () => {
    const f = fixtures();
    const jsonc = put(vscode(), '{\n  // my servers\n  "servers": { "v": { "command": "v-srv" } }, // trailing\n}\n');
    await runSetup({ yes: true, cwd }, io());
    expect(rd(vscode())).toBe(jsonc);
    expect(lines.join("\n")).toMatch(/contains comments/);
    expect(YAML.parse(rd(join(home, ".mycel", "mycel.yaml"))).servers.v).toBeUndefined();
    expect(JSON.parse(rd(desktop())).mcpServers.mycel).toBeTruthy();
    expect(f.desktop).not.toBe(rd(desktop()));
  });

  it("non-TTY without --yes changes nothing; declining the prompt changes nothing", async () => {
    const f = fixtures();
    await runSetup({ cwd }, io(false));
    expect(rd(desktop())).toBe(f.desktop);
    expect(existsSync(join(home, ".mycel"))).toBe(false);
    expect(lines.join("\n")).toMatch(/Dry run/);
    await runSetup({ cwd }, io(true, false));
    expect(rd(desktop())).toBe(f.desktop);
    expect(existsSync(join(home, ".mycel"))).toBe(false);
    await runSetup({ cwd }, io(true, true));
    expect(JSON.parse(rd(desktop())).mcpServers.mycel).toBeTruthy();
  });

  it("never overwrites an existing mycel.yaml; merges only new servers", async () => {
    fixtures();
    const mcfg = join(home, ".mycel", "mycel.yaml");
    put(mcfg, "# mine\nservers:\n  files:\n    command: custom\nbudget:\n  perTaskUsd: 1\n");
    await runSetup({ yes: true, cwd }, io());
    const t = rd(mcfg);
    expect(t).toContain("# mine");
    expect(t).toContain("perTaskUsd: 1");
    const y = YAML.parse(t);
    expect(y.servers.files.command).toBe("custom");
    expect(y.servers.gh).toBeTruthy();
    const [m] = listBackups();
    expect(rd(join(home, ".mycel", "backups", m.id, m.config.backup!))).toBe("# mine\nservers:\n  files:\n    command: custom\nbudget:\n  perTaskUsd: 1\n");
  });

  it("is idempotent: a second run changes nothing and never wraps mycel in mycel", async () => {
    fixtures();
    await runSetup({ yes: true, cwd }, io());
    const after = [desktop(), join(home, ".claude.json"), vscode()].map(rd);
    const yamlAfter = rd(join(home, ".mycel", "mycel.yaml"));
    lines = [];
    await runSetup({ yes: true, cwd }, io());
    expect([desktop(), join(home, ".claude.json"), vscode()].map(rd)).toEqual(after);
    expect(rd(join(home, ".mycel", "mycel.yaml"))).toBe(yamlAfter);
    expect(YAML.parse(yamlAfter).servers.mycel).toBeUndefined();
    expect(listBackups().length).toBe(1);
    expect(lines.join("\n")).toMatch(/Nothing to do/);
  });

  it("keeps mycel and replaces only foreign servers when both are present", async () => {
    put(desktop(), JSON.stringify({ mcpServers: { mycel: { command: "mycel", args: ["serve"] }, x: { command: "x-srv" } } }));
    await runSetup({ yes: true, cwd }, io());
    expect(Object.keys(JSON.parse(rd(desktop())).mcpServers)).toEqual(["mycel"]);
    expect(YAML.parse(rd(join(home, ".mycel", "mycel.yaml"))).servers.mycel).toBeUndefined();
  });

  it("leaves project files alone unless --projects", async () => {
    const p = put(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { p: { command: "p-srv" } } }));
    fixtures();
    await runSetup({ yes: true, cwd }, io());
    expect(rd(join(cwd, ".mcp.json"))).toBe(p);
    await runSetup({ yes: true, cwd, projects: true }, io());
    expect(Object.keys(JSON.parse(rd(join(cwd, ".mcp.json"))).mcpServers)).toEqual(["mycel"]);
  });

  it("uses the mycel binary when it is on PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "mycel-bin-"));
    writeFileSync(join(bin, "mycel"), "#!/bin/sh\n");
    chmodSync(join(bin, "mycel"), 0o755);
    process.env.PATH = bin;
    put(desktop(), JSON.stringify({ mcpServers: { x: { command: "x-srv" } } }));
    await runSetup({ yes: true, config: join(home, "custom.yaml"), cwd }, io());
    expect(JSON.parse(rd(desktop())).mcpServers.mycel).toEqual({ command: "mycel", args: ["serve", "--config", join(home, "custom.yaml")] });
    expect(existsSync(join(home, "custom.yaml"))).toBe(true);
  });

  it("ignores a temporary npx copy of mycel on PATH", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "mycel-n-")), "_npx", "abc", "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "mycel"), "#!/bin/sh\n");
    process.env.PATH = bin;
    put(desktop(), JSON.stringify({ mcpServers: { x: { command: "x-srv" } } }));
    await runSetup({ yes: true, cwd }, io());
    expect(JSON.parse(rd(desktop())).mcpServers.mycel.command).toBe("npx");
  });

  it.skipIf(process.platform === "win32")("prefers the claude CLI for Claude Code user scope", async () => {
    const bin = mkdtempSync(join(tmpdir(), "mycel-bin-"));
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = bin;
    delete process.env.MYCEL_NO_CLAUDE_CLI;
    const orig = put(join(home, ".claude.json"), JSON.stringify({ mcpServers: { a: { command: "a-srv" } } }, null, 2));
    await runSetup({ yes: true, cwd }, io());
    const calls = rd(log);
    expect(calls).toContain("mcp remove -s user a");
    expect(calls).toMatch(/mcp add -s user mycel -- npx -y @speakquery\/mycel serve --config/);
    const [m] = listBackups();
    expect(m.files[0].viaClaudeCli).toBe(true);
    expect(rd(join(home, ".mycel", "backups", m.id, m.files[0].backup))).toBe(orig);
  });

  it("lists backups and reports nothing to undo when there are none", async () => {
    await runUndo({}, io());
    expect(lines.join("\n")).toMatch(/Nothing to undo/);
    fixtures();
    await runSetup({ yes: true, cwd }, io());
    lines = [];
    await runUndo({ list: true }, io());
    expect(lines[0]).toContain(listBackups()[0].id);
  });
});

describe("mycel setup wizard: nothing to set by hand", () => {
  const mcfg = () => join(home, ".mycel", "mycel.yaml");
  const secretsFile = () => join(home, ".mycel", "secrets.env");

  it("moves API keys into a private secrets file and points the config at it", async () => {
    fixtures();
    await runSetup({ yes: true, cwd }, io());
    const env = rd(secretsFile());
    expect(env).toContain("API_KEY=sk-SUPERSECRET-123");
    expect(env).toContain("=tok-ABC");
    expect(env).not.toContain("Bearer");
    const y = YAML.parse(rd(mcfg()));
    expect(y.secrets).toEqual({ source: "file", file: secretsFile() });
    expect(y.servers.c.headers.Authorization).toMatch(/^Bearer \{\{secret:[A-Z_]+\}\}$/);
    expect(rd(mcfg())).not.toContain("SUPERSECRET");
    expect(rd(mcfg())).not.toContain("tok-ABC");
    if (platform() !== "win32") expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
    const text = lines.join("\n");
    expect(text).not.toMatch(/Set these environment variables/);
    expect(text).not.toContain("SUPERSECRET");
    expect(text).toMatch(/you don't need to set anything/);
  });

  it("gives two servers that share a variable name with different values distinct secrets", async () => {
    put(desktop(), JSON.stringify({ mcpServers: { alpha: { command: "a", env: { API_KEY: "key-one-111" } }, beta: { command: "b", env: { API_KEY: "key-two-222" } } } }));
    await runSetup({ yes: true, cwd }, io());
    const y = YAML.parse(rd(mcfg()));
    const a = /\{\{secret:(\w+)\}\}/.exec(y.servers.alpha.env.API_KEY)![1];
    const b = /\{\{secret:(\w+)\}\}/.exec(y.servers.beta.env.API_KEY)![1];
    expect(a).not.toBe(b);
    const env = rd(secretsFile());
    expect(env).toContain(`${a}=key-one-111`);
    expect(env).toContain(`${b}=key-two-222`);
  });

  it("reuses an existing secrets file and never duplicates a stored key", async () => {
    put(secretsFile(), "API_KEY=sk-SUPERSECRET-123\n");
    put(desktop(), JSON.stringify({ mcpServers: { gh: srv } }));
    await runSetup({ yes: true, cwd }, io());
    expect(rd(secretsFile())).toBe("API_KEY=sk-SUPERSECRET-123\n");
    expect(YAML.parse(rd(mcfg())).servers.gh.env.API_KEY).toBe("{{secret:API_KEY}}");
  });

  it("asks before including a project file instead of needing --projects", async () => {
    put(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { p: { command: "p-srv" } } }));
    put(desktop(), JSON.stringify({ mcpServers: { x: { command: "x-srv" } } }));
    await runSetup({ cwd }, io(true, true));
    expect(Object.keys(JSON.parse(rd(join(cwd, ".mcp.json"))).mcpServers)).toEqual(["mycel"]);
  });

  it("undo keeps the secrets file it created and says so", async () => {
    fixtures();
    await runSetup({ yes: true, cwd }, io());
    lines = [];
    await runUndo({ yes: true }, io());
    expect(existsSync(secretsFile())).toBe(true);
    expect(lines.join("\n")).toMatch(/Secrets file .* was created by setup/);
  });

  it("plans app restarts: automatic on macOS, never the app setup runs inside", () => {
    const clients = ["Claude Desktop", "Claude Code", "Cursor"];
    const mac = restartPlan(clients, "darwin", {});
    expect(mac.auto.map((a) => a.client)).toEqual(["Claude Desktop", "Cursor"]);
    expect(mac.manual.join("\n")).toMatch(/Claude Code: start a new session/);
    const inside = restartPlan(clients, "darwin", { __CFBundleIdentifier: "com.anthropic.claudefordesktop" });
    expect(inside.auto.map((a) => a.client)).toEqual(["Cursor"]);
    expect(inside.manual.join("\n")).toMatch(/Claude Desktop: setup is running inside it/);
    const lin = restartPlan(clients, "linux", {});
    expect(lin.auto).toEqual([]);
    expect(lin.manual).toHaveLength(3);
  });
});

describe("0.2.0: savings people can see, keys asked for, extensions imported", () => {
  const mcfg = () => join(home, ".mycel", "mycel.yaml");
  const claudeDir = () => dirname(desktop());
  const ext = (id: string, manifest: object, settings: object) => {
    put(join(claudeDir(), "Claude Extensions", id, "manifest.json"), JSON.stringify(manifest));
    return put(join(claudeDir(), "Claude Extensions Settings", `${id}.json`), JSON.stringify(settings));
  };
  const io2 = (answer = true, secrets: string[] = []) => ({ ...io(true, answer), secret: async () => secrets.shift() ?? "" });

  it("turns the savings line on (yes by default) and keeps an earlier choice", async () => {
    put(desktop(), JSON.stringify({ mcpServers: { x: { command: "x-srv" } } }));
    await runSetup({ yes: true, cwd }, io());
    expect(YAML.parse(rd(mcfg())).ui.savingsLine).toBe(true);
    put(desktop(), JSON.stringify({ mcpServers: { y: { command: "y-srv" } } }));
    writeFileSync(mcfg(), rd(mcfg()).replace("savingsLine: true", "savingsLine: false"));
    await runSetup({ yes: true, cwd }, io());
    expect(YAML.parse(rd(mcfg())).ui.savingsLine).toBe(false);
  });

  it("asks for a missing API key with hidden input and stores it privately", async () => {
    put(desktop(), JSON.stringify({ mcpServers: { svc: { command: "svc", env: { SVC_TOKEN: "${input:token}" } } } }));
    await runSetup({ cwd }, io2(true, ["pasted-secret-999"]));
    const env = rd(join(home, ".mycel", "secrets.env"));
    expect(env).toContain("SVC_TOKEN=pasted-secret-999");
    expect(lines.join("\n")).not.toContain("pasted-secret-999");
    expect(YAML.parse(rd(mcfg())).secrets.source).toBe("file");
  });

  it("imports enabled Claude Desktop extensions, turns them off there, and undo turns them back on", async () => {
    const s0 = ext(
      "ant.dir.notes",
      { name: "notes", display_name: "Notes", server: { type: "binary", mcp_config: { command: "${__dirname}/bin/notes", args: ["--root", "${user_config.root}", "${user_config.dirs}"], env: { NOTES_API_KEY: "${user_config.key}" } } } },
      { isEnabled: true, userConfig: { root: "/data", dirs: ["/a", "/b"], key: "nk-123456" } },
    );
    ext("ant.dir.off", { name: "off", server: { mcp_config: { command: "off" } } }, { isEnabled: false });
    const found = findDesktopExtensions(claudeDir());
    expect(found.found.map((e) => e.name)).toEqual(["Notes"]);
    expect(found.found[0].server).toEqual({ command: join(claudeDir(), "Claude Extensions", "ant.dir.notes") + "/bin/notes", args: ["--root", "/data", "/a", "/b"], env: { NOTES_API_KEY: "nk-123456" } });

    await runSetup({ yes: true, cwd }, io());
    const y = YAML.parse(rd(mcfg()));
    expect(y.servers.notes.command).toContain("ant.dir.notes");
    expect(y.servers.notes.env.NOTES_API_KEY).toBe("{{secret:NOTES_API_KEY}}");
    expect(rd(join(home, ".mycel", "secrets.env"))).toContain("NOTES_API_KEY=nk-123456");
    expect(JSON.parse(rd(join(claudeDir(), "Claude Extensions Settings", "ant.dir.notes.json"))).isEnabled).toBe(false);
    expect(Object.keys(JSON.parse(rd(desktop())).mcpServers)).toEqual(["mycel"]);

    await runUndo({ yes: true }, io());
    expect(rd(join(claudeDir(), "Claude Extensions Settings", "ant.dir.notes.json"))).toBe(s0);
    expect(JSON.parse(rd(desktop())).mcpServers.mycel).toBeUndefined();
  });

  it("never overwrites a Claude Desktop config it cannot parse; the extension stays on", async () => {
    const bad = put(desktop(), '{ // my comment\n "globalShortcut": "x" }');
    const s0 = ext("ant.dir.n", { name: "n", server: { mcp_config: { command: "n" } } }, { isEnabled: true });
    put(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { g: { command: "g-srv" } } }));
    await runSetup({ yes: true, cwd }, io());
    expect(rd(desktop())).toBe(bad);
    expect(rd(join(claudeDir(), "Claude Extensions Settings", "ant.dir.n.json"))).toBe(s0);
  });

  it("reports Claude Code plugin servers and leaves them alone", () => {
    const p = join(home, "plug");
    put(join(p, ".mcp.json"), JSON.stringify({ mcpServers: { figma: { url: "https://x" } } }));
    put(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "f@m": [{ installPath: p }] } }));
    expect(pluginServers(home)).toEqual(["figma"]);
  });

  it("can start Mycel with an absolute Node path (installer copy)", () => {
    process.env.MYCEL_ENTRY_ABSOLUTE = "1";
    try {
      const e = mycelEntry("/c.yaml");
      expect(e.command).toBe(process.execPath);
      expect(e.args.slice(-3)).toEqual(["serve", "--config", "/c.yaml"]);
    } finally {
      delete process.env.MYCEL_ENTRY_ABSOLUTE;
    }
  });

  it("the savings line shows percent, money and time, labelled as estimates", () => {
    const line = formatSavingsLine(measure(13240, 1710), { calls: 3, rawTokens: 60000, savedTokens: 48300, addedTokens: 0, netTokens: 48300 }, 0, { usdPerMTok: 3, tokensPerSecond: 3000 });
    expect(line).toContain("this call −87%");
    expect(line).toContain("session −48,300 tokens (−81%) ≈ $0.14 · ≈16 s (estimated)");
    expect(valueOf(1_000_000, { usdPerMTok: 3, tokensPerSecond: 3000 }).usd).toBe(3);
    const st = formatStats({ day: { date: "d", measured: { calls: 2, rawTokens: 100000, savedTokens: 90000, addedTokens: 0, netTokens: 90000 }, estimated: { toolsListServed: 0, definitionTokens: 0 } } });
    expect(st).toMatch(/−90% of what the tools returned/);
    expect(st).toMatch(/worth +≈ \$0\.27 and ≈30 s .*estimated/);
  });
});
