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
- `src/index.ts` — MCP server wiring, stdio transport, shutdown handlers. Also the
  `setup` argv dispatch (`node dist/index.js setup`) short-circuits before touching
  the MCP server at all.
- `src/setup.ts` — `mcp-tty setup`: finds installed MCP clients, merges an `mcp-tty`
  entry into each one's config JSON. Read-modify-write, never blind-overwrite;
  malformed existing JSON is left untouched, not clobbered.

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
- **PowerShell's startup output has a second gap.** Banner text and the prompt line
  (`PS C:\...>`) don't arrive as one contiguous burst — there's a further gap between
  them (observed ~15ms, worse under load) that a too-short settle window can miss,
  returning from `waitQuiet` *before* the prompt itself has arrived. `SETTLE_IDLE_MS`
  is 400 (not the original 150) because of this — confirmed by direct timing
  (`s.on('data', ...)` timestamps) that 150ms genuinely wasn't enough, this wasn't
  test flakiness. Don't lower it without re-measuring on a loaded machine.
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
- **`"prepare": "npm run build"` is load-bearing for `npx github:7ez/mcp-tty`.**
  Installing from a git URL only runs npm's `prepare` lifecycle, not `build` — without
  it, `dist/` never gets compiled and the `setup`/server entrypoint doesn't exist.
  Don't remove it as "redundant" with the `build` script devs run locally.
- **ANSI is stripped on drain.** `shell_read`/`shell_exec` output has escape codes
  stripped for readability, which means full-screen TUI programs (vim, htop) won't
  render legibly through this server. That's accepted scope, not a bug to fix.
- **No orphan-process code needed on Windows.** Verified empirically: even a hard
  `taskkill /F` on the server leaves no orphaned child shells — ConPTY ties spawned
  processes to the creating process. The SIGINT/SIGTERM handlers in `index.ts` are
  for fast/ordered cleanup on the cooperative path, not orphan prevention.

## AGENTS.md

`AGENTS.md` is a real relative symlink (`AGENTS.md -> CLAUDE.md`) — some tools read
that filename instead of this one. No manual sync needed; editing this file is
editing AGENTS.md. A hardlink was tried first and rejected: hardlinks don't survive
normal atomic-save edits (editors write-new + rename, which points the path at a new
inode and leaves the old hardlink stale). Creating a *relative* symlink on Windows
needs the native `mklink` (from an actual `cmd.exe`/elevated shell) — PowerShell's
`New-Item -ItemType SymbolicLink -Target` silently resolves the target to an absolute
path even when given a relative string, which breaks portability across machines/
clones. Don't recreate this link with `New-Item`.

## Testing conventions

- `shellSession.test.ts`/`sessionManager.test.ts` spawn real shells (no mocking
  node-pty) — that's deliberate, it's what actually catches races like the ones
  above. Any test that writes to a freshly-spawned session must `waitQuiet` first,
  or it inherits the startup-banner race.
- Ad-hoc manual/smoke-test scripts belong in the scratchpad or get deleted after use
  — never commit them to the repo root.
