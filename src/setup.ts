import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ClientTarget {
  name: string;
  configPath: string | null;
  /** If true, always write here even if the config doesn't exist yet (the user ran
   * setup from inside this project, which is itself a strong signal of intent). */
  createIfMissing?: boolean;
}

function appDataDir(): string {
  return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
}

function userConfigDir(): string {
  // XDG-style base used by most Linux MCP clients when they lack a Windows/macOS-specific path.
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function claudeDesktopConfigPath(): string | null {
  const home = os.homedir();
  switch (os.platform()) {
    case "win32":
      return path.join(appDataDir(), "Claude", "claude_desktop_config.json");
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "linux":
      return path.join(userConfigDir(), "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

function clineConfigPath(): string | null {
  const rel = ["Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"];
  switch (os.platform()) {
    case "win32":
      return path.join(appDataDir(), ...rel);
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", ...rel);
    case "linux":
      return path.join(userConfigDir(), ...rel);
    default:
      return null;
  }
}

function targets(): ClientTarget[] {
  const home = os.homedir();
  return [
    { name: "Claude Code (this project)", configPath: path.join(process.cwd(), ".mcp.json"), createIfMissing: true },
    { name: "Claude Desktop", configPath: claudeDesktopConfigPath() },
    { name: "Cursor", configPath: path.join(home, ".cursor", "mcp.json") },
    { name: "Windsurf", configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json") },
    { name: "Cline (VS Code)", configPath: clineConfigPath() },
  ];
}

type UpsertResult = "created" | "updated" | "unchanged" | "skipped" | "unreadable";

function upsertServerEntry(configPath: string, createIfMissing: boolean, entry: Record<string, unknown>): UpsertResult {
  const existed = fs.existsSync(configPath);
  // For global client configs, only touch them if the client (or the user) already
  // created that config file — an empty parent folder isn't a reliable "installed"
  // signal, and we don't want to scatter config trees for apps that aren't present.
  if (!existed && !createIfMissing) return "skipped";

  let config: Record<string, unknown> = {};
  if (existed) {
    const raw = fs.readFileSync(configPath, "utf8").trim();
    try {
      config = raw ? JSON.parse(raw) : {};
    } catch {
      return "unreadable";
    }
  }

  const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = mcpServers["mcp-tty"];
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return "unchanged";

  const hadEntry = existing !== undefined;
  mcpServers["mcp-tty"] = entry;
  config.mcpServers = mcpServers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return hadEntry ? "updated" : "created";
}

/**
 * `npx github:...` installs into npm's ephemeral npx cache — fine for running
 * `setup` itself, but writing that path into a client's config would break
 * silently whenever that cache entry gets evicted. If we detect that's where
 * we're running from, copy the already-built package to a stable location
 * under the user's home directory and point configs there instead.
 */
function ensureStableInstall(packageRoot: string): string {
  if (!packageRoot.split(path.sep).includes("_npx")) return packageRoot;

  const stableRoot = path.join(os.homedir(), ".mcp-tty");
  console.log(`Running from a temporary npx cache; copying to a persistent location: ${stableRoot}\n`);
  fs.rmSync(stableRoot, { recursive: true, force: true });
  fs.cpSync(packageRoot, stableRoot, { recursive: true });
  return stableRoot;
}

export function runSetup(): void {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = ensureStableInstall(path.dirname(distDir));
  const serverEntryPoint = path.join(packageRoot, "dist", "index.js");
  const entry = { command: process.execPath, args: [serverEntryPoint] };

  console.log(`Configuring mcp-tty (${serverEntryPoint})\n`);

  for (const target of targets()) {
    if (!target.configPath) {
      console.log(`- ${target.name}: not supported on this platform, skipped`);
      continue;
    }

    const result = upsertServerEntry(target.configPath, target.createIfMissing ?? false, entry);
    switch (result) {
      case "created":
        console.log(`- ${target.name}: added (${target.configPath})`);
        break;
      case "updated":
        console.log(`- ${target.name}: updated to point at this install (${target.configPath})`);
        break;
      case "unchanged":
        console.log(`- ${target.name}: already configured correctly`);
        break;
      case "skipped":
        console.log(`- ${target.name}: not found, skipped (${target.configPath})`);
        break;
      case "unreadable":
        console.log(`- ${target.name}: existing config isn't valid JSON, left untouched (${target.configPath})`);
        break;
    }
  }

  console.log("\nRestart any client that was updated for the change to take effect.");
}
