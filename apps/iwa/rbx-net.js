// rbx-net.js — every roblox.com call, answered from the authenticated frame.
//
// The engine runs on isolated-app://, which is cross-origin to everything
// Roblox: it cannot attach .ROBLOSECURITY and Roblox's CORS configs do not
// list that origin. The controlled frame is a real www.roblox.com context with
// the cookie in its jar, so this file redirects roblox.com to it and rebuilds a
// normal Response.
//
// The rule is the suffix, not a list of hosts. A list is a thing to maintain and
// to be wrong about: every host that is not on it reaches the network on its own
// and dies in a preflight, which is exactly the noise a list generates. Anything
// under roblox.com can be served by the frame, including the telemetry beacons —
// they are fire-and-forget and cost one round trip.
//
// clientsettings is the one exception and is handled before this: it is public,
// CORS-open, and carries the flag that selects RakNet.
//
// Workers cannot reach the frame, so they reach the page over a
// BroadcastChannel instead of borrowing the engine's own postMessage protocol.
(() => {
  if (self.__rbxNet) return;
  self.__rbxNet = 1;

  const base = (typeof globalThis.__webloxOrigin !== "undefined" && globalThis.__webloxOrigin) ||
    (typeof location !== "undefined" && location.origin) || "https://localhost";
  const isPage = typeof document !== "undefined";

  function hostOf(url) {
    try {
      return new URL(url, base).hostname;
    } catch (e) {
      return "";
    }
  }

  // Direct: hosts that do not want the cookie, and answer with
  // `access-control-allow-origin: *` so the app origin may read them anyway.
  //
  // contentdelivery matters most: it serves multi-megabyte signed blobs, and
  // crossing one through the frame means base64-encoding it into a string, into
  // another realm, and back — several megabytes of garbage per asset, which is
  // enough to run a 2 GB wasm heap into an allocation failure.
  const DIRECT = new Set([
    "clientsettings.roblox.com",
    "clientsettingscdn.roblox.com",
    "contentdelivery.roblox.com",
  ]);

  const isRoblox = (url) => {
    const host = hostOf(url);
    if (DIRECT.has(host)) return false;
    return host === "roblox.com" || host.endsWith(".roblox.com");
  };

  // ------------------------------------------------------------ transport ---
  const CHANNEL_NAME = "rbxnet";
  let channel = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch (e) {}
  }

  let seq = 0;
  const waiting = new Map(); // id -> resolve

  // ------------------------------------------------------------ local join ---
  // The engine performs its own join: POST /v1/join-game with only a placeId,
  // i.e. the *website* shape. That request is refused for any universe whose
  // join is gated (place 1818 answers "Playtesters Only", status 12), because
  // the gate is keyed on the client identity in the request, not on the user.
  //
  // The page has already done the join the native client does, with the native
  // body, so the reply is a join script the game server will honour. Answering
  // the engine's request with that same reply is both correct and free: one
  // join, one ticket, and the engine still drives the connection itself.
  let joinReply = null;

  function setJoinReply(reply) {
    joinReply = reply && reply.joinScript ? reply : null;
    console.log("[rbxnet] local join reply " + (joinReply ? "armed for place " + joinReply.joinScript.PlaceId : "cleared"));
  }

  function joinAnswer(url, init) {
    if (!joinReply) return null;
    if (String(url).split("?")[0] !== "https://gamejoin.roblox.com/v1/join-game") return null;
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method !== "POST") return null;
    // A teleport or a different place must not be answered with this script.
    let want = null;
    try {
      want = JSON.parse((init && init.body) || "{}").placeId;
    } catch (e) {
      return null;
    }
    if (want != null && Number(want) !== Number(joinReply.joinScript.PlaceId)) return null;
    const json = JSON.stringify(joinReply);
    const bytes = new TextEncoder().encode(json);
    let b64 = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return { status: 200, url, headers: { "content-type": "application/json" }, body: btoa(b64) };
  }

  if (channel) {
    channel.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.kind === "req" && isPage && self.__rbxAuth) {
        const local = joinAnswer(msg.url, msg.init);
        if (local) {
          note(msg.url, msg.init && msg.init.method, local.status, "local");
          channel.postMessage({ kind: "res", id: msg.id, res: local });
          return;
        }
        self.__rbxAuth
          .request(msg.url, msg.init)
          .then((res) => {
            note(msg.url, msg.init && msg.init.method, res.status, "worker");
            channel.postMessage({ kind: "res", id: msg.id, res });
          })
          .catch((e) => {
            note(msg.url, msg.init && msg.init.method, 0, "worker", e && e.message);
            channel.postMessage({ kind: "res", id: msg.id, error: String(e) });
          });
      } else if (msg.kind === "res") {
        const resolve = waiting.get(msg.id);
        if (resolve) {
          waiting.delete(msg.id);
          resolve(msg);
        }
      }
    };
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  /** Normalise a fetch init into something structured-cloneable. */
  async function encodeInit(init = {}) {
    const out = {
      method: init.method || "GET",
      headers: {},
      redirect: init.redirect || "follow",
    };
    const h = new Headers(init.headers || {});
    for (const [k, v] of h) out.headers[k] = v;
    let body = init.body;
    if (body == null) return out;
    if (typeof body === "string") {
      out.body = body;
    } else if (body instanceof URLSearchParams) {
      out.body = body.toString();
      out.headers["content-type"] = out.headers["content-type"] || "application/x-www-form-urlencoded;charset=UTF-8";
    } else if (body instanceof Blob) {
      out.body = await body.text();
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      out.bodyB64 = bytesToB64(bytes);
      out.body = "";
    } else {
      out.body = String(body);
    }
    return out;
  }

  function viaChannel(url, init) {
    if (!channel) return Promise.reject(new Error("no BroadcastChannel for " + url));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.res);
      });
      channel.postMessage({ kind: "req", id, url, init });
    });
  }

  // ------------------------------------------------------------ telemetry ---
  // A bounded record of every roblox.com call the app makes, which is how the
  // host list below was trimmed and how a missing one gets noticed. Workers
  // have their own `self`; their calls are recorded here, on the page, where
  // the frame actually serves them.
  const recent = [];
  if (typeof self !== "undefined") self.__rbxNetLog = recent;

  function note(url, method, status, via, error) {
    const entry = { url: String(url), method: method || "GET", status: status | 0, via: via || "page" };
    if (error) entry.error = String(error);
    recent.push(entry);
    if (recent.length > 300) recent.shift();
  }

  async function rbxRequest(url, init) {
    const encoded = await encodeInit(init);
    const local = joinAnswer(url, encoded);
    if (local) {
      note(url, encoded.method, local.status, "local");
      return local;
    }
    let res;
    try {
      res = isPage && self.__rbxAuth ? await self.__rbxAuth.request(url, encoded) : await viaChannel(url, encoded);
    } catch (e) {
      note(url, encoded.method, 0, isPage ? "page" : "worker", e && e.message);
      throw e;
    }
    note(url, encoded.method, res.status, isPage ? "page" : "worker");
    return res;
  }

  function toResponse(res) {
    const headers = new Headers(res.headers || {});
    const bytes = res.body ? b64ToBytes(res.body) : new Uint8Array(0);
    const nullBody = bytes.length === 0 || res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : bytes, { status: res.status, statusText: "", headers });
  }

  // --------------------------------------------------------------- patch ----
  // clientsettings is public and CORS-open, so it goes straight out. It is
  // also where the transport flag lives: RakNet only gets used if the engine is
  // told not to pick RbxTransport.
  const SETTINGS_RE = /^https:\/\/clientsettings(cdn)?\.roblox\.com\/v2\/settings\/application\/WebClientApp/;

  // fflags.json is the low-end profile shipped in the bundle. A page can also
  // put an object in localStorage["weblox.fflags"] to override it without a
  // rebuild. Workers have no localStorage, so the file is fetched per realm;
  // WasmPlayer's preloaded flags are read on the page, where both apply.
  let flagProfilePromise = null;
  function flagProfile() {
    if (flagProfilePromise) return flagProfilePromise;
    flagProfilePromise = (async () => {
      const merged = {};
      try {
        const res = await origFetch.call(self, base + "/fflags.json", { credentials: "omit", cache: "no-store" });
        if (res.ok) {
          const profile = await res.json();
          if (profile && typeof profile === "object" && !Array.isArray(profile)) Object.assign(merged, profile);
        } else {
          console.warn("[fflags] profile HTTP " + res.status + "; using transport flags only");
        }
      } catch (e) {
        console.warn("[fflags] profile unavailable; using transport flags only", e);
      }
      if (isPage) {
        try {
          const custom = JSON.parse(localStorage.getItem("weblox.fflags") || "{}");
          if (custom && typeof custom === "object" && !Array.isArray(custom)) Object.assign(merged, custom);
        } catch (e) {
          console.warn("[fflags] invalid localStorage override", e);
        }
      }
      return merged;
    })();
    return flagProfilePromise;
  }

  async function settingsOverride(url, init) {
    const r = await origFetch.call(self, url, { ...(init || {}), credentials: "omit" });
    let doc;
    try {
      doc = await r.json();
    } catch (e) {
      return r;
    }
    const app = doc.applicationSettings;
    if (app) {
      const profile = await flagProfile();
      for (const [key, value] of Object.entries(profile)) {
        // Never write arbitrary object properties into the settings document.
        if (!/^D?F(?:Flag|Int|Log|String)/.test(key)) continue;
        if (value === null) delete app[key];
        else if (typeof value === "boolean") app[key] = value ? "True" : "False";
        else if (typeof value === "string" || typeof value === "number") app[key] = String(value);
      }
      // Transport is not a preference: overriding it reintroduces the dummy
      // WebTransport path and guarantees tx:0, so it is applied last.
      app.FFlagUseRbxTransportClient3 = "False";
      app.FFlagUseRbxTransportServer = "False";
      self.__webloxFFlags = {};
      for (const key of Object.keys(profile).sort()) {
        if (Object.prototype.hasOwnProperty.call(app, key)) self.__webloxFFlags[key] = app[key];
      }
    }
    console.log("[rbxnet] settings override -> " + JSON.stringify({
      raknet: app && app.FFlagUseRbxTransportClient3,
      profileFlags: self.__webloxFFlags ? Object.keys(self.__webloxFFlags).length : 0,
      status: r.status,
    }));
    return new Response(JSON.stringify(doc), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }

  // Everything that is not routed through the frame is fetched by the app
  // origin itself. Those hosts all answer `access-control-allow-origin: *`,
  // and a wildcard is only legal on an uncredentialed request — so the
  // engine's `withCredentials` has to be dropped, not passed along.
  function uncredentialed(init) {
    const out = { ...(init || {}) };
    out.credentials = "omit";
    return out;
  }

  const looksLikeAsset = (url) => {
    const host = hostOf(url);
    return DIRECT.has(host);
  };

  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (url && SETTINGS_RE.test(new URL(url, base).href)) return settingsOverride(new URL(url, base).href, init);
    if (!url || !isRoblox(url)) {
      const pass = init || undefined;
      if (url && looksLikeAsset(url)) {
        const opts = uncredentialed(pass);
        return origFetch.call(self, input, opts).then((res) => {
          note(url, opts.method, res.status, "direct");
          return res;
        });
      }
      return origFetch.call(self, input, pass);
    }
    const opts = init || (input && input.url && !(input instanceof Request) ? undefined : input);
    // A Request body has to be read before it can cross the channel.
    const run = input instanceof Request && !init ? input.text().then((text) => ({ ...(opts || {}), body: text })) : Promise.resolve(opts || {});
    return run.then((o) => rbxRequest(new URL(url, base).href, o)).then(toResponse);
  };

  // Emscripten's fetch backend drives XMLHttpRequest, so a small shim that
  // resolves through the same path keeps it working without a full XHR.
  const OrigXHR = self.XMLHttpRequest;
  if (OrigXHR) {
    class FrameXHR extends EventTarget {
      constructor() {
        super();
        this.readyState = 0;
        this.status = 0;
        this.statusText = "";
        this.response = null;
        this.responseText = "";
        // The engine reads `responseURL.length` on every readyState 2, so this
        // has to be a string even when the request never left the page.
        this.responseURL = "";
        this.responseXML = null;
        this.responseType = "";
        this.withCredentials = false;
        this.timeout = 0;
        this._headers = {};
        this._resHeaders = new Headers();
        this._aborted = false;
        this.onload = null;
        this.onerror = null;
        this.onreadystatechange = null;
        this.ontimeout = null;
        this.onprogress = null;
      }

      open(method, url) {
        this._method = method;
        this._url = new URL(url, base).href;
        this._robox = isRoblox(this._url);
        if (!this._robox) {
          this._real = new OrigXHR();
          const real = this._real;
          // readystatechange, not load: the engine reads assets from the state
          // machine, and load alone arrives after it has given up.
          real.onreadystatechange = () => this._syncFromReal();
          real.onerror = () => this._fail();
          real.ontimeout = () => this._fire("timeout");
          real.onprogress = (e) => this._fire("progress");
          real.open(...arguments);
          return;
        }
        this.readyState = 1;
        this._fire("readystatechange");
      }

      setRequestHeader(k, v) {
        if (this._real) return this._real.setRequestHeader(k, v);
        this._headers[k] = v;
      }

      getResponseHeader(k) {
        if (this._real) return this._real.getResponseHeader(k);
        return this._resHeaders.get(k);
      }

      getAllResponseHeaders() {
        if (this._real) return this._real.getAllResponseHeaders();
        return [...this._resHeaders].map(([k, v]) => `${k}: ${v}`).join("\r\n");
      }

      overrideMimeType() {}

      abort() {
        this._aborted = true;
        if (this._real) this._real.abort();
      }

      send(body) {
        if (this._real) {
          const real = this._real;
          // These are configured after open() and before send(), so they have
          // to be copied onto the real XHR here. responseType especially: the
          // engine loads every asset as an arraybuffer.
          real.responseType = this.responseType;
          real.timeout = this.timeout;
          // A wildcard-CORS host rejects a credentialed request outright.
          real.withCredentials = looksLikeAsset(this._url) ? false : this.withCredentials;
          return real.send(body);
        }
        rbxRequest(this._url, { method: this._method || "GET", headers: this._headers, body })
          .then((res) => {
            if (this._aborted) return;
            const bytes = res.body ? b64ToBytes(res.body) : new Uint8Array(0);
            this.status = res.status;
            this.responseURL = res.url || this._url;
            this._resHeaders = new Headers(res.headers || {});
            this.readyState = 4;
            if (this.responseType === "arraybuffer") this.response = bytes.buffer;
            else if (this.responseType === "blob") this.response = new Blob([bytes]);
            else {
              this.responseText = new TextDecoder().decode(bytes);
              this.response = this.responseText;
            }
            this._fire("readystatechange");
            this._fire("load");
          })
          .catch((e) => this._fail(e));
      }

      _syncFromReal() {
        const r = this._real;
        this.readyState = r.readyState;
        this.status = r.status;
        this.statusText = r.statusText;
        this.responseURL = r.responseURL || this._url;
        this.response = r.response;
        // Reading responseText throws once responseType is anything but "" or
        // "text" — which is every asset in this client.
        try {
          this.responseText = r.responseType === "" || r.responseType === "text" ? r.responseText : "";
        } catch (e) {
          this.responseText = "";
        }
        this._fire("readystatechange");
        if (r.readyState === 4) this._fire("load");
      }

      _fail(e) {
        this.readyState = 4;
        this.status = 0;
        if (typeof this.onerror === "function") this.onerror(e || { target: this });
      }

      _fire(type) {
        const ev = new Event(type);
        this.dispatchEvent(ev);
        const handler = this["on" + type];
        if (typeof handler === "function") handler.call(this, ev);
      }
    }
    for (const k of ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"]) {
      FrameXHR[k] = OrigXHR[k];
    }
    FrameXHR.prototype.UNSENT = 0;
    FrameXHR.prototype.OPENED = 1;
    FrameXHR.prototype.HEADERS_RECEIVED = 2;
    FrameXHR.prototype.LOADING = 3;
    FrameXHR.prototype.DONE = 4;
    self.XMLHttpRequest = FrameXHR;
  }

  // ---------------------------------------------------------------- images ---
  // rbxcdn sends ACAO: * but no CORP, and a COEP page refuses cross-origin
  // subresources without it. Fetching with CORS and handing the element a blob:
  // URL (same-origin) sidesteps that without a proxy.
  const CDN_RE = /^https?:\/\/([a-z0-9-]+\.)*rbxcdn\.com\//i;
  const blobs = new Map();
  if (typeof HTMLImageElement !== "undefined") {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(v) {
        const url = String(v);
        if (!CDN_RE.test(url)) return desc.set.call(this, url);
        const hit = blobs.get(url);
        if (hit) return desc.set.call(this, hit);
        origFetch
          .call(self, url, { mode: "cors", credentials: "omit" })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("HTTP " + r.status))))
          .then((b) => {
            const blobUrl = URL.createObjectURL(b);
            blobs.set(url, blobUrl);
            if (blobs.size > 512) {
              const oldest = blobs.keys().next().value;
              URL.revokeObjectURL(blobs.get(oldest));
              blobs.delete(oldest);
            }
            desc.set.call(this, blobUrl);
          })
          .catch(() => desc.set.call(this, url));
      },
    });
  }

  self.__rbxNetSetJoin = setJoinReply;
  self.__rbxNetRule = "*.roblox.com";
})();
