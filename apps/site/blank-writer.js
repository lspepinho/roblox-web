// Runs inside the newly opened about:blank realm. Calling document.open here,
// rather than through the opener, preserves the about:blank URL and its query.
const writerOrigin = new URL(document.currentScript.src).origin;

function notifyLauncher(type, error) {
  if (!window.opener || window.opener.closed) return;
  window.opener.postMessage({ type, error: error ? String(error) : null }, writerOrigin);
}

(async () => {
  const response = await fetch(`${writerOrigin}/index.html`, { cache: "no-store" });
  if (!response.ok) throw new Error(`client HTML HTTP ${response.status}`);
  let html = await response.text();
  html = html.replace("<head>", `<head><base href="${writerOrigin}/"><script src="/origin.js"></script>`);
  let trusted = null;
  if (typeof trustedTypes !== "undefined") {
    trusted = trustedTypes.createPolicy("weblox-blank-writer", {
      createHTML: (value) => value,
      createScriptURL: (value) => value,
      createScript: (value) => value,
    });
  }
  document.open();
  document.write(trusted ? trusted.createHTML(html) : html);
  document.close();
  notifyLauncher("weblox-client-ready");
})().catch((error) => {
  notifyLauncher("weblox-client-error", error);
  if (document.body) document.body.textContent = String(error);
});
