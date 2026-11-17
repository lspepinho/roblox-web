// auth.js — the join, done by a real roblox.com context.
//
// <controlledframe> gives the page a navigable context on www.roblox.com with
// its own cookie jar. From there the join is same-site, so the browser attaches
// .ROBLOSECURITY itself and CORS is Roblox's own policy. The only thing we have
// to change on the wire is the client identity, because gamejoin hands out a
// session that matches the client that asked for it: a browser user agent gets
// status 12 "Unable to join Game".
//
// Two facts from the native client that this module encodes:
//   * gamejoin is asynchronous for a fresh attempt: status 0 with a
//     "JoinPlace=<id>;" placeholder, status 2 once the job exists. Retry.
//   * Game/Join.ashx now answers 301 -> /request-error?code=404. Posting the
//     join again *with the returned jobId* returns the script inline instead.
(() => {
  const LOGIN_ORIGIN = "https://www.roblox.com/home";
  const GAMEJOIN = "https://gamejoin.roblox.com/v1/join-game";
  const CLIENT_UA = "Roblox/WinInet";
  // Only a fallback: normal completions arrive by postMessage immediately.
  const POLL_MS = 250;
  const SITE_SCRIPT = "/site.js";
  // A play request older than this is a leftover, not a click.
  const PLAY_MAX_AGE_MS = 60 * 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Mirrors the helper site.js defines for itself. site.js runs in the frame's
  // isolated world, so its `window` is not this one and it cannot be reused
  // here — the fallbacks below run in the IWA page, on element events.
  const parsePlaceId = (text) => {
    if (!text) return null;
    const m =
      /[?&]placeId=(\d+)/i.exec(text) ||
      /placeid:(\d+)/i.exec(text) ||
      /start-assetid=(\d+)/i.exec(text);
    return m ? m[1] : null;
  };

  const parseLaunchValue = (text, names) => {
    if (!text) return null;
    for (const name of names) {
      const m =
        new RegExp(`[?&]${name}=([^&#+]+)`, "i").exec(text) ||
        new RegExp(`(?:^|[+;])${name}:([^+;&]+)`, "i").exec(text);
      if (!m) continue;
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }
    return null;
  };

  class RobloxAuth {
    constructor(opts = {}) {
      this.partition = opts.partition || "persist:roblox";
      this.onLog = opts.onLog || (() => {});
      this.frame = null;
      this.interceptor = null;
      this.seq = 0;
      this.loaded = false;
      this.siteSource = null;
      this.onPlay = opts.onPlay || (() => {});
      this.playPending = null;
    }

    log(msg) {
      this.onLog(String(msg));
      console.log("[auth] " + msg);
    }

    // ------------------------------------------------------------- frame ----
    /**
     * Create the frame and wait for roblox.com to finish loading. The
     * partition must be set before src or the frame gets an in-memory jar that
     * dies with the element.
     *
     * The frame comes up *visible*: it is the app's home surface. Every
     * navigation re-injects site.js, because a new document gets a new isolated
     * world and the interception lives in that world.
     */
    async start(mount = document.body) {
      if (this.frame) return this.frame;

      const el = document.createElement("controlledframe");
      el.id = "rbx-auth";
      el.setAttribute("partition", this.partition);
      el.setAttribute("src", LOGIN_ORIGIN);
      el.style.cssText =
        "position:absolute;left:0;top:0;width:100%;height:100%;border:0;background:#111;z-index:1";

      const loaded = new Promise((resolve) => {
        const done = (ok, detail) => {
          clearTimeout(timer);
          el.removeEventListener("loadstop", onStop);
          el.removeEventListener("loadabort", onAbort);
          this.loaded = ok;
          this.log(`frame ${ok ? "loaded" : "aborted"}: ${detail}`);
          resolve(ok);
        };
        const onStop = () => done(true, LOGIN_ORIGIN);
        const onAbort = (e) => done(false, e.url || "unknown");
        el.addEventListener("loadstop", onStop);
        el.addEventListener("loadabort", onAbort);
        const timer = setTimeout(() => done(false, "timeout"), 30000);
      });

      mount.appendChild(el);
      this.frame = el;
      this.installInterceptor();
      this.installLaunchFallbacks();
      // Fires on the first load too, and on every full navigation after it.
      el.addEventListener("loadstop", () => this.injectSite());
      this.injectSite();
      await loaded;
      return el;
    }

    // ------------------------------------------------------------ site.js ----
    /**
     * Inject the Play interception into the frame's isolated world.
     *
     * The source is fetched from our own origin rather than passed as a file
     * path, so the injection is one code string and does not depend on
     * executeScript accepting `file`. Re-running is harmless: site.js returns
     * immediately if its world already has the guard set.
     */
    async injectSite() {
      if (!this.frame) return false;
      try {
        if (this.siteSource === null) {
          const res = await fetch(SITE_SCRIPT);
          if (!res.ok) throw new Error("HTTP " + res.status);
          this.siteSource = await res.text();
        }
        await this.frame.executeScript({ code: this.siteSource });
        return true;
      } catch (e) {
        this.log("site.js injection failed: " + e);
        return false;
      }
    }

    /**
     * Fallbacks for a launch that site.js did not see.
     *
     * If the site still manages to launch, it does so by handing the browser a
     * roblox-player: URL: that navigation is aborted inside a frame (there is no
     * handler for the scheme), and a target window never opens. Both events
     * surface on the element with the URL attached, which is enough to recover
     * the place id.
     */
    installLaunchFallbacks() {
      const el = this.frame;
      if (!el) return;

      const fromUrl = (url, how) => {
        if (!/roblox-player:/i.test(url || "")) return;
        const placeId = parsePlaceId(url);
        if (!placeId) return;
        this.log(`launch fallback (${how}): ${url.slice(0, 120)}`);
        this.requestPlay(placeId, how, {
          jobId: parseLaunchValue(url, ["gameInstanceId", "instanceId", "jobId"]),
          accessCode: parseLaunchValue(url, ["accessCode"]),
          linkCode: parseLaunchValue(url, ["privateServerLinkCode", "linkCode"]),
        });
      };

      el.addEventListener("loadabort", (e) => fromUrl(e.url, "loadabort"));
      el.addEventListener("newwindow", (e) => {
        fromUrl(e.targetUrl, "newwindow");
        // Never let the protocol URL escape the frame; there is no handler for
        // it on this machine and it only produces a browser error dialog.
        try {
          e.preventDefault();
        } catch (_) {
          /* not cancellable — the place id is already recorded */
        }
      });
    }

    /** Record a play request and hand it to the owner of this object. */
    requestPlay(placeId, how, selection = {}) {
      if (!placeId) return null;
      const play = { placeId: String(placeId), how, at: Date.now() };
      // A server click is more than a place id. Keep the exact instance and
      // private-server credentials through every channel, including storage.
      for (const key of ["jobId", "accessCode", "linkCode"]) {
        if (selection && selection[key]) play[key] = String(selection[key]);
      }
      this.playPending = play;
      try {
        this.onPlay(play);
      } catch (e) {
        this.log("onPlay handler threw: " + e);
      }
      return play;
    }

    /**
     * Consume the pending play request, if any. Returns `{placeId, how}` or
     * null, and never returns the same request twice.
     */
    takePlay() {
      const play = this.playPending;
      this.playPending = null;
      return play;
    }

    /**
     * Read the play request site.js wrote into the frame's isolated world and
     * clear it, so one click launches exactly once.
     *
     * Two channels, read in order:
     *   * window.__webloxPlay — the fast path. The isolated world is the same
     *     for every executeScript() call in a document (auth.js's evalAsync
     *     depends on that), so the property is right there.
     *   * localStorage — the fallback. Storage is per-origin, not per-world,
     *     so the request survives even if a future Chrome gives each call its
     *     own world. Both copies are cleared on every read.
     *
     * The body is one expression, not a sequence of statements: executeScript
     * answers with the value of the last statement, and an IIFE makes that
     * value the JSON string rather than whatever an assignment happens to
     * evaluate to.
     */
    async pollPlay() {
      if (!this.frame) return null;
      const raw = await this.evalSync(`
        (function () {
          var v = window.__webloxPlay || null;
          try {
            var stored = localStorage.getItem("__weblox_play");
            if (stored) {
              if (!v) v = JSON.parse(stored);
              localStorage.removeItem("__weblox_play");
            }
          } catch (e) {}
          window.__webloxPlay = null;
          return JSON.stringify(v);
        })()
      `);
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (!value || value === "undefined" || value === "null") return this.takePlay();
      let play;
      try {
        play = JSON.parse(value);
      } catch (e) {
        return this.takePlay();
      }
      if (!play || !play.placeId) return this.takePlay();
      // A request that sat in storage for minutes is not a click the user made
      // just now — it is a leftover from a session that ended mid-flight.
      if (play.at && Date.now() - play.at > PLAY_MAX_AGE_MS) {
        this.log(`ignoring stale play request (${play.placeId})`);
        return this.takePlay();
      }
      this.requestPlay(play.placeId, play.how || "site", play);
      return this.takePlay();
    }

    /**
     * gamejoin is the only host that needs the identity rewrite, and the scope
     * matters: adding a custom header to every roblox.com URL turns plain GETs
     * into preflighted requests, and Roblox's CORS configs do not allow the
     * header.
     */
    installInterceptor() {
      if (this.interceptor || !this.frame) return this.interceptor;
      this.interceptor = this.frame.request.createWebRequestInterceptor({
        urlPatterns: ["*://gamejoin.roblox.com/*"],
        blocking: true,
        includeHeaders: "all",
      });
      this.interceptor.addEventListener("beforesendheaders", (event) => {
        try {
          const original = event.headers || event.request?.headers;
          const headers = new Headers(original);
          headers.set("User-Agent", CLIENT_UA);
          event.setRequestHeaders(headers);
        } catch (e) {
          this.log("interceptor: " + e);
        }
      });
      this.interceptor.addEventListener("erroroccurred", (e) => this.log("request failed: " + (e.error || e.url)));
      return this.interceptor;
    }

    // ------------------------------------------------------- executeScript ---
    /**
     * executeScript returns the value of the last *statement* and does not
     * await promises. So an async body is started and its result stashed in the
     * frame's isolated world, which persists between calls.
     *
     * The old implementation then polled that object every 50ms. Hundreds of
     * avatar requests paid that delay each, plus another executeScript round
     * trip. The frame now posts the completed envelope to the parent as soon as
     * it exists; a 250ms executeScript poll remains only as a compatibility
     * fallback if postMessage is unavailable.
     */
    async evalAsync(body, timeoutMs = 20000) {
      if (!this.frame) throw new Error("frame not started");
      const id = ++this.seq;
      let onMessage = null;
      const cleanup = () => {
        if (onMessage) window.removeEventListener("message", onMessage);
        onMessage = null;
      };
      const notified = new Promise((resolve) => {
        onMessage = (event) => {
          if (event.origin !== "https://www.roblox.com") return;
          if (this.frame.contentWindow && event.source !== this.frame.contentWindow) return;
          const data = event.data;
          if (!data || data.type !== "weblox:eval" || data.id !== id) return;
          resolve(data.envelope || null);
        };
        window.addEventListener("message", onMessage);
      });
      const boot = `window.__rbx = window.__rbx || {};
        window.__rbx[${id}] = { done: false };
        (async () => {
          try { window.__rbx[${id}] = { done: true, ok: true, value: await (async () => { ${body} })() }; }
          catch (e) { window.__rbx[${id}] = { done: true, ok: false, error: String(e) }; }
          try { window.parent.postMessage({ type: 'weblox:eval', id: ${id}, envelope: window.__rbx[${id}] }, '*'); } catch (e) {}
        })();
        'go'`;
      try {
        await this.frame.executeScript({ code: boot });
      } catch (e) {
        cleanup();
        throw e;
      }

      const finish = (env) => {
        cleanup();
        // Responses can contain megabytes of base64. Do not retain every asset
        // for the lifetime of the frame after its value has been delivered.
        this.frame.executeScript({ code: `delete window.__rbx[${id}]` }).catch(() => {});
        if (!env.ok) throw new Error(env.error);
        return env.value;
      };
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const envelope = await Promise.race([notified, sleep(POLL_MS).then(() => null)]);
        if (envelope && envelope.done) return finish(envelope);

        const res = await this.frame.executeScript({
          code: `JSON.stringify(window.__rbx && window.__rbx[${id}])`,
        });
        const raw = Array.isArray(res) ? res[0] : res;
        if (!raw || raw === "undefined") continue;
        let env;
        try {
          env = JSON.parse(raw);
        } catch (e) {
          continue;
        }
        if (env && env.done) return finish(env);
      }
      cleanup();
      this.frame.executeScript({ code: `delete window.__rbx[${id}]` }).catch(() => {});
      throw new Error("evalAsync timed out after " + timeoutMs + "ms");
    }

    async evalSync(code) {
      const res = await this.frame.executeScript({ code });
      return Array.isArray(res) ? res[0] : res;
    }

    // ------------------------------------------------------------- login ----
    /** Is the frame's storage agent logged in? */
    async whoami() {
      const out = await this.evalAsync(`
        const r = await fetch('https://users.roblox.com/v1/users/authenticated', { credentials: 'include' });
        if (r.status !== 200) return null;
        const u = await r.json();
        return { id: u.id, name: u.name, displayName: u.displayName };
      `);
      return out || null;
    }

    /**
     * Write the cookie into the frame's jar from inside its own origin. Chrome
     * allows overwriting an HttpOnly cookie from script; only reading is
     * blocked. Used when the caller already has a .ROBLOSECURITY, so the first
     * run does not need a visible login.
     */
    async injectCookie(value) {
      if (!value) throw new Error("empty cookie");
      const literal = JSON.stringify(".ROBLOSECURITY=" + value + "; domain=.roblox.com; path=/; secure; samesite=lax");
      await this.evalAsync(`document.cookie = ${literal}; await new Promise(r => setTimeout(r, 50)); return true;`);
      const who = await this.whoami();
      if (!who) throw new Error("cookie rejected");
      this.log(`logged in as ${who.name} (${who.id})`);
      return who;
    }

    // -------------------------------------------------------------- join ----
    /**
     * Join a place and return its join script object.
     *
     * Content-Type is sent explicitly: the preflight for `application/json` is
     * allowed, and the interceptor's User-Agent rewrite rides on the same
     * request.
     */
    async join(placeId, selection = {}) {
      if (!this.frame) throw new Error("frame not started");
      const place = Number(placeId) || 0;
      // The jobId returned by gamejoin identifies an in-flight join attempt;
      // gameInstanceId is the server the user selected in Servers. They are not
      // interchangeable: only the latter belongs in the initial request.
      const server = {};
      if (selection.jobId) server.gameInstanceId = String(selection.jobId);
      if (selection.accessCode) server.accessCode = String(selection.accessCode);
      if (selection.linkCode) server.privateServerLinkCode = String(selection.linkCode);
      const serverJson = JSON.stringify(server);
      const script = await this.evalAsync(`
        const selectedServer = ${serverJson};
        const post = (jobId) => fetch('${GAMEJOIN}', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({
            placeId: ${place},
            isTeleport: false,
            gameJoinAttemptId: crypto.randomUUID(),
            browserTrackerId: 0,
            playSessionId: crypto.randomUUID(),
            eventId: crypto.randomUUID(),
            launchData: '',
            joinAttemptOrigin: 'PlayButton'
          }, selectedServer, jobId ? { jobId } : {}))
        }).then(r => r.json());

        let reply = await post(null);
        let tries = 0;
        while (reply.status === 0 && tries++ < 25) {
          await new Promise(r => setTimeout(r, 400));
          reply = await post(null);
        }
        if (reply.status !== 2) {
          throw new Error('join status ' + reply.status + ' ' + (reply.message || ''));
        }

        let s = reply.joinScript;
        let carrier = reply;
        if (!s || typeof s !== 'object') {
          const again = await post(reply.jobId);
          if (again.joinScript && typeof again.joinScript === 'object') {
            s = again.joinScript;
            carrier = again;
          }
        }
        if (!s || typeof s !== 'object') throw new Error('join script missing');

        return {
          // The engine asks for a join of its own; rbx-net answers that request
          // with this reply verbatim (see setJoinReply), so the whole body has
          // to survive the trip out of the frame.
          reply: carrier,
          requestedJobId: selectedServer.gameInstanceId || null,
          jobId: reply.jobId,
          tries,
          userId: s.UserId,
          userName: s.UserName,
          machine: s.MachineAddress,
          serverPort: s.ServerPort,
          udmux: (s.UdmuxEndpoints || [])[0] || null,
          connections: s.ServerConnections || null,
          token: s.TokenValue,
          pepper: s.PepperId,
          clientTicket: s.ClientTicket,
          gameId: s.GameId,
          placeId: s.PlaceId,
          script: s
        };
      `, 30000);
      this.log(`joined ${script.udmux?.Address}:${script.udmux?.Port} via ${script.tries} retr${script.tries === 1 ? "y" : "ies"}`);
      return script;
    }

    // ------------------------------------------------------------ bridge ----
    /**
     * One authenticated roblox.com request from inside the frame.
     *
     * The engine runs on isolated-app://, which is cross-origin to everything
     * Roblox and cannot attach a cookie. Every API call it makes is routed here
     * instead. Bodies cross as text or base64 so the value stays JSON-able.
     */
    async request(url, init = {}) {
      const cfg = JSON.stringify({ url, ...init });
      return this.evalAsync(`
        const c = ${cfg};
        let body = c.body != null ? c.body : undefined;
        if (c.bodyB64) {
          const bin = atob(c.bodyB64);
          body = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) body[i] = bin.charCodeAt(i);
        }
        const send = (credentials) => fetch(c.url, {
          method: c.method || 'GET',
          credentials,
          headers: c.headers || {},
          body,
          redirect: c.redirect || 'follow'
        });
        let r;
        try {
          r = await send('include');
        } catch (e) {
          // A host that answers 'access-control-allow-origin: *' cannot be read
          // on a credentialed request — the browser rejects the pair outright,
          // which is what made every avatar, decal and animation missing. The
          // content CDN signs its URLs, so the cookie was never needed there.
          try {
            r = await send('omit');
          } catch (e2) {
            throw new Error(c.url + ': ' + e2.message);
          }
        }
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let b64 = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return {
          status: r.status,
          url: r.url,
          headers: Object.fromEntries(r.headers.entries()),
          body: btoa(b64)
        };
      `, 60000);
    }

    /** Show or hide the frame. It has to be visible for an interactive login. */
    visible(on) {
      if (this.frame) this.frame.style.display = on ? "block" : "none";
    }

    /** Show the frame on top and wait until the user has logged in. */
    async interactiveLogin(timeoutMs = 10 * 60 * 1000) {
      this.visible(true);
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const who = await this.whoami().catch(() => null);
        if (who) {
          this.visible(false);
          return who;
        }
        await sleep(2000);
      }
      throw new Error("login timed out");
    }

    async logout() {
      if (this.frame) await this.frame.clearData();
      this.log("frame data cleared");
    }
  }

  window.RobloxAuth = RobloxAuth;
})();
