import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SessionManager } from "./sessionManager.js";

const DEFAULT_IDLE_MS = 300;
const DEFAULT_EXEC_MAX_WAIT_MS = 15_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const SETTLE_IDLE_MS = 400;
const SETTLE_MAX_WAIT_MS = 2_000;

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function errorText(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

function drainedText(result: { text: string; truncated: boolean }): string {
  return result.truncated
    ? `[warning: earliest output was dropped to stay under the buffer cap]\n${result.text}`
    : result.text;
}

export function registerShellTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    "shell_start",
    {
      title: "Start shell session",
      description:
        "Spawn a new persistent, interactive PTY shell session. Returns the session id " +
        "used by every other shell_* tool. Multiple sessions can run concurrently.",
      inputSchema: {
        id: z.string().optional().describe("Session id to use; a UUID is generated if omitted."),
        shell: z
          .string()
          .optional()
          .describe(
            "Executable to run, e.g. powershell.exe, bash, ssh — just the program, not a full " +
              "command line. Defaults to the platform shell. Pass flags/hosts via `args`, not here " +
              "(e.g. shell: \"ssh\", args: [\"user@host\"]), since no shell parses this string.",
          ),
        args: z.array(z.string()).optional().describe("Arguments to pass to `shell`, e.g. [\"user@host\", \"-p\", \"2222\"] for ssh."),
        cwd: z.string().optional().describe("Working directory. Defaults to the server's cwd."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Extra environment variables, merged over the server's own environment."),
        cols: z.number().int().positive().optional().describe("Terminal width in columns. Default 120."),
        rows: z.number().int().positive().optional().describe("Terminal height in rows. Default 30."),
        idle_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Auto-kill this session after it sits idle (no write, no output) this many ms. " +
              "Unset by default (never auto-expires). Change or disable it later with " +
              "shell_set_idle_timeout, e.g. before a long-running command or an SSH session " +
              "you intend to leave open unattended.",
          ),
      },
    },
    async ({ id, shell, args, cwd, env, cols, rows, idle_timeout_ms }) => {
      try {
        const session = sessions.create({ id, shell, args, cwd, env, cols, rows, idleTimeoutMs: idle_timeout_ms });
        return text(JSON.stringify(session.info(), null, 2));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "shell_exec",
    {
      title: "Run a command and wait for output",
      description:
        "Write a command (Enter appended) to a session and wait for its output to go idle. " +
        "Best for ordinary non-interactive commands. For prompts expecting input mid-run " +
        "(passwords, y/n, full-screen TUIs) use shell_write and shell_read instead.",
      inputSchema: {
        id: z.string().describe("Session id from shell_start."),
        command: z.string().describe("Command text to run; a trailing Enter (\\r) is added automatically."),
        idle_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Output must be quiet this many ms before it's considered done. Default 300."),
        max_wait_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Hard cap on total wait, for commands that never go idle. Default 15000."),
      },
    },
    async ({ id, command, idle_ms, max_wait_ms }) => {
      try {
        const session = sessions.get(id);
        await session.waitQuiet(SETTLE_IDLE_MS, SETTLE_MAX_WAIT_MS);
        session.write(`${command}\r`);
        const result = await session.waitIdle(idle_ms ?? DEFAULT_IDLE_MS, max_wait_ms ?? DEFAULT_EXEC_MAX_WAIT_MS);
        return text(drainedText(result));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "shell_write",
    {
      title: "Write raw input to a session",
      description:
        "Send raw keystrokes to a session with no wait for output. To submit a line, end " +
        "input with \\r (Enter) yourself — \\n alone is treated as a literal newline by " +
        "line editors like PSReadLine, not as pressing Enter, and the input will look 'stuck'. " +
        "Use for interactive prompts (passwords, y/n) or control characters (e.g. \\x03 for " +
        "Ctrl-C). Output returned by shell_read has ANSI escapes stripped, so full-screen TUI " +
        "programs (vim, htop) won't render legibly here. Follow up with shell_read to see the result.",
      inputSchema: {
        id: z.string().describe("Session id from shell_start."),
        input: z.string().describe("Raw text/keystrokes to write, exactly as given."),
      },
    },
    async ({ id, input }) => {
      try {
        sessions.get(id).write(input);
        return text("ok");
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "shell_read",
    {
      title: "Read buffered output",
      description:
        "Drain output buffered since the last read. If nothing is buffered yet, waits up to " +
        "timeout_ms for new output before returning (possibly empty).",
      inputSchema: {
        id: z.string().describe("Session id from shell_start."),
        timeout_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Max time to wait for new output if the buffer is currently empty. Default 5000."),
      },
    },
    async ({ id, timeout_ms }) => {
      try {
        const result = await sessions.get(id).waitForData(timeout_ms ?? DEFAULT_READ_TIMEOUT_MS);
        return text(drainedText(result));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "shell_resize",
    {
      title: "Resize a session's terminal",
      description: "Change the PTY's column/row size, e.g. before running something that renders to fit the terminal.",
      inputSchema: {
        id: z.string().describe("Session id from shell_start."),
        cols: z.number().int().positive().describe("New width in columns."),
        rows: z.number().int().positive().describe("New height in rows."),
      },
    },
    async ({ id, cols, rows }) => {
      try {
        sessions.get(id).resize(cols, rows);
        return text("ok");
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "shell_set_idle_timeout",
    {
      title: "Change or disable a session's idle-expiry timeout",
      description:
        "Update how long a session may sit idle (no write, no output) before it's auto-killed. " +
        "Pass a number to set/change it, or null to disable auto-expiry entirely.",
      inputSchema: {
        id: z.string().describe("Session id from shell_start."),
        idle_timeout_ms: z.number().int().positive().nullable().describe("New idle timeout in ms, or null to disable."),
      },
    },
    async ({ id, idle_timeout_ms }) => {
      try {
        sessions.get(id).setIdleTimeout(idle_timeout_ms);
        return text("ok");
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "shell_list",
    {
      title: "List sessions",
      description: "List all known sessions with their id, shell, cwd, pid, and alive state.",
      inputSchema: {},
    },
    async () => {
      return text(JSON.stringify(sessions.list(), null, 2));
    },
  );

  server.registerTool(
    "shell_kill",
    {
      title: "Kill a session",
      description: "Terminate a session's process. The session id remains listable (as not alive) afterwards.",
      inputSchema: {
        id: z.string().describe("Session id from shell_start."),
        signal: z.string().optional().describe("Signal to send (Unix only), e.g. SIGTERM, SIGKILL."),
      },
    },
    async ({ id, signal }) => {
      try {
        sessions.kill(id, signal);
        return text("ok");
      } catch (err) {
        return errorText(err);
      }
    },
  );
}
