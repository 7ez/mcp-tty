# mcp-tty

MCP server that gives an AI agent a persistent, interactive shell — real PTY sessions
(ConPTY on Windows, forkpty elsewhere via [node-pty](https://github.com/microsoft/node-pty)),
not one-shot `exec`. Supports multiple concurrent named sessions, so an agent can keep one
shell per SSH host, run a REPL, and answer interactive prompts (passwords, y/n) mid-command.

## Install

Windows and macOS: works out of the box, [node-pty](https://github.com/microsoft/node-pty)
ships prebuilt binaries for both.

Linux: node-pty has no prebuilt binary for this version, so it compiles from source on
install. Needs a C++ toolchain first: `sudo apt install build-essential python3` (Debian/
Ubuntu) or the equivalent for your distro.

```
npm install
npm run build
```

## Use from an MCP client

Point your client at `node dist/index.js` (stdio transport), e.g. in Claude Code's
`.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-tty": {
      "command": "node",
      "args": ["/path/to/mcp-tty/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `shell_start` | Spawn a session (`id?`, `shell?`, `args?`, `cwd?`, `env?`, `cols?`, `rows?`, `idle_timeout_ms?`). |
| `shell_exec` | Write a command, wait for output to go idle, return it. For ordinary commands. |
| `shell_write` | Write raw keystrokes, no newline, no wait. For prompts and control characters. |
| `shell_read` | Drain buffered output; waits up to `timeout_ms` if nothing is buffered yet. |
| `shell_resize` | Change a session's terminal size. |
| `shell_set_idle_timeout` | Change or disable (`null`) a session's idle-expiry timeout. |
| `shell_list` | List sessions and their state. |
| `shell_kill` | Terminate a session's process. |

Output returned by `shell_read`/`shell_exec` has ANSI escape sequences stripped for
readability. That means full-screen TUI programs (vim, htop) won't render legibly —
this server targets ordinary commands and interactive prompts, not terminal emulation.

`shell` is just the executable — pass flags/hosts via `args` (e.g. `shell: "ssh"`,
`args: ["user@host", "-p", "2222"]`), since no shell parses the `shell` string.

A session's output buffer is capped at 2M characters (oldest data dropped first); a
`shell_read`/`shell_exec` response is prefixed with a warning line if that happened.

`idle_timeout_ms` auto-kills a session after that long with no write or output activity;
unset by default (sessions never auto-expire). Useful to bound a background agent's
sessions; use `shell_set_idle_timeout` to change or disable it later, e.g. before a
long-running command or an SSH session you intend to leave open unattended.

