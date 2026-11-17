import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 60 * 60 * 1000;

export class Sessions {
  constructor(ttlMs = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
    this.values = new Map();
  }

  create(robloxCookie) {
    const token = randomBytes(32).toString("base64url");
    this.values.set(token, {
      robloxCookie: String(robloxCookie || ""),
      expiresAt: Date.now() + this.ttlMs,
      endpoints: new Set(),
    });
    return { token, expiresAt: this.values.get(token).expiresAt };
  }

  get(token) {
    const session = token && this.values.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.values.delete(token);
      return null;
    }
    return session;
  }

  allow(session, address, port) {
    if (!session || !address || !port) return;
    session.endpoints.add(`${address}:${Number(port)}`);
  }

  allows(session, address, port) {
    return !!session && session.endpoints.has(`${address}:${Number(port)}`);
  }
}
