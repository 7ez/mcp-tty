import { randomUUID } from "node:crypto";
import { ShellSession, type ShellSessionInfo, type ShellSessionOptions } from "./shellSession.js";

export class SessionManager {
  private readonly sessions = new Map<string, ShellSession>();

  create(opts: Omit<ShellSessionOptions, "id"> & { id?: string }): ShellSession {
    const id = opts.id ?? randomUUID();
    if (this.sessions.has(id)) {
      throw new Error(`session "${id}" already exists`);
    }
    const session = new ShellSession({ ...opts, id });
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): ShellSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`no session "${id}"`);
    return session;
  }

  list(): ShellSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  kill(id: string, signal?: string): void {
    this.get(id).kill(signal);
  }
}
