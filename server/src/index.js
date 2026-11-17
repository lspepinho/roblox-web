import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { attachRaknetProxy } from "./raknet-proxy.js";
import { verifyLogin } from "./credentials.js";
import { basicChallenge, basicCredentials } from "./basic-auth.js";
import { proxyRoblox, proxyTarget, robloxCookieFromRequest } from "./iframe-proxy.js";
import { Sessions } from "./sessions.js";
import { bearer, clientIp, json, readJson } from "./http.js";
import { joinNative, requestRoblox } from "./roblox-api.js";
import { serveStatic } from "./static.js";

function loginRateLimit(ip, now = Date.now()) {
  const windowMs = 60_000;
  const current = loginRateLimit.values.get(ip);
  if (!current || current.until <= now) {
    loginRateLimit.values.set(ip, { until: now + windowMs, count: 1 });
    return true;
  }
  if (current.count >= 5) return false;
  current.count++;
  return true;
}
loginRateLimit.values = new Map();

const LEGACY_PAGES = new Set([
  "/login",
  "/roblox-login",
  "/roblox-login.html",
  "/manual",
  "/manual.html",
  "/launch",
  "/launch.html",
  "/home.html",
]);

export function createApp(options = {}) {
  const sessions = new Sessions();
  const enableBrowserLogin = options.enableBrowserLogin ?? process.env.RENDER !== "true";
  const proxyFetch = options.proxyFetch || fetch;
  let iframeSession = null;
  const server = http.createServer(async (req, res) => {
    // A browser can abort a proxied request while upstream work is pending.
    // Handle the socket error instead of letting it become an uncaught event.
    req.on("error", () => {});
    res.on("error", () => {});
    try {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/origin.js" && req.method === "GET") {
        const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
        const body = `window.__webloxOrigin=${JSON.stringify(origin)};`;
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
        return;
      }

      const pageRequest = (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/" || LEGACY_PAGES.has(url.pathname));
      const needsBasic = pageRequest || url.pathname.startsWith("/roblox-proxy/") ||
        url.pathname === "/roblox-status" || url.pathname === "/api/session";
      if (needsBasic) {
        const credentials = basicCredentials(req);
        if (!credentials || !verifyLogin(credentials.username, credentials.password)) {
          return basicChallenge(res, "Roblox Web Proxy");
        }
      }

      // Old entry points remain only as compatibility redirects. The root is
      // the sole HTML entry point for login, manual cookie and Place ID.
      if ((req.method === "GET" || req.method === "HEAD") && LEGACY_PAGES.has(url.pathname)) {
        const params = new URLSearchParams();
        if (url.pathname === "/launch" || url.pathname === "/launch.html") {
          for (const key of ["placeId", "renderScale"]) {
            if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
          }
          params.set("launch", "1");
        } else if (url.pathname === "/manual" || url.pathname === "/manual.html") {
          params.set("manual", "1");
        } else {
          params.set("login", "1");
        }
        res.writeHead(302, { location: `/?${params}`, "cache-control": "no-store" });
        res.end();
        return;
      }

      if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD") && url.searchParams.get("launch") === "1") {
        return serveStatic(req, res, "/launch.html");
      }

      if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD") && url.searchParams.get("controller") === "1") {
        return serveStatic(req, res, "/index.html");
      }

      if (url.pathname === "/roblox-status" && req.method === "GET") {
        const cookie = robloxCookieFromRequest(req);
        if (!cookie) return json(res, 200, { done: false, error: null, token: null, browserLogin: enableBrowserLogin });
        if (!iframeSession || iframeSession.cookie !== cookie) {
          iframeSession = { cookie, ...sessions.create(cookie) };
        }
        return json(res, 200, { done: true, error: null, token: iframeSession.token, browserLogin: enableBrowserLogin });
      }

      if (url.pathname.startsWith("/roblox-proxy/")) {
        const target = proxyTarget(req);
        if (!target) return json(res, 400, { error: "proxy target is not allowed" });
        return await proxyRoblox(req, res, target, proxyFetch);
      }

      if (url.pathname === "/api/session" && req.method === "POST") {
        const ip = clientIp(req);
        if (!loginRateLimit(ip)) return json(res, 429, { error: "too many login attempts" });
        const body = await readJson(req, 128 * 1024);
        if (!String(body.robloxCookie || "").trim()) return json(res, 400, { error: "Roblox cookie is required" });
        return json(res, 200, sessions.create(body.robloxCookie));
      }

      if (url.pathname === "/api/join" && req.method === "POST") {
        const session = sessions.get(bearer(req));
        if (!session) return json(res, 401, { error: "session required" });
        const body = await readJson(req);
        const result = await joinNative(session, body.placeId, body.selection || {});
        for (const peer of [result.udmux, ...(result.connections || [])]) {
          if (peer) sessions.allow(session, peer.Address, peer.Port);
        }
        return json(res, 200, result);
      }

      if (url.pathname === "/api/rbx" && req.method === "POST") {
        const session = sessions.get(bearer(req));
        if (!session) return json(res, 401, { error: "session required" });
        const body = await readJson(req);
        const result = await requestRoblox(session, body.url, body.init || {});
        return json(res, 200, result);
      }

      if (url.pathname.startsWith("/api/")) {
        return json(res, 404, { error: "unknown API route" });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, url.pathname);
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      const status = error.statusCode || 500;
      return json(res, status, { error: status === 500 ? "internal server error" : error.message });
    }
  });

  server.requestTimeout = 120_000;
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.destroy();
  });
  const wss = attachRaknetProxy(server, sessions);
  return { server, sessions, wss };
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createApp();
  server.listen(port, "0.0.0.0", () => {
    const url = `http://localhost:${port}/`;
    console.log(`roblox-web listening on 0.0.0.0:${port}`);
    if (process.env.AUTO_OPEN !== "0" && process.env.RENDER !== "true") {
      try {
        openBrowser(url);
      } catch (error) {
        console.warn("open " + url + " manually: " + error.message);
      }
    }
  });
}
