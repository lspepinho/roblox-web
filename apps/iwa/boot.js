// boot.js — the globals the engine loader expects before it runs, plus the two
// things the browser forces on us: a Trusted Types policy and audio policy.

window.__wasmLoaderContext = {
  engineBase: (window.__webloxOrigin || location.origin) + "/engine",
  server: "prod",
  channel: null,
  workerStubUrl: (window.__webloxOrigin || location.origin) + "/stub.js",
};

// require-trusted-types-for 'script' rejects a plain string on script.src,
// new Worker(...) and importScripts(). A policy named "default" is applied to
// every sink automatically, so no call site — ours or the engine's — has to
// know about it. It asserts nothing about the URL: CSP already restricts scripts
// to 'self', and that is the check that holds.
if (typeof trustedTypes !== "undefined") {
  try {
    trustedTypes.createPolicy("default", {
      createScriptURL: (url) => url,
      createScript: (src) => src,
      createHTML: (html) => html,
    });
  } catch (e) {
    // A default policy already exists; nothing to add.
  }
}

// --------------------------------------------------------------- audio ------
// Two browser facts, both handled here because the engine gets them wrong.
//
// Chrome will not start an AudioContext before the page is interacted with, and
// the engine builds its own while booting. So every context is resumed on input
// (and retried every couple of seconds), which is what unlocks it.
//
// The engine also parks its mixer with mixerSuspend() at start-up and never
// lifts it: a suspended context never runs onaudioprocess, so the client is
// silent with a perfectly good graph. suspend() is therefore a no-op.
//
// FMOD has two outputs. Prefer AudioWorklet: it mixes off the main thread,
// which avoids the known FMOD_JS_MixFunction -> ExplicitTerminate stack in the
// ScriptProcessor callback. FMOD gates construction on a resume() that can stay
// pending, so resume() is best-effort here and immediately continuable; the
// context's real state remains observable and is retried on input. The legacy
// fallback stays available with a larger buffer to tolerate main-thread stalls.
(() => {
  const Native = window.AudioContext || window.webkitAudioContext;
  if (!Native) return;

  const live = new Set();
  const sinks = [];

  const resume = () => {
    for (const ctx of live) if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };

  class OpenAudioContext extends Native {
    constructor(...args) {
      super(...args);
      live.add(this);
      this.addEventListener("statechange", () => {
        if (this.state === "closed") live.delete(this);
      });
      // Logged, not silent: if the engine ever suspends mid-session this is the
      // line to look for next to a stall.
      this.suspend = () => {
        console.log("[audio] suspend suppressed (live contexts: " + live.size + ")");
        return Promise.resolve();
      };
      this.resume = () => {
        try {
          const pending = Native.prototype.resume.call(this);
          if (pending && pending.catch) pending.catch((e) => console.warn("[audio] native resume:", e));
        } catch (e) {
          console.warn("[audio] native resume:", e);
        }
        // FMOD builds its worklet only in a .then() attached to this promise.
        // The node may legally be constructed while the context is suspended;
        // the input/interval retries above keep unlocking the real context.
        return Promise.resolve();
      };
      resume();
    }
  }

  window.AudioContext = window.webkitAudioContext = OpenAudioContext;

  // A context created inside the gesture is allowed to start immediately. It
  // stays alive, which keeps the document unlocked for the engine's own context.
  const unlock = () => {
    try {
      new AudioContext();
    } catch (e) {
      console.warn("[audio] unlock failed:", e);
    }
  };

  const NativeWorkletNode = window.AudioWorkletNode;
  if (NativeWorkletNode) {
    window.AudioWorkletNode = class OpenAudioWorkletNode extends NativeWorkletNode {
      constructor(...args) {
        super(...args);
        sinks.push(this);
        console.log("[audio] worklet sink created (off-main-thread mixer)");
      }
    };
  }

  // Legacy fallback, held so the console can tell "no sink" from "silent".
  // 1024 frames is only ~21ms at 48kHz: a stalled main thread can starve the
  // mixer. 4096 gives it ~85ms of slack and four times fewer JS->wasm calls.
  const nativeProcessor = AudioContext.prototype.createScriptProcessor;
  if (nativeProcessor) {
    AudioContext.prototype.createScriptProcessor = function (...args) {
      args[0] = Math.max(args[0] || 4096, 4096);
      const node = nativeProcessor.apply(this, args);
      sinks.push(node);
      console.log("[audio] script processor fallback: buffer=" + node.bufferSize + " channels=" + node.channelCount);
      return node;
    };
  }

  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    addEventListener(type, resume, { capture: true, passive: true });
    addEventListener(type, unlock, { capture: true, passive: true, once: true });
  }
  addEventListener("visibilitychange", resume);
  setInterval(resume, 2000);

  // `__audio()` — live contexts and the mixer's sink. `__audioPeak(ms)` — the
  // amplitude leaving that sink, which separates "silent mixer" from "muted".
  window.__audio = () => ({
    contexts: [...live].map((c) => ({ state: c.state, rate: c.sampleRate })),
    sinks: sinks.map((n) => ({
      kind: n.constructor.name,
      state: n.context.state,
      buffer: n.bufferSize || null,
      channels: n.channelCount,
    })),
  });

  window.__audioPeak = async (ms = 1000) => {
    const node = sinks[0];
    if (!node) return { error: "no sink" };
    const ctx = node.context;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    node.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
    node.disconnect(analyser);
    return { state: ctx.state, peak };
  };
})();

