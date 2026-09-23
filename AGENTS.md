# mcp-tty

MCP server: gives an AI agent a persistent, interactive PTY shell (node-pty), not
one-shot exec. Multiple concurrent named sessions. See README.md for the tool list
and usage.

## Commands

```
npm run build   # tsc -> dist/
npm test        # vitest run, spawns real shells, ~10s
npm run dev      # tsx src/index.ts, no build step
```

## Architecture

- `src/shellSession.ts` — wraps one node-pty process. Buffered output, idle-detection,
  idle-expiry, lifecycle. Core correctness lives here.
- `src/sessionManager.ts` — id -> ShellSession map.
- `src/tools.ts` — MCP tool schemas/handlers, thin layer over SessionManager.
- `src/index.ts` — MCP server wiring, stdio transport, shutdown handlers.

## Known gotchas (don't re-derive these, they cost real debugging time)

- **Enter is `\r`, not `\n`.** Line editors (PSReadLine, readline) treat a lone `\n`
  as inserting a literal newline, not submitting — input looks "stuck" with a `>>`
  continuation prompt. `shell_exec` appends `\r` automatically; `shell_write` callers
  must supply it themselves.
- **`waitIdle` vs `waitQuiet`.** `waitIdle`'s idle clock starts on the *first* data
  chunk — required so a slow-starting shell (PowerShell banner takes >300ms) isn't
  mistaken for a finished command. `waitQuiet`'s clock starts immediately, so it
  resolves fast even when nothing is happening — used to settle/discard in-flight
  startup output before writing a new command. Using the wrong one reintroduces a
  race that eats the first line of real output. `shell_exec` calls `waitQuiet` then
  writes then `waitIdle`; don't collapse that into a single settle-less write.
- **node-pty is patched.** `patches/node-pty+1.1.0.patch` (applied via `patch-package`
  on `postinstall`) fixes a real upstream race: killing a session forks a helper
  process to walk the console process list, and that helper can crash with
  `AttachConsole failed` if the shell already exited by the time it runs. The patch
  catches it and falls back to `[shellPid]`, matching the parent's own fallback.
  Don't "fix" the crash by deleting `patches/` or the postinstall script — it comes
  back the moment `node-pty` is reinstalled.
- **`useConptyDll: true` looked like a fix, isn't.** It avoids the fork above but
  silently stalls real shell output in this environment (confirmed via isolated
  repro) — echo/response bytes stop arriving after the handshake. Don't re-enable it
  without a fresh repro proving it now works.
- **ANSI is stripped on drain.** `shell_read`/`shell_exec` output has escape codes
  stripped for readability, which means full-screen TUI programs (vim, htop) won't
  render legibly through this server. That's accepted scope, not a bug to fix.
- **No orphan-process code needed on Windows.** Verified empirically: even a hard
  `taskkill /F` on the server leaves no orphaned child shells — ConPTY ties spawned
  processes to the creating process. The SIGINT/SIGTERM handlers in `index.ts` are
  for fast/ordered cleanup on the cooperative path, not orphan prevention.

## Testing conventions

- `shellSession.test.ts`/`sessionManager.test.ts` spawn real shells (no mocking
  node-pty) — that's deliberate, it's what actually catches races like the ones
  above. Any test that writes to a freshly-spawned session must `waitQuiet` first,
  or it inherits the startup-banner race.
- Ad-hoc manual/smoke-test scripts belong in the scratchpad or get deleted after use
  — never commit them to the repo root.
