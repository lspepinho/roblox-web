// site.js — the real Play button, re-pointed at the engine.
//
// This file is not loaded by index.html. auth.js fetches it and injects it into
// the <controlledframe> with executeScript, which lands in the frame's *isolated
// world*: the DOM is shared with roblox.com, its JavaScript is not. That single
// fact decides the whole design —
//
//   * Roblox.GameLauncher.joinMultiplayerGame exists (it is a plain function on
//     www.roblox.com) but is unreachable from here, so there is no wrapping it.
//   * The interception has to be DOM-shaped: a capture-phase listener on
//     window, which runs before React's bubble-phase handler on the root
//     container and can therefore stopPropagation() it away. Measured on the
//     live page: with this listener in place a real click on
//     [data-testid="play-button"] sets placeId "1818" and joinMultiplayerGame
//     is called 0 times.
//   * The result cannot be handed to the parent over postMessage (cross-origin),
//     so it is written to window.__webloxPlay — a property of this world's
//     window, which is exactly what auth.js polls. A second copy goes to
//     localStorage: storage is per-origin, not per-world, so the request still
//     arrives if a future Chrome gives every executeScript() call its own
//     isolated world. auth.js reads the window first and clears both.
//
// roblox.com rejects synthetic clicks (element.click() never reaches a listener;
// only isTrusted input does), which is worth knowing when testing: a harness
// that drives the page with .click() will look like the interception is dead.

