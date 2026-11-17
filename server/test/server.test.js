import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import WebSocket from "ws";
import { createApp } from "../src/index.js";
import { makeCredential, verifyCredential, verifyLogin } from "../src/credentials.js";
import { isRobloxUrl } from "../src/http.js";
import { joinNative } from "../src/roblox-api.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server, wss) {
  if (wss) wss.close();
  await new Promise((resolve) => server.close(resolve));
}

test("scrypt verifies admin/admin and rejects other credentials", () => {
  assert.equal(verifyLogin("admin", "admin"), true);
  assert.equal(verifyLogin("admin", "wrong"), false);
  assert.equal(verifyLogin("wrong", "admin"), false);
  const record = makeCredential("secret");
  assert.equal(verifyCredential("secret", record), true);
  assert.equal(verifyCredential("other", record), false);
  assert.equal(verifyCredential("secret", "not-a-record"), false);
});

test("Roblox URL allowlist rejects open-proxy targets", () => {
  assert.equal(isRobloxUrl("https://gamejoin.roblox.com/v1/join-game"), true);
  assert.equal(isRobloxUrl("https://users.roblox.com/v1/users/authenticated"), true);
  assert.equal(isRobloxUrl("http://gamejoin.roblox.com/v1/join-game"), false);
  assert.equal(isRobloxUrl("https://example.com/"), false);
  assert.equal(isRobloxUrl("https://roblox.com.evil.example/"), false);
  assert.equal(isRobloxUrl("https://user:pass@users.roblox.com/"), false);
});

test("native join sends the selected instance and native identity", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      status: 2,
      jobId: "join-attempt-1",
      joinScript: {
        PlaceId: 1818,
        UdmuxEndpoints: [{ Address: "127.0.0.1", Port: 45678 }],
        ServerConnections: [{ Address: "127.0.0.1", Port: 45678 }],
      },
    });
  };
  try {
    const result = await joinNative({ robloxCookie: ".ROBLOSECURITY=test" }, 1818, { jobId: "guid-123" });
    assert.equal(result.udmux.Address, "127.0.0.1");
    assert.equal(result.udmux.Port, 45678);
    assert.equal(result.requestedJobId, "guid-123");
    assert.equal(calls[0].url, "https://gamejoin.roblox.com/v1/join-game");
    assert.equal(calls[0].init.headers["User-Agent"], "Roblox/WinInet");
    assert.equal(calls[0].init.headers.Cookie, ".ROBLOSECURITY=test");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.gameInstanceId, "guid-123");
    assert.equal(body.placeId, 1818);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("root unifies Basic Auth, iframe login and cookie session", async () => {
  const { server, wss } = createApp({
    proxyFetch: async () => new Response(
      '<html><head></head><body><script>if (top.location != self.location) { top.location = self.location.href; }</script><form action="/login"><script src="https://js.rbxcdn.com/login.js"></script></form></body></html>',
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-frame-options": "DENY",
          "set-cookie": ".ROBLOSECURITY=roblox-cookie-from-browser; Domain=.roblox.com; Path=/; Secure; HttpOnly",
        },
      }
    ),
  });
  const base = await listen(server);
  const basic = (value) => "Basic " + Buffer.from(value).toString("base64");
  const authorization = basic("admin:admin");
  try {
    const challenge = await fetch(base + "/");
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("www-authenticate"), /Basic realm/);

    const legacy = await fetch(base + "/login", {
      headers: { authorization },
      redirect: "manual",
    });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/?login=1");

    const home = await fetch(base + "/", { headers: { authorization } });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(home.headers.get("cross-origin-embedder-policy"), null);
    const html = await home.text();
    assert.match(html, /<iframe src="\/roblox-proxy\/www\.roblox\.com\/pt\/login"/);
    assert.match(html, /id="join-form"/);
    assert.match(html, /id="roblox-cookie"/);
    assert.equal(html.includes("admin"), false);

    const proxyChallenge = await fetch(base + "/roblox-proxy/login");
    assert.equal(proxyChallenge.status, 401);
    const proxied = await fetch(base + "/roblox-proxy/login", { headers: { authorization } });
    assert.equal(proxied.status, 200);
    assert.equal(proxied.headers.get("x-frame-options"), null);
    const page = await proxied.text();
    assert.match(page, /\/roblox-proxy\/js\.rbxcdn\.com\/login\.js/);
    assert.match(page, /\/roblox-proxy\/www\.roblox\.com\/login/);
    assert.equal(page.includes("top.location"), false);
    assert.match(proxied.headers.get("set-cookie"), /\.ROBLOSECURITY=roblox-cookie-from-browser/);

    const pendingResponse = await fetch(base + "/roblox-status", { headers: { authorization } });
    const pending = await pendingResponse.json();
    assert.equal(pending.done, false);
    assert.equal(pending.browserLogin, true);

    const status = await fetch(base + "/roblox-status", {
      headers: { authorization, cookie: ".ROBLOSECURITY=roblox-cookie-from-browser" },
    });
    const state = await status.json();
    assert.equal(state.done, true);
    assert.ok(state.token.length > 30);
  } finally {
    await close(server, wss);
  }
});

