#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "./sessionManager.js";
import { registerShellTools } from "./tools.js";
import { runSetup } from "./setup.js";

if (process.argv[2] === "setup") {
  runSetup();
  process.exit(0);
}

const server = new McpServer({ name: "mcp-tty", version: "0.1.0" });
const sessions = new SessionManager();

registerShellTools(server, sessions);

// Avoids leaving orphaned shell/ssh processes running after this server exits.
function killAllSessions(): void {
  for (const s of sessions.list()) {
    try {
      sessions.kill(s.id);
    } catch {
      // already gone
    }
  }
}
process.on("SIGINT", () => {
  killAllSessions();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAllSessions();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
