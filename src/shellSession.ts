import { EventEmitter } from "node:events";
import os from "node:os";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";

export interface ShellSessionOptions {
  id: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /** Kill the session after this many ms with no write or output activity. Disabled if unset. */
  idleTimeoutMs?: number;
}

export interface ShellSessionInfo {
  id: string;
  shell: string;
  args: string[];
  cwd: string;
  pid: number;
  alive: boolean;
  cols: number;
  rows: number;
  exitCode: number | null;
  idleTimeoutMs: number | null;
}

export interface DrainResult {
  text: string;
  /** True if output was dropped since the last drain to stay under MAX_BUFFER_CHARS. */
  truncated: boolean;
}

const DEFAULT_SHELL =
  os.platform() === "win32"
    ? (process.env.COMSPEC ?? "powershell.exe")
    : (process.env.SHELL ?? "/bin/sh");

// Bounds memory if a session is never read (e.g. a background command left
// running via shell_write with no follow-up shell_read). Keeps the most
// recent output, since that's what a caller checking in later cares about.
const MAX_BUFFER_CHARS = 2_000_000;

/**
 * Wraps a single node-pty process: buffered output, idle-detection, lifecycle.
 * `write` is raw and synchronous; callers relying on `waitIdle` to capture a
 * response should `waitQuiet` first so a still-in-flight shell startup
 * banner isn't mistaken for that response (see `waitQuiet` below).
 */
export class ShellSession extends EventEmitter {
  readonly id: string;
  readonly shell: string;
  readonly args: string[];
  readonly cwd: string;

  private idleTimeoutMs: number | null;

  private readonly proc: pty.IPty;
  private buffer = "";
  private truncated = false;
  private cols: number;
  private rows: number;
  private alive = true;
  private exitCode: number | null = null;
  private idleExpiryTimer: NodeJS.Timeout | undefined;

  constructor(opts: ShellSessionOptions) {
    super();
    this.id = opts.id;
    this.shell = opts.shell ?? DEFAULT_SHELL;
    this.args = opts.args ?? [];
    this.cwd = opts.cwd ?? process.cwd();
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 30;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? null;

    this.proc = pty.spawn(this.shell, this.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    this.proc.onData((chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_BUFFER_CHARS) {
        this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
        this.truncated = true;
      }
      this.resetIdleExpiry();
      this.emit("data", chunk);
    });

    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      clearTimeout(this.idleExpiryTimer);
      this.emit("exit", exitCode);
    });

    this.resetIdleExpiry();
  }

  get isAlive(): boolean {
    return this.alive;
  }

  info(): ShellSessionInfo {
    return {
      id: this.id,
      shell: this.shell,
      args: this.args,
      cwd: this.cwd,
      pid: this.proc.pid,
      alive: this.alive,
      cols: this.cols,
      rows: this.rows,
      exitCode: this.exitCode,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  write(data: string): void {
    if (!this.alive) throw new Error(`session ${this.id} is not alive`);
    this.resetIdleExpiry();
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) throw new Error(`session ${this.id} is not alive`);
    this.cols = cols;
    this.rows = rows;
    this.proc.resize(cols, rows);
  }

  kill(signal?: string): void {
    if (!this.alive) return;
    this.proc.kill(signal);
  }

  /** Changes (or, with `null`, disables) the idle-expiry timeout; restarts the clock. */
  setIdleTimeout(ms: number | null): void {
    this.idleTimeoutMs = ms;
    this.resetIdleExpiry();
  }

  private resetIdleExpiry(): void {
    clearTimeout(this.idleExpiryTimer);
    if (this.idleTimeoutMs === null) return;
    this.idleExpiryTimer = setTimeout(() => this.kill(), this.idleTimeoutMs);
  }

  /**
   * Returns everything buffered since the last drain, and clears the buffer.
   * ANSI escape/control sequences (cursor moves, colors, mode toggles) are
   * stripped so output reads as plain text; full-screen TUI programs that
   * rely on those sequences to render won't come through legibly.
   */
  drain(): DrainResult {
    const text = stripAnsi(this.buffer);
    const truncated = this.truncated;
    this.buffer = "";
    this.truncated = false;
    return { text, truncated };
  }

  /**
   * Waits for output to start, then go quiet for `idleMs`, and drains.
   * The idle clock only starts once the first chunk arrives, so a
   * slow-starting shell isn't mistaken for a finished command. `maxWaitMs`
   * caps total wait so a hung or continuously-streaming command can't block
   * the caller forever.
   */
  async waitIdle(idleMs: number, maxWaitMs: number): Promise<DrainResult> {
    return new Promise((resolve) => {
      let idleTimer: NodeJS.Timeout | undefined;

      const finish = () => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        this.off("data", onData);
        this.off("exit", finish);
        resolve(this.drain());
      };

      const onData = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, idleMs);
      };

      const maxTimer = setTimeout(finish, maxWaitMs);
      this.on("data", onData);
      this.on("exit", finish);
    });
  }

  /**
   * Waits until output has been quiet for `idleMs`, capped at `maxWaitMs`,
   * and drains. Unlike `waitIdle`, the clock starts immediately, so this
   * also resolves quickly when nothing is happening at all. Used to settle
   * (and discard) any output still in flight — e.g. shell startup banner —
   * before writing new input, not to capture a response to it.
   */
  async waitQuiet(idleMs: number, maxWaitMs: number): Promise<DrainResult> {
    return new Promise((resolve) => {
      let idleTimer: NodeJS.Timeout;

      const finish = () => {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        this.off("data", scheduleIdle);
        this.off("exit", finish);
        resolve(this.drain());
      };

      const scheduleIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, idleMs);
      };

      const maxTimer = setTimeout(finish, maxWaitMs);
      this.on("data", scheduleIdle);
      this.on("exit", finish);
      scheduleIdle();
    });
  }

  /** Waits for the next chunk of output (or timeout), then drains. */
  async waitForData(timeoutMs: number): Promise<DrainResult> {
    if (this.buffer.length > 0) return this.drain();

    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off("data", finish);
        this.off("exit", finish);
        resolve(this.drain());
      };

      const timer = setTimeout(finish, timeoutMs);
      this.on("data", finish);
      this.on("exit", finish);
    });
  }
}
