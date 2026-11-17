// Keep the launcher on the place selector and put the client in about:blank.
(() => {
  let pendingClient = null;
  let pendingTimer = 0;

  function finishLaunch() {
    clearTimeout(pendingTimer);
    pendingClient = null;
    // A root launcher reached from another client tab is temporary. The original
    // tab keeps identical isolation headers and is revealed when the game closes.
    if (window.opener) window.close();
    if (!window.closed) location.replace("/?controller=1");
  }

  function launchClient() {
    const query = new URLSearchParams(location.search);
    query.delete("launch");
    const win = window.__webloxOpenClient(query.size ? `?${query}` : "");
    if (!win) throw new Error("O navegador bloqueou a aba do cliente. Clique em Abrir cliente.");
    pendingClient = win;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (!pendingClient) return;
      pendingClient = null;
      launchFailed(new Error("O cliente demorou para carregar. Clique em Abrir cliente para tentar novamente."));
    }, 20_000);
  }

  function launchFailed(error) {
    clearTimeout(pendingTimer);
    pendingClient = null;
    document.body.textContent = String(error);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Abrir cliente";
    button.addEventListener("click", () => {
      button.disabled = true;
      try {
        launchClient();
      } catch (launchError) {
        launchFailed(launchError);
      }
    });
    document.body.append(document.createElement("br"), button);
  }

  addEventListener("message", (event) => {
    if (event.origin !== location.origin || !pendingClient || event.source !== pendingClient || !event.data) return;
    if (event.data.type === "weblox-client-ready") {
      finishLaunch();
    } else if (event.data.type === "weblox-client-error") {
      launchFailed(new Error(event.data.error || "O cliente não pôde ser carregado."));
    }
  });

  try {
    launchClient();
  } catch (error) {
    launchFailed(error);
  }
})();
