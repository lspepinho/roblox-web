// Open or rewrite a real about:blank client and inject only its bootstrap.
// The writer downloads the HTML in the target realm, so no pending navigation
// can cancel that work. The original place-selector tab also acts as a
// short-lived navigation controller when an existing client joins a game.
(() => {
  const origin = globalThis.__webloxOrigin || location.origin;

  function injectWriter(win) {
    const trusted = typeof win.trustedTypes === "undefined" ? null : win.trustedTypes.createPolicy("weblox-client-launch", {
      createScriptURL: (value) => value,
    });
    const writer = win.document.createElement("script");
    const writerUrl = `${origin}/blank-writer.js`;
    writer.src = trusted ? trusted.createScriptURL(writerUrl) : writerUrl;
    win.document.head.appendChild(writer);
  }

  globalThis.__webloxOpenClient = (query = "") => {
    const win = window.open(`about:blank${query}`, "_blank");
    if (!win) return null;
    injectWriter(win);
    return win;
  };

  globalThis.__webloxRewriteClient = (query = "") => {
    if (!window.opener || window.opener.closed) return false;
    window.opener.postMessage({ type: "weblox-write-client", query }, origin);
    location.replace(`about:blank${query}`);
    return true;
  };

  addEventListener("message", (event) => {
    if (event.origin !== origin || !event.source || !event.data || event.data.type !== "weblox-write-client") return;
    const query = event.data.query;
    if (typeof query !== "string" || query.length > 512 || (query && !query.startsWith("?"))) return;
    const source = event.source;
    const target = `about:blank${query}`;
    const started = Date.now();
    const timer = setInterval(() => {
      if (source.closed || Date.now() - started > 10_000) {
        clearInterval(timer);
        return;
      }
      try {
        if (source.location.href !== target || !source.document.head) return;
        clearInterval(timer);
        injectWriter(source);
      } catch {
        clearInterval(timer);
      }
    }, 10);
  });
})();
