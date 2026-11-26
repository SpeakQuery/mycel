// Tiny stdio MCP server that replays a captured tools/list. Usage: node replay-server.mjs <dump.json>
// Uses the low-level Server so the JSON schemas are served exactly as dumped. Tool calls always fail.
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const path = process.argv[2];
if (!path) { console.error("usage: node replay-server.mjs <dump.json>"); process.exit(2); }
const dump = JSON.parse(readFileSync(path, "utf8"));

const server = new Server({ name: `replay-${dump.server}`, version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dump.tools }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "replay only" }], isError: true }));
await server.connect(new StdioServerTransport());
