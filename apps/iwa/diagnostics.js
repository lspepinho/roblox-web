// diagnostics.js — what the engine actually asked for, and what it said.
//
// Loaded first in index.html, and imported by stub.js in every worker, so both
// realms are covered. It exists because the failure that matters is invisible
// from the source: the asset URLs are built *inside* the wasm, so no grep can
// tell you which path 404s. And the engine's own error text is drawn with the
// very fonts that may be failing, so the user cannot read it either. The report
// therefore ends up in the DOM, in app.js's panel (F8).
//
// Four recorders, one report:
//
//   fetch / XHR   what went out and what came back
//   console       what the engine logged — the crash screen itself says
//                 "Open devtools console for full logs", and a crashed engine
//                 has no devtools to open, so the console is recorded here
//   errors        uncaught exceptions and rejected promises, with stacks
//   rbx.net       the roblox.com calls, which never appear in the fetch log
//                 because rbx-net.js answers them from the controlled frame
//
// Nothing is changed in flight — the same Response, the same XHR behaviour,
// the same console — only recorded.
(() => {
  if (self.__webloxDiag) return;
  self.__webloxDiag = true;

  const inWorker = typeof document === "undefined";
  const requests = []; // ring buffer, newest last
  const failures = [];
  const logs = [];
  const errors = [];
  const MAX_REQUESTS = 600;
  const MAX_FAILURES = 120;
  const MAX_LOGS = 500;
  const MAX_ERRORS = 60;
  const started = Date.now();
  let seen = 0;
  let heartbeat = "";
  let webglCache = null;

  // Workers have no window to read, so they post their records to the page.
  // Same pattern as rbx-net.js: BroadcastChannel, not the engine's postMessage.
  let channel = null;
  try {
    channel = new BroadcastChannel("weblox-diag");
  } catch (e) {
    channel = null;
  }

  function record(entry) {
    seen++;
    entry.t = Date.now();
    if (inWorker) {
      entry.w = 1;
      try {
        if (channel) channel.postMessage(entry);
      } catch (e) {}
      return;
    }
    requests.push(entry);
    if (requests.length > MAX_REQUESTS) requests.shift();
    if (entry.error || (entry.s !== undefined && entry.s >= 400)) {
      failures.push(entry);
      if (failures.length > MAX_FAILURES) failures.shift();
    }
  }

  if (channel && !inWorker) {
    channel.addEventListener("message", (e) => {
      const entry = e.data;
      if (!entry) return;
      if (entry.kind === "log") {
        pushLog(entry, true);
        return;
      }
      if (entry.kind === "error") {
        pushError(entry, true);
        return;
      }
      if (!entry.u) return;
      seen++;
      requests.push(entry);
      if (requests.length > MAX_REQUESTS) requests.shift();
      if (entry.error || (entry.s !== undefined && entry.s >= 400)) {
        failures.push(entry);
        if (failures.length > MAX_FAILURES) failures.shift();
      }
    });
  }

  const short = (url) => {
    const u = String(url);
    return u.length > 220 ? u.slice(0, 217) + "..." : u;
  };

  // ---------------------------------------------------------------- fetch ---
  if (typeof self.fetch === "function") {
    const original = self.fetch;
    self.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      let result;
      try {
        result = original.call(this, input, init);
      } catch (e) {
        record({ m: method, u: short(url), e: String(e) });
        throw e;
      }
      return result.then(
        (res) => {
          record({ m: method, u: short(url), s: res.status });
          return res;
        },
        (e) => {
          record({ m: method, u: short(url), e: String(e) });
          throw e;
        }
      );
    };
  }

  // ------------------------------------------------------------------ XHR ---
  const X = self.XMLHttpRequest;
  if (X && X.prototype) {
    const open = X.prototype.open;
    const send = X.prototype.send;
    X.prototype.open = function (method, url) {
      this.__webloxDiagRequest = { m: String(method || "GET").toUpperCase(), u: short(url) };
      return open.apply(this, arguments);
    };
    X.prototype.send = function () {
      const rec = this.__webloxDiagRequest;
      if (rec) {
        this.addEventListener("load", () => record({ ...rec, s: this.status }));
        this.addEventListener("error", () => record({ ...rec, e: "network error" }));
        this.addEventListener("abort", () => record({ ...rec, e: "aborted" }));
        this.addEventListener("timeout", () => record({ ...rec, e: "timeout" }));
      }
      return send.apply(this, arguments);
    };
  }

  // -------------------------------------------------------------- console ---
  // The engine logs everything it does, and the crash screen points at the
  // devtools console for the full story. A crashed engine has no devtools, so
  // the console is copied here instead.
  //
  // The heartbeat line is dropped: the engine prints one every 500ms, and
  // those would push the interesting lines out of the buffer before anyone
  // could read them. Its number is kept separately.
  function pushLog(entry, fromWorker) {
    const text = String(entry.text || "").replace(/\s+/g, " ").slice(0, 400);
    if (/^\[MAIN\] heartbeat/.test(text)) {
      heartbeat = text;
      return;
    }
    logs.push({ ms: entry.ms || 0, lvl: entry.lvl || "log", w: fromWorker ? 1 : 0, text });
    if (logs.length > MAX_LOGS) logs.shift();
  }

  function pushError(entry, fromWorker) {
    errors.push({
      ms: entry.ms || 0,
      w: fromWorker ? 1 : 0,
      what: String(entry.what || "error"),
      message: String(entry.message || "").slice(0, 600),
      stack: String(entry.stack || "").slice(0, 1200),
    });
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  function formatArg(a) {
    if (typeof a === "string") return a;
    if (a === undefined) return "undefined";
    if (a === null) return "null";
    if (a instanceof Error) return a.stack || a.message;
    // Errors can come from another realm (the engine creates some in workers),
    // where instanceof Error is false but the useful fields are still there.
    if (a && typeof a === "object" && (a.stack || a.message)) return a.stack || a.message;
    try {
      if (typeof a === "object") {
        const s = JSON.stringify(a);
        return s === undefined ? String(a) : s;
      }
      return String(a);
    } catch (e) {
      return String(a);
    }
  }

  ["log", "warn", "error", "info", "debug"].forEach((lvl) => {
    const original = console[lvl] ? console[lvl].bind(console) : null;
    if (!original) return;
    console[lvl] = (...args) => {
      const text = args.map(formatArg).join(" ");
      const entry = { kind: "log", ms: Date.now() - started, lvl, text };
      if (inWorker) {
        // Do not spend a BroadcastChannel message on the 500ms heartbeat.
        if (!/^\[MAIN\] heartbeat/.test(text)) {
          try {
            if (channel) channel.postMessage(entry);
          } catch (e) {}
        }
      } else {
        pushLog(entry, false);
      }
      return original(...args);
    };
  });

  // -------------------------------------------------------- uncaught errors --
  function reportError(what, message, stack) {
    const entry = { kind: "error", ms: Date.now() - started, what, message, stack };
    if (inWorker) {
      try {
        if (channel) channel.postMessage(entry);
      } catch (e) {}
    } else {
      pushError(entry, false);
    }
  }

  self.addEventListener("error", (e) => {
    const err = e && e.error;
    reportError(
      e && e.message ? "uncaught" : "resource",
      (e && e.message) || (e && e.target && e.target.src) || String(e),
      err && err.stack
    );
  });

  self.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    reportError(
      "unhandledrejection",
      r && r.message ? r.message : String(r),
      r && r.stack
    );
  });

  // ----------------------------------------------------------------- webgl --
  // The engine draws its crash screen with WebGL, so the next question after
  // a crash is always "which context did it get?".
  function webglInfo() {
    const out = {};
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) {
        out.context = "none";
        return out;
      }
      out.context = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
      out.version = gl.getParameter(gl.VERSION);
      out.glsl = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    } catch (e) {
      out.error = String(e);
    }
    return out;
  }

  // --------------------------------------------------------------- report ---
  const line = (e) =>
    `  ${e.w ? "[worker] " : ""}${e.m} ${e.u} -> ${e.e ? e.e : e.s}`;

  function section(title, list, count) {
    if (!list.length) return `\n${title}\n  (none)\n`;
    return `\n${title}\n${list.slice(-count).map(line).join("\n")}\n`;
  }

  const logLine = (e) =>
    `  ${String(e.ms).padStart(6)}ms ${e.w ? "[worker] " : ""}[${e.lvl}] ${e.text}`;

  const errLine = (e) =>
    `  ${String(e.ms).padStart(6)}ms ${e.w ? "[worker] " : ""}${e.what}: ${e.message}` +
    (e.stack ? `\n${e.stack.split("\n").slice(0, 6).map((l) => "      " + l.trim()).join("\n")}` : "");

  self.__diagText = () => {
    let ring = "(not started)";
    try {
      if (typeof self.__rkRing === "function") ring = JSON.stringify(self.__rkRing());
    } catch (e) {
      ring = "error: " + e;
    }
    const fonts = requests.filter((e) => /font|ttf|otf/i.test(e.u));
    const net = (self.__rbxNetLog || []).slice(-25);
    const netText = net.length
      ? net
          .map((e) => `  ${e.via || ""} ${e.method || "GET"} ${short(e.url)} -> ${e.error || e.status}`)
          .join("\n")
      : "  (none)";
    return [
      `url: ${location.href}`,
      `whoami: ${JSON.stringify(self.__whoami || null)}`,
      `ring: ${ring}`,
      `last exit: ${JSON.stringify(self.__lastGameExit || null)}`,
      `last heartbeat: ${heartbeat || "(none)"}`,
      `fflags: ${JSON.stringify(self.__webloxFFlags || null)}`,
      `renderScale: ${JSON.stringify(self.__renderScale || null)}`,
      `webgl: ${JSON.stringify(webglCache || (webglCache = webglInfo()))}`,
      `audio: ${JSON.stringify(typeof self.__audio === "function" ? self.__audio() : null)}`,
      `environment: ${JSON.stringify({ crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent })}`,
      `requests seen: ${seen} (${requests.length} kept), failures: ${failures.length}, logs: ${logs.length}`,
      `\nUNCAUGHT ERRORS (last 15)\n${errors.length ? errors.slice(-15).map(errLine).join("\n") : "  (none)"}`,
      `\nCONSOLE (last 40)\n${logs.length ? logs.slice(-40).map(logLine).join("\n") : "  (none)"}`,
      `\nROBLOX.COM CALLS (last 25)\n${netText}`,
      section("FAILURES (last 30)", failures, 30),
      section("FONT REQUESTS (last 25)", fonts, 25),
      section("LAST 15 REQUESTS", requests, 15),
    ].join("\n");
  };

  self.__diagRequests = requests;
  self.__diagFailures = failures;
  self.__diagLogs = logs;
  self.__diagErrors = errors;
})();
