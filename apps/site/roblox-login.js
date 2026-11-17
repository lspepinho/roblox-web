(() => {
  const panel = document.getElementById("roblox-login-panel");
  const place = document.getElementById("login");
  const status = document.getElementById("roblox-login-status");
  const manualToggle = document.getElementById("manual-toggle");
  const manualDetails = document.getElementById("manual-login");
  const params = new URLSearchParams(location.search);
  let timer = 0;
  let completed = false;
  let canAutoLaunch = !params.has("manual") && !params.has("login") && !sessionStorage.getItem("weblox.token");

  function showPlace() {
    panel.hidden = true;
    place.style.display = "flex";
  }

  function showLogin() {
    panel.hidden = false;
    place.style.display = "none";
  }

  function showManual() {
    canAutoLaunch = false;
    panel.hidden = true;
    manualDetails.open = true;
    place.style.display = "flex";
  }

  function adopt(token) {
    sessionStorage.setItem("weblox.token", token);
    if (globalThis.__rbxAuth) globalThis.__rbxAuth.adopt(token);
    else globalThis.__webloxProxy = { token };
  }

  function launchClient() {
    const query = new URLSearchParams();
    query.set("launch", "1");
    location.replace(`/?${query}`);
  }

  manualToggle.addEventListener("click", showManual);
  if (params.has("login")) {
    sessionStorage.removeItem("weblox.token");
    delete globalThis.__webloxProxy;
    showLogin();
  } else if (params.has("manual")) {
    showManual();
  } else if (sessionStorage.getItem("weblox.token")) {
    showPlace();
  } else {
    showLogin();
  }

  async function poll() {
    if (completed) return;
    try {
      const response = await fetch("/roblox-status", { cache: "no-store", credentials: "same-origin" });
      const data = await response.json();
      if (data.error) {
        status.textContent = data.error;
        return;
      }
      if (data.browserLogin === false && !sessionStorage.getItem("weblox.token")) {
        showManual();
        clearInterval(timer);
        return;
      }
      if (data.done && data.token) {
        adopt(data.token);
        showPlace();
        status.textContent = "Login concluído.";
        if (canAutoLaunch) {
          completed = true;
          clearInterval(timer);
          status.textContent = "Login concluído. Abrindo o cliente…";
          launchClient();
        }
        return;
      }
      if (!sessionStorage.getItem("weblox.token")) status.textContent = "Conclua o login na página oficial abaixo.";
    } catch (error) {
      status.textContent = String(error);
    }
  }

  poll();
  timer = setInterval(poll, 1000);
})();
