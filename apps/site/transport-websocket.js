// WebSocket transport with the same opened/readable/writable shape as UDPSocket.
// The Render service owns the actual UDP socket; this realm only moves binary
// frames, so RUPP and the patched engine remain identical to the IWA version.
(() => {
  class WebSocketTransport {
    constructor({ remoteAddress, remotePort }) {
      const proxy = globalThis.__webloxProxy;
      if (!proxy || !proxy.token) throw new Error("proxy session is not ready");
      const origin = globalThis.__webloxOrigin || location.origin;
      const scheme = origin.startsWith("https:") ? "wss" : "ws";
      const host = new URL(origin).host;
      const url = `${scheme}://${host}/raknet?host=${encodeURIComponent(remoteAddress)}&port=${encodeURIComponent(remotePort)}`;

      this.opened = new Promise((resolve, reject) => {
        // The token stays out of the URL (and therefore out of Render's HTTP
        // logs). The first protocol is the transport name; the second carries
        // the short-lived session token in the handshake header.
        const ws = new WebSocket(url, ["weblox", "token." + proxy.token]);
        ws.binaryType = "arraybuffer";
        this._ws = ws;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { ws.close(); } catch {}
            reject(new Error("WebSocket proxy timed out"));
          }
        }, 15000);

        const readable = new ReadableStream({
          start: (controller) => {
            this._controller = controller;
          },
          cancel: () => {
            try { ws.close(); } catch {}
          },
        });
        const writable = new WritableStream({
          write: async ({ data }) => {
            if (ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket proxy is not open");
            ws.send(data);
          },
          close: () => {
            try { ws.close(); } catch {}
          },
        });

        ws.onopen = () => {
          settled = true;
          clearTimeout(timer);
          resolve({ readable, writable, localPort: 0 });
        };
        ws.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("WebSocket proxy connection failed"));
          }
        };
        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            this._controller.enqueue({ data: new Uint8Array(event.data) });
          } else if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((buffer) => {
              this._controller.enqueue({ data: new Uint8Array(buffer) });
            }).catch(() => {});
          }
        };
        ws.onclose = () => {
          try { this._controller.close(); } catch {}
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("WebSocket proxy closed before opening"));
          }
        };
      });
    }

    close() {
      if (this._ws) this._ws.close();
    }
  }

  globalThis.__webloxSocketFactory = (options) => new WebSocketTransport(options);
})();