// ----------------------------------------------------------- engine exit ----
// WasmPlayer installs window.__resolveGameExit itself, twice: once as a stub and
// once as the resolver the engine's crash callback settles. Wrapping it on
// assignment is the only place the reason is visible — the engine reports a
// crash as {reason:"crash", errorType:"ExplicitTerminate"} and otherwise only
// logs an opaque object. Every crash is shown: tx/rx remaining active does not
// prove the engine survived, so a live socket must never suppress the report.
(() => {
  let handler = null;
  let told = false;
  Object.defineProperty(window, "__resolveGameExit", {
    configurable: true,
    get: () => handler,
    set: (fn) => {
      handler = function (e) {
        const reason = e && e.reason;
        const type = e && e.errorType;
        console.log("[exit] reason=" + reason + (type ? " type=" + type : ""));
        if (reason === "crash" && !told) {
          told = true;
          window.alert("Roblox crashed.\n\n" + (type || e.errorMessage || "The engine stopped."));
        }
        // app.js registers this. It is called *before* the engine's own
        // resolver so the harness always hears the reason even if the engine's
        // handler throws — and the crash alert above has already been shown by
        // then, so nothing is lost by returning.
        try {
          if (typeof window.__onGameExit === "function") window.__onGameExit(e);
        } catch (err) {
          console.error("[exit] __onGameExit threw:", err);
        }
        return fn.apply(this, arguments);
      };
    },
  });
})();

// ----------------------------------------------------------- hard stops -----
// The engine's loader catches its own start-up failures and only logs them, so a
// dead client would otherwise be a black window with one console line. Anything
// that stops start-up becomes one alert.
(() => {
  let alerted = false;
  const report = (text) => {
    if (alerted) return;
    alerted = true;
    window.alert("Roblox failed to start.\n\n" + String(text).split("\n")[0].slice(0, 300));
  };

  const nativeError = console.error.bind(console);
  console.error = (...args) => {
    nativeError(...args);
    const text = args.map((a) => (a && a.message) || String(a)).join(" ");
    if (alerted) return;
    if (/startup failed|could not allocate memory|Invalid atomic access index/i.test(text)) report(text);
  };

  addEventListener("error", (e) => {
    if (self.Module) return;
    report((e && e.message) || e);
  });
})();
