// app.js — boot order, and nothing else.
//
//   Site mode (the default surface)
//     1. the controlled frame shows roblox.com, already logged in
//     2. site.js intercepts the real Play button inside it
//     3. the frame reports {placeId}, auth.js forwards it here
//   Game mode
//     4. join                           (frame -> join script)
//     5. ring points at the game server (one UDPSocket for the session)
//     6. engine loads                   (patched wasm, RakNet untouched)
//   Leaving the experience reloads, which is the only way back to site mode:
//   the engine's heap is a fixed 2 GiB block it never returns, and this build
//   has no app shell to go home to (docs/IWA.md, "Return to a surface we
//   control"). The frame's partition outlives the reload, so the login does not.
//
// A placeId in the URL skips site mode and goes straight to game mode — that is
// the deep link, and the only way to launch before site.js existed.
//
// Everything the engine needs from Roblox goes through rbx-net.js, which is
// loaded before this file so its fetch patch is already in place.
(() => {
  const say = (m) => console.log("[app] " + m);

  // One alert per distinct message. A failed join reports itself through several
  // channels, and a stack of identical dialogs is worse than the error.
  const shown = new Set();
  const fatal = (m) => {
    const text = String(m == null ? "Roblox ran into a problem." : m).slice(0, 500);
    console.error("[app] fatal: " + text);
    if (shown.has(text)) return;
    shown.add(text);
    window.alert(text);
  };

  // The engine narrates its loading screen here. A status is progress, so the
  // console keeps it; a failure is what the loading screen would have shown as
  // an error, and that is the case worth interrupting for.
  window.__onEngineLoadingStatus = (m) => {
    if (!m) return;
    if (typeof m === "string") return say(m);
    if (m.message) say(m.message);
    if (m.kind === "failure") fatal(m.message || "Roblox could not load this experience.");
  };

  addEventListener("error", (e) => console.error("[app] window error:", e.message || e));
  addEventListener("unhandledrejection", (e) => console.error("[app] rejection:", e.reason));

  const params = new URLSearchParams(location.search);
  const deepLinkPlaceId = params.get("placeId") || params.get("place");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --------------------------------------------------------------- status ---
  // A single line the user can read. The frame covers the whole window in site
  // mode, so the element sits above it and ignores the pointer: it is a readout,
  // not a control.
  const status = document.createElement("div");
  status.id = "app-status";
  status.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:3;pointer-events:none;" +
    "font:12px/1.4 system-ui,sans-serif;color:#cfcfd4;background:rgba(16,16,20,.82);" +
    "padding:5px 9px;border-radius:6px;max-width:70vw;opacity:0;transition:opacity .2s";
  document.body.appendChild(status);

  let statusTimer = 0;
  const setStatus = (text, sticky) => {
    if (!text) {
      status.style.opacity = "0";
      return;
    }
    status.textContent = text;
    status.style.opacity = "1";
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => (status.style.opacity = "0"), 4000);
  };

  // ---------------------------------------------------------- diagnostics ---
  // The engine draws its errors with the same fonts that may be failing, so a
  // broken text pipeline makes its own error unreadable. This panel is DOM:
  // it always renders. F8 toggles it; a failed join opens it.
  let diagPanel = null;
  let diagTimer = 0;

  function showDiagnostics(on) {
    if (on === undefined) on = !(diagPanel && diagPanel.style.display !== "none");
    if (on && !diagPanel) {
      diagPanel = document.createElement("div");
      diagPanel.style.cssText =
        // WasmPlayer's crash overlay uses z-index 1000. The report must stay
        // above it, or the only copy of the console is visible but unusable.
        "position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;" +
        "background:rgba(8,8,12,.96);color:#e6e6ea;font:12px/1.5 monospace;" +
        "padding:16px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px";
      const title = document.createElement("div");
      title.textContent = "Diagnóstico — F8 fecha. Clique no texto, Ctrl+A, Ctrl+C e cole o resultado.";
      const area = document.createElement("textarea");
      area.readOnly = true;
      area.style.cssText =
        "flex:1;width:100%;box-sizing:border-box;background:#101014;color:#d8d8de;" +
        "border:1px solid #333;border-radius:6px;font:12px/1.5 monospace;padding:10px;white-space:pre";
      diagPanel.appendChild(title);
      diagPanel.appendChild(area);
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
        // Never rewrite while the user is selecting text to copy.
        const area = diagPanel._area;
        if (document.activeElement !== area) area.value = self.__diagText ? self.__diagText() : "sem dados";
      }, 2000);
    }
  }

  addEventListener("keydown", (e) => {
    if (e.key === "F8") {
      e.preventDefault();
      e.stopPropagation();
      showDiagnostics();
    }
  }, true);

  async function login(auth) {
    const who = await auth.whoami();
    if (who) return who;
    // No session in the frame's jar: show it and let the user log in once. The
    // partition persists, so this happens on a fresh install and never again.
    say("no session in the frame; showing the login page");
    setStatus("Entre na sua conta da Roblox…", true);
    return auth.interactiveLogin();
  }

  /**
   * Launch a place. On any failure the frame comes back, so a bad join leaves
   * the user on roblox.com instead of on a black canvas.
   */
  async function play(auth, placeId, selection = {}) {
    say(`joining ${placeId}${selection.jobId ? " server " + selection.jobId : ""}…`);
    setStatus(selection.jobId ? "Entrando no servidor escolhido…" : "Entrando na experiência…", true);
    auth.visible(false);

    try {
      const join = await auth.join(placeId, selection);
      window.__join = join;
      // The engine asks gamejoin for a join of its own, in the website's shape;
      // that shape is refused on gated universes. Hand its request this reply
      // instead, so the join that happens is the one that just succeeded.
      if (self.__rbxNetSetJoin) self.__rbxNetSetJoin(join.reply);

      const peer = join.udmux || (join.connections && join.connections[0]);
      if (!peer) throw new Error("join script has no endpoint");

      await __rkRing.start({ host: peer.Address, port: peer.Port, script: join.script });
      say(`transport -> ${peer.Address}:${peer.Port}`);
      setStatus("Carregando…", true);

      // The engine takes the place id from the *URL*, not from the join we just
      // did: WasmPlayer.js reads new URLSearchParams(location.search) and only
      // starts an experience when placeId is there. Without it the wasm logs
      // "[LIFECYCLE] no startup place id; exiting" and stops, which the exit
      // hook turns into a black flash and a trip back to the site. Site mode
      // arrives here on a bare origin, so write the id before the loader runs.
      // replaceState, not a navigation: the join and the ring are already done.
      const url = new URL(location.href);
      url.searchParams.set("placeId", String(placeId));
      // The new loader accepts renderScale and multiplies the effective DPR.
      // 0.625 reduces real GPU work on every platform; unlike an FPS cap, this
      // addresses the cost itself. A deep link or localStorage can restore 1.
      if (!url.searchParams.has("renderScale")) {
        let scale = "0.625";
        try {
          scale = localStorage.getItem("weblox.renderScale") || scale;
        } catch (e) {}
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(scale) || Number(scale) <= 0) scale = "0.625";
        url.searchParams.set("renderScale", scale);
      }
      self.__renderScale = url.searchParams.get("renderScale");
      history.replaceState(null, "", url.href);

      // Only now: the ring has to be pointing somewhere before RakNet wakes up.
      const s = document.createElement("script");
      s.src = "/engine/WasmPlayer.js";
      s.onerror = () => fatal("Roblox could not load its engine.");
      document.body.appendChild(s);
      setStatus("");
      return true;
    } catch (e) {
      fatal(e && e.message ? e.message : e);
      say("join failed — returning to the site");
      auth.visible(true);
      setStatus("Não foi possível entrar. Tente outro jogo. (F8 = diagnóstico)", false);
      showDiagnostics(true);
      return false;
    }
  }

  async function main() {
    const auth = new RobloxAuth({ onLog: say });
    self.__rbxAuth = auth;
    window.auth = auth;

    await auth.start();
    const who = await login(auth);
    say(`logged in as ${who.name}`);
    window.__whoami = who;
    setStatus(`Conectado como ${who.name}`, false);

    if (deepLinkPlaceId) {
      await play(auth, deepLinkPlaceId, {
        jobId: params.get("gameInstanceId") || params.get("jobId"),
        accessCode: params.get("accessCode"),
        linkCode: params.get("privateServerLinkCode") || params.get("linkCode"),
      });
      return;
    }

    // interactiveLogin hides the frame when it finishes; site mode is the
    // opposite — the frame *is* the app until Play is pressed.
    auth.visible(true);

    // Site mode: sit on roblox.com until the Play button is pressed. pollPlay
    // both reads site.js's request and consumes any loadabort/newwindow
    // fallback, so one poll covers every path.
    setStatus("Escolha um jogo e clique em Jogar.", false);
    for (;;) {
      const request = await auth.pollPlay().catch(() => null);
      if (request && request.placeId) {
        say(`play requested: ${request.placeId} (${request.how})`);
        const started = await play(auth, request.placeId, request);
        // A failed join leaves the frame up; keep watching for the next click.
        if (started) return;
      }
      await sleep(300);
    }
  }

  // ------------------------------------------------------------ exit path ---
  // boot.js wraps __resolveGameExit on assignment, so the reason the engine
  // reports is visible here without touching the engine. Reload rather than
  // reset: the wasm heap is not recoverable in place, and the frame's jar makes
  // the next boot a page load away from a logged-in roblox.com.
  // The exit reason survives the reload, so the panel can explain the previous
  // session instead of starting every report with "unknown".
  try {
    self.__lastGameExit = JSON.parse(sessionStorage.getItem("weblox.lastExit") || "null");
  } catch (e) {}

  window.__onGameExit = (e) => {
    const reason = e && e.reason;
    say(`game exit reason=${reason || "unknown"}`);
    self.__lastGameExit = e || { reason: "unknown" };
    try {
      sessionStorage.setItem("weblox.lastExit", JSON.stringify(self.__lastGameExit));
    } catch (err) {}
    if (reason === "crash") {
      // The engine's own overlay only says ExplicitTerminate and points to a
      // devtools console that may not be openable in an installed app. Put the
      // captured console above that overlay instead of leaving a dead end.
      showDiagnostics(true);
      return;
    }
    // An open panel means the user is reading the failure. Keep this page, and
    // the request log that diagnostics.js collected, instead of reloading both
    // away before they can be copied.
    if (diagPanel && diagPanel.style.display !== "none") {
      showDiagnostics(true);
      return;
    }
    setStatus("Saindo… (F8 = diagnóstico)", true);
    // Drop the place id before reloading: play() puts it in the URL for the
    // engine, and reloading with it still there would be a deep link — straight
    // back into the experience we just left, instead of the site.
    history.replaceState(null, "", location.pathname);
    setTimeout(() => location.reload(), 120);
  };

  main().catch((e) => fatal(e && e.message ? e.message : e));
})();
