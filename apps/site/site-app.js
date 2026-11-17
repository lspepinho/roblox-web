// Site boot: login through Render, join, then the same engine used by the IWA.
(() => {
  const say = (message) => console.log("[site-app] " + message);
  const form = document.getElementById("join-form");
  const login = document.getElementById("login");
  const error = document.getElementById("login-error");
  const button = document.getElementById("join-button");
  const auth = new RobloxAuth();
  const serviceOrigin = self.__webloxOrigin || location.origin;
  const serviceUrl = (path) => new URL(path, serviceOrigin).href;
  self.__rbxAuth = auth;
  if (auth.token) {
    // The native flow already authenticated both the proxy and Roblox. Leave
    // only the place selector visible when it redirects back here.
    for (const id of ["proxy-user", "proxy-pass", "roblox-cookie"]) {
      const input = document.getElementById(id);
      if (input && input.parentElement) input.parentElement.style.display = "none";
    }
    const row = document.querySelector(".row");
    if (row) row.style.display = "none";
  }

  window.__onEngineLoadingStatus = (message) => {
    if (!message) return;
    if (typeof message === "string") return say(message);
    if (message.message) say(message.message);
    if (message.kind === "failure") window.alert(message.message || "Roblox could not load this experience.");
  };

  let diagPanel = null;
  let diagTimer = 0;
  function showDiagnostics(on) {
    if (on === undefined) on = !(diagPanel && diagPanel.style.display !== "none");
    if (on && !diagPanel) {
      diagPanel = document.createElement("div");
      diagPanel.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.97);color:#e6e6ea;" +
        "font:12px/1.5 monospace;padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px";
      const title = document.createElement("div");
      title.textContent = "Diagnóstico — F8 fecha. Clique no texto, Ctrl+A, Ctrl+C.";
      const area = document.createElement("textarea");
      area.readOnly = true;
      area.style.cssText =
        "flex:1;width:100%;box-sizing:border-box;background:#101014;color:#d8d8de;border:1px solid #333;" +
        "border-radius:6px;font:12px/1.5 monospace;padding:10px;white-space:pre";
      diagPanel.append(title, area);
      diagPanel._area = area;
      document.body.appendChild(diagPanel);
    }
    if (diagPanel) {
      diagPanel.style.display = on ? "flex" : "none";
      if (on && self.__diagText) diagPanel._area.value = self.__diagText();
    }
    clearInterval(diagTimer);
    diagTimer = 0;
    if (on && diagPanel) {
      diagTimer = setInterval(() => {
        const area = diagPanel._area;
        if (document.activeElement !== area) area.value = self.__diagText ? self.__diagText() : "sem dados";
      }, 2000);
    }
  }
  addEventListener("keydown", (event) => {
    if (event.key === "F8") {
      event.preventDefault();
      event.stopPropagation();
      showDiagnostics();
    }
  }, true);

  async function play(placeId) {
    const selection = {};
    const join = await auth.join(placeId, selection);
    window.__join = join;
    if (self.__rbxNetSetJoin) self.__rbxNetSetJoin(join.reply);

    const peer = join.udmux || (join.connections && join.connections[0]);
    if (!peer) throw new Error("join script has no endpoint");
    await self.__rkRing.start({ host: peer.Address, port: peer.Port, script: join.script });
    say(`WebSocket transport -> ${peer.Address}:${peer.Port}`);

    const url = new URL(location.href);
    url.searchParams.set("placeId", String(placeId));
    if (!url.searchParams.has("renderScale")) {
      let scale = "0.625";
      try { scale = localStorage.getItem("weblox.renderScale") || scale; } catch {}
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(scale) || Number(scale) <= 0) scale = "0.625";
      url.searchParams.set("renderScale", scale);
    }
    self.__renderScale = url.searchParams.get("renderScale");

    login.style.display = "none";
    const script = document.createElement("script");
    script.src = "/engine/WasmPlayer.js";
    script.onerror = () => window.alert("Roblox could not load its engine.");
    document.body.appendChild(script);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    button.disabled = true;
    button.textContent = "Entrando…";
    try {
      const placeId = Number(document.getElementById("place-id").value);
      if (!Number.isSafeInteger(placeId) || placeId <= 0) throw new Error("Place ID inválido.");
      if (!auth.token) {
        const cookie = document.getElementById("roblox-cookie")?.value.trim();
        if (!cookie) {
          auth.returnToLogin();
          return;
        }
        await auth.login(cookie);
      }

      const current = new URLSearchParams(location.search);
      const query = new URLSearchParams();
      query.set("placeId", String(placeId));
      query.set("renderScale", current.get("renderScale") || "0.625");
      if (location.protocol === "about:") {
        if (self.__webloxRewriteClient(`?${query}`)) return;
        location.replace(serviceUrl(`/?launch=1&${query}`));
        return;
      }

      // The root launcher supplies the isolation headers required by the
      // engine, then opens about:blank with the same Place ID query.
      location.replace(serviceUrl(`/?launch=1&${query}`));
    } catch (e) {
      if (e && e.sessionExpired) return;
      error.textContent = e && e.message ? e.message : String(e);
      login.style.display = "flex";
      button.disabled = false;
      button.textContent = "Entrar no jogo";
      showDiagnostics(true);
    }
  });

  try {
    self.__lastGameExit = JSON.parse(sessionStorage.getItem("weblox.lastExit") || "null");
  } catch {}
  window.__onGameExit = (event) => {
    const reason = event && event.reason;
    say(`game exit reason=${reason || "unknown"}`);
    self.__lastGameExit = event || { reason: "unknown" };
    try { sessionStorage.setItem("weblox.lastExit", JSON.stringify(self.__lastGameExit)); } catch {}
    if (reason === "crash") {
      showDiagnostics(true);
      return;
    }
    if (diagPanel && diagPanel.style.display !== "none") return;
    setTimeout(() => {
      // The root tab remains on the place selector. Normal exits close the
      // script-opened about:blank client and reveal it; deep links use /?launch=1.
      window.close();
      if (!window.closed) location.replace(serviceUrl("/?launch=1"));
    }, 120);
  };

  // about:blank?placeId=... arrives here after Join. It is also a valid deep
  // link, so the engine can start without showing a hosting URL.
  (async () => {
    if (location.protocol !== "about:") return;
    const placeId = Number(new URLSearchParams(location.search).get("placeId"));
    if (!Number.isSafeInteger(placeId) || placeId <= 0) return;
    try {
      if (!auth.token) {
        auth.returnToLogin();
        return;
      }
      const who = await auth.whoami();
      if (!who) {
        auth.clear();
        auth.returnToLogin();
        return;
      }
      self.__whoami = who;
      await play(placeId);
    } catch (e) {
      if (e && e.sessionExpired) return;
      error.textContent = e && e.message ? e.message : String(e);
      login.style.display = "flex";
      button.disabled = false;
      button.textContent = "Entrar no jogo";
      showDiagnostics(true);
    }
  })();
})();
