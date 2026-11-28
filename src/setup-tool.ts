import { homedir } from "node:os";
import type { MetaTool } from "./meta.js";
import { runSetup, runUndo } from "./setup.js";
import { detectLang, translate } from "./i18n.js";

/**
 * `mycel_setup`: the setup wizard as a tool, for the Claude Desktop extension (no terminal needed).
 * The model shows the plan (apply: false), asks the user, then applies (apply: true). Claude Desktop's own
 * tool-permission prompt is a second yes. Keys it could not find are never asked for in chat: the model must not
 * see them; the user adds them in the terminal or the file the result names.
 */
export function setupTool(): MetaTool {
  return {
    name: "mycel_setup",
    description:
      "Set up Mycel on this computer: bring the MCP servers the user has in Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and Gemini CLI under Mycel, with backups. Call with action \"plan\" first and show the user the plan in plain words; only after the user says yes, call with action \"apply\". action \"undo\" restores the previous settings. Never ask the user to paste API keys into the chat.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "apply", "undo"], description: "plan = show what would change (changes nothing); apply = do it; undo = restore" },
        includeProjects: { type: "boolean", description: "also rewrite project files shared with a team (.mcp.json); only if the user asked" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args) => {
      const lines: string[] = [];
      const lang = detectLang();
      const io = { out: (s: string) => void lines.push(translate(s, lang)), ask: async () => false, interactive: false };
      const action = String(args.action ?? "plan");
      if (action === "undo") await runUndo({ yes: true }, io);
      else
        await runSetup(
          {
            cwd: homedir(),
            yes: action === "apply",
            check: action === "apply",
            projects: args.includeProjects === true,
            viaExtension: true,
            autoSignIn: true,
          },
          io,
        );
      const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      const next =
        action === "plan"
          ? "Show this plan to the user in plain words and ask whether to apply it. Do not apply without a clear yes."
          : "Tell the user what changed in plain words. Remind them to quit and reopen Claude Desktop (and any other app listed) so the change takes effect.";
      return { status: "ok", action, report: text, next };
    },
  };
}