test("static client has isolation headers and login/API authorization", async () => {
  const { server, sessions, wss } = createApp();
  const base = await listen(server);
  const basic = (value) => "Basic " + Buffer.from(value).toString("base64");
  const authorization = basic("admin:admin");
  try {
    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
    for (const path of ["/login", "/roblox-login", "/manual", "/launch"]) {
      assert.equal((await fetch(base + path)).status, 401, path);
    }

    const home = await fetch(base + "/", { headers: { authorization } });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(home.headers.get("cross-origin-embedder-policy"), null);
    assert.match(home.headers.get("content-security-policy"), /wasm-unsafe-eval/);
    assert.match(await home.text(), /Roblox Web/);

    const launch = await fetch(base + "/?launch=1", { headers: { authorization } });
    assert.equal(launch.status, 200);
    assert.equal(launch.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(launch.headers.get("cross-origin-embedder-policy"), "require-corp");
    const launchHtml = await launch.text();
    assert.ok(launchHtml.indexOf("/client-launch.js") < launchHtml.indexOf("/launch.js"));
    const controller = await fetch(base + "/?controller=1", { headers: { authorization } });
    assert.equal(controller.status, 200);
    assert.equal(controller.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(controller.headers.get("cross-origin-embedder-policy"), "require-corp");
    const controllerHtml = await controller.text();
    assert.match(controllerHtml, /id="join-form"/);
    assert.equal(controllerHtml.includes("roblox-login-panel"), false);
    const origin = await fetch(base + "/origin.js");
    assert.equal(origin.status, 200);
    assert.equal(await origin.text(), `window.__webloxOrigin=${JSON.stringify(base)};`);

    const clientTemplate = await fetch(base + "/index.html");
    assert.equal(clientTemplate.status, 200);
    const metadata = await fetch(base + "/engine/WebClient.metadata.json");
    assert.equal(metadata.status, 200);
    const list = await metadata.json();
    assert.ok(Array.isArray(list) && list.length > 2800);

    const badLogin = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic("admin:wrong") },
      body: JSON.stringify({ robloxCookie: "test-cookie" }),
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ robloxCookie: "test-cookie" }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    assert.ok(token.length > 30);

    const unauthorized = await fetch(base + "/api/rbx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(unauthorized.status, 401);

    const badTarget = await fetch(base + "/api/rbx", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(badTarget.status, 400);

    const emptyToken = sessions.create("").token;
    const noCookie = await fetch(base + "/api/join", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${emptyToken}` },
      body: JSON.stringify({ placeId: 1818 }),
    });
    assert.equal(noCookie.status, 401);
  } finally {
    await close(server, wss);
  }
});

test("WebSocket proxy carries a real UDP datagram and rejects other endpoints", async () => {
  const echo = dgram.createSocket("udp4");
  echo.on("message", (message, rinfo) => echo.send(message, rinfo.port, rinfo.address));
  await new Promise((resolve) => echo.bind(0, "127.0.0.1", resolve));
  const endpoint = { host: "127.0.0.1", port: echo.address().port };

  const { server, sessions, wss } = createApp();
  const base = await listen(server);
  const wsBase = base.replace(/^http:/, "ws:");
  let ws;
  try {
    const { token } = sessions.create("not-a-real-cookie");
    sessions.allow(sessions.get(token), endpoint.host, endpoint.port);
    const query = `host=${endpoint.host}&port=${endpoint.port}`;
    ws = new WebSocket(`${wsBase}/raknet?${query}`, ["weblox", "token." + token]);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const response = new Promise((resolve) => ws.once("message", (data) => resolve(Buffer.from(data).toString())));
    ws.send(Buffer.from("weblox-udp-test"));
    assert.equal(await response, "weblox-udp-test");

    const denied = new WebSocket(`${wsBase}/raknet?host=127.0.0.1&port=1`, ["weblox", "token." + token]);
    await new Promise((resolve) => {
      denied.once("error", (error) => {
        assert.match(error.message, /403/);
        resolve();
      });
    });

    // Reproduce a queued message delivered after the UDP socket has closed.
    // It must be ignored instead of crashing the whole Node process.
    const serverSide = [...wss.clients][0];
    assert.ok(serverSide);
    const closed = new Promise((resolve) => serverSide.once("close", resolve));
    serverSide.close();
    await closed;
    assert.doesNotThrow(() => serverSide.emit("message", Buffer.from("late-datagram"), true));
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally {
    if (ws) ws.close();
    echo.close();
    await close(server, wss);
  }
});