(() => {
  // The key used for the durable copy of a play request.
  const KEY = "__weblox_play";

  // Two guards, because there are two shared things and they are shared
  // differently: `window` belongs to this isolated world, the document's
  // attribute belongs to the DOM, which every world shares. The window guard
  // alone is enough on today's Chrome (the same world serves every
  // executeScript() call in a document — auth.js's evalAsync depends on it),
  // but the DOM guard costs nothing and survives a world split.
  if (window.__webloxSite) return;
  const root = document.documentElement;
  if (root && root.getAttribute("data-weblox-site") === "1") {
    window.__webloxSite = true;
    return;
  }
  window.__webloxSite = true;
  if (root) root.setAttribute("data-weblox-site", "1");

  // Servers is different from Play. The card has the place id, but the full
  // gameInstanceId exists only in the React handler, not in a data attribute
  // (the visible "ID: ..." is deliberately truncated). A capture listener can
  // stop the click but cannot recover that id from this isolated world.
  //
  // So serialize a tiny function into the page's main world and wrap the two
  // launcher entry points the official ServerList.js calls. The wrapper records
  // the exact ids in localStorage — shared between worlds — and resolves without
  // calling the native launcher. No synthetic click, no protocol race, and no
  // joining a random server just because that was all the DOM exposed.
  function webloxServerBridge() {
    if (window.__webloxServerBridge) return;
    window.__webloxServerBridge = true;
    document.documentElement.setAttribute("data-weblox-server-ready", "1");

    const report = (placeId, how, jobId, accessCode, linkCode) => {
      if (!placeId) return;
      const request = { placeId: String(placeId), how, at: Date.now() };
      if (jobId) request.jobId = String(jobId);
      if (accessCode) request.accessCode = String(accessCode);
      if (linkCode) request.linkCode = String(linkCode);
      try {
        localStorage.setItem("__weblox_play", JSON.stringify(request));
      } catch (e) {}
      console.log("[weblox] server join intercepted:", request);
    };

    function wrap(name, kind) {
      const launcher = window.Roblox && window.Roblox.GameLauncher;
      const original = launcher && launcher[name];
      if (typeof original !== "function") return false;
      if (original.__webloxServerWrapper) return true;

      function replacement(placeId, target, third) {
        // Public signatures:
        //   joinGameInstance(placeId, gameInstanceId, ...)
        //   joinPrivateGame(placeId, accessCode, linkCode, ...)
        // Accept the internal object shape too, which costs nothing and keeps
        // this seam useful if the call site moves.
        let jobId = null;
        let accessCode = null;
        let linkCode = null;
        if (placeId && typeof placeId === "object") {
          const data = placeId;
          jobId = data.gameInstanceId || data.instanceId || data.gameId || data.jobId || null;
          accessCode = data.accessCode || null;
          linkCode = data.linkCode || null;
          placeId = data.placeId || data.rootPlaceId;
        } else if (kind === "instance") {
          jobId = target;
        } else {
          accessCode = target;
          linkCode = third;
        }
        report(placeId, kind === "instance" ? "server:instance" : "server:private", jobId, accessCode, linkCode);
        // ServerList does not use the return value. Resolving preserves the
        // launcher contract for any caller that does, without starting Roblox.
        return Promise.resolve({ weblox: true, placeId: String(placeId || "") });
      }

      replacement.__webloxServerWrapper = true;
      replacement.__webloxOriginal = original;
      launcher[name] = replacement;
      return true;
    }

    const install = () => {
      const instance = wrap("joinGameInstance", "instance");
      const privateServer = wrap("joinPrivateGame", "private");
      if (instance && privateServer) clearInterval(timer);
    };
    const timer = setInterval(install, 100);
    install();
    // GameLaunch.js can arrive after this document. Do not poll forever if a
    // future page removes the private-server entry point altogether.
    setTimeout(() => clearInterval(timer), 60000);
  }

  if (root && root.getAttribute("data-weblox-server-ready") !== "1") {
    const script = document.createElement("script");
    script.textContent = "(" + webloxServerBridge.toString() + ")();";
    (document.head || root).appendChild(script);
    script.remove();
  }

  // Validated on www.roblox.com/pt/games/<id>/:
  //   <button data-testid="play-button" class="... btn-common-play-game-lg
  //           game-play-button-lg ..."> inside #game-details-play-button-container
  // and, on legacy surfaces, an anchor carrying the protocol URL directly.
  //
  // Deliberately absent: a[href*="/games/"]. Cards on /home and /charts are
  // plain navigation links — they must keep working so the user can browse, and
  // they land on a details page that has the button above.
  const PLAY_SELECTOR = [
    '[data-testid="play-button"]',
    ".btn-common-play-game-lg",
    ".game-play-button-lg",
    'a[href^="roblox-player:"]',
  ].join(",");

  // Both places a launch attempt names its target: the address bar of a details
  // page, and the query of a roblox-player: URL (used by the loadabort/newwindow
  // fallbacks in auth.js as well as here).
  window.__webloxParsePlaceId = (text) => {
    if (!text) return null;
    const m =
      /[?&]placeId=(\d+)/i.exec(text) ||
      /placeid:(\d+)/i.exec(text) ||
      /start-assetid=(\d+)/i.exec(text);
    return m ? m[1] : null;
  };

  const placeIdFromPath = () => (location.pathname.match(/\/games\/(\d+)/) || [])[1] || null;

  const report = (placeId, how) => {
    if (!placeId) return false;
    const request = { placeId: String(placeId), how, at: Date.now() };
    window.__webloxPlay = request;
    // The durable copy. Same origin, same partition, and — unlike a window
    // property — reachable from the page's own world as well.
    try {
      localStorage.setItem(KEY, JSON.stringify(request));
    } catch (e) {
      /* storage disabled: the window copy is still there */
    }
    console.log("[site] play requested:", placeId, "(" + how + ")");
    return true;
  };

  const onClick = (event) => {
    const target = event.target;
    const hit = target && target.closest ? target.closest(PLAY_SELECTOR) : null;
    if (!hit) return;

    // An anchor that *is* the launch names its own place; anything else takes it
    // from the address bar. With no id there is nothing to start, so let the
    // click through rather than swallow it and do nothing.
    const placeId =
      (hit.tagName === "A" ? window.__webloxParsePlaceId(hit.getAttribute("href")) : null) ||
      placeIdFromPath();
    if (!placeId) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    report(placeId, "click:" + hit.tagName.toLowerCase());
  };

  window.addEventListener("click", onClick, true);

  // Enter/Space on <button> synthesises a click, so the listener above already
  // covers the keyboard. Nothing else to install.
  //
  // A stale request is *not* cleared here: loadstop can fire after the user
  // has already clicked, and wiping the key then would lose a real request.
  // auth.js ages requests out instead.
  console.log("[site] Play interception installed");
})();
