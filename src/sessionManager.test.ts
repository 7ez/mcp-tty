import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./sessionManager.js";

describe("SessionManager", () => {
  let manager: SessionManager;

  afterEach(() => {
    for (const s of manager.list()) manager.kill(s.id);
  });

  it("creates a session with a generated id when none is given", () => {
    manager = new SessionManager();
    const session = manager.create({});
    expect(session.id).toBeTruthy();
    expect(manager.get(session.id)).toBe(session);
  });

  it("rejects creating a session with a duplicate id", () => {
    manager = new SessionManager();
    manager.create({ id: "dup" });
    expect(() => manager.create({ id: "dup" })).toThrow(/already exists/);
  });

  it("throws when getting an unknown session", () => {
    manager = new SessionManager();
    expect(() => manager.get("missing")).toThrow(/no session/);
  });

  it("lists all created sessions", () => {
    manager = new SessionManager();
    manager.create({ id: "a" });
    manager.create({ id: "b" });
    expect(manager.list().map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});
