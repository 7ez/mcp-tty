import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ShellSession } from "./shellSession.js";

const shell = os.platform() === "win32" ? "powershell.exe" : "/bin/sh";

describe("ShellSession", () => {
  let session: ShellSession | undefined;

  afterEach(() => {
    session?.kill();
    session = undefined;
  });

  it("runs a command and returns its output once idle", async () => {
    session = new ShellSession({ id: "t1", shell });
    await session.waitQuiet(150, 5000);
    session.write("echo mcpsh-test-marker\r");

    const result = await session.waitIdle(300, 10_000);

    expect(result.text).toContain("mcpsh-test-marker");
    expect(result.truncated).toBe(false);
  });

  it("waitQuiet settles and discards output still in flight (e.g. startup banner)", async () => {
    session = new ShellSession({ id: "t1b", shell });

    await session.waitQuiet(150, 5000);
    session.write("echo after-settle\r");
    const result = await session.waitIdle(300, 10_000);

    expect(result.text).toContain("after-settle");
  });

  it("strips ANSI escape sequences from drained output", async () => {
    session = new ShellSession({ id: "t2", shell });
    await session.waitQuiet(150, 5000);
    session.write("echo plain-text\r");

    const result = await session.waitIdle(300, 10_000);

    expect(result.text).not.toMatch(/\x1b\[/);
  });

  it("waitForData returns immediately if output is already buffered", async () => {
    session = new ShellSession({ id: "t3", shell });
    await session.waitQuiet(150, 5000);
    session.write("echo buffered\r");
    await session.waitIdle(300, 10_000);

    session.write("echo again\r");
    await new Promise((r) => setTimeout(r, 500));

    const result = await session.waitForData(5000);
    expect(result.text).toContain("again");
  });

  it("auto-kills a session after idleTimeoutMs of inactivity", async () => {
    session = new ShellSession({ id: "t5", shell, idleTimeoutMs: 500 });
    expect(session.isAlive).toBe(true);

    await new Promise((resolve) => session!.once("exit", resolve));

    expect(session.isAlive).toBe(false);
  });

  it("setIdleTimeout(null) disables a pending auto-expiry", async () => {
    session = new ShellSession({ id: "t6", shell, idleTimeoutMs: 500 });
    session.setIdleTimeout(null);

    await new Promise((r) => setTimeout(r, 800));

    expect(session.isAlive).toBe(true);
  });

  it("reports alive: false after the process exits", async () => {
    session = new ShellSession({ id: "t4", shell });
    expect(session.isAlive).toBe(true);

    session.kill();
    await new Promise((resolve) => session!.once("exit", resolve));

    expect(session.isAlive).toBe(false);
    expect(session.info().alive).toBe(false);
  });
});
