// Browser-side client for the Render proxy. Basic Auth protects the root and
// session creation. Only the opaque session token is kept in this realm; the
// Roblox cookie itself is never written to localStorage.
(() => {
  class RobloxAuth {
    constructor() {
      this.token = sessionStorage.getItem("weblox.token");
      if (this.token) globalThis.__webloxProxy = { token: this.token };
    }

    clear() {
      this.token = null;
      sessionStorage.removeItem("weblox.token");
      delete globalThis.__webloxProxy;
    }

    adopt(token) {
      this.token = token;
      sessionStorage.setItem("weblox.token", token);
      globalThis.__webloxProxy = { token };
    }

    returnToLogin() {
      const origin = globalThis.__webloxOrigin || location.origin;
      const url = new URL("/", origin);
      url.searchParams.set("login", "1");
      location.replace(url.href);
    }

    async post(path, body, authenticated = true) {
      const headers = { "content-type": "application/json" };
      if (authenticated && this.token) headers.authorization = `Bearer ${this.token}`;
      const response = await fetch(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `proxy HTTP ${response.status}`);
        if (authenticated && response.status === 401) {
          this.clear();
          error.sessionExpired = true;
          this.returnToLogin();
        }
        throw error;
      }
      return data;
    }

    async login(robloxCookie) {
      const result = await this.post("/api/session", { robloxCookie }, false);
      this.adopt(result.token);
      return result;
    }

    async whoami() {
      const result = await this.request("https://users.roblox.com/v1/users/authenticated", { method: "GET" });
      if (result.status !== 200) return null;
      const bytes = Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0));
      const user = JSON.parse(new TextDecoder().decode(bytes));
      return { id: user.id, name: user.name, displayName: user.displayName };
    }

    async join(placeId, selection = {}) {
      return this.post("/api/join", { placeId: Number(placeId), selection });
    }

    async request(url, init = {}) {
      return this.post("/api/rbx", { url, init });
    }
  }

  globalThis.RobloxAuth = RobloxAuth;
})();
