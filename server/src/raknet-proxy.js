import dgram from "node:dgram";
import net from "node:net";
import { WebSocketServer } from "ws";

const MAX_DATAGRAM = 1500;

export function attachRaknetProxy(httpServer, sessions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1600, perMessageDeflate: false });

  httpServer.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/raknet") return;

    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((value) => value.trim());
    const token = (protocols.find((value) => value.startsWith("token.")) || "").slice(6);
    const host = url.searchParams.get("host") || "";
    const port = Number(url.searchParams.get("port"));
    const session = sessions.get(token);
    const validHost = net.isIP(host) || /^[a-z0-9.-]+$/i.test(host);
    if (
      !session ||
      !validHost ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !sessions.allows(session, host, port)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const udp = dgram.createSocket("udp4");
    let ready = false;
    let closed = false;
    let current = null;
    const pending = [];

    const close = () => {
      if (closed) return;
      closed = true;
      try {
        udp.close();
      } catch {}
      if (current && current.readyState === current.OPEN) current.close();
    };

    const send = (data) => {
      if (closed || !ready) return;
      try {
        udp.send(data, port, host, (error) => {
          if (error) close();
        });
      } catch {
        // A queued WebSocket message can arrive after udp.close(). Node throws
        // ERR_SOCKET_DGRAM_NOT_RUNNING synchronously in that case.
        close();
      }
    };

    udp.on("message", (message) => {
      if (current && current.readyState === current.OPEN) current.send(message, { binary: true });
    });
    udp.on("error", close);

    wss.on("connection", (ws) => {
      current = ws;
      ws.on("message", (data, isBinary) => {
        if (closed || !isBinary || data.length === 0 || data.length > MAX_DATAGRAM) return;
        if (!ready) {
          if (pending.length < 64) pending.push(Buffer.from(data));
          return;
        }
        send(data);
      });
      ws.on("close", close);
      ws.on("error", close);
    });

    udp.bind(0, () => {
      if (closed) {
        try { udp.close(); } catch {}
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      ready = true;
      for (const data of pending.splice(0)) send(data);
    });
  });

  return wss;
}
