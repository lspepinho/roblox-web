export function json(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function text(res, status, value) {
  const body = Buffer.from(String(value));
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": body.length });
  res.end(body);
}

export async function readJson(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

export function bearer(req) {
  const value = req.headers.authorization || "";
  return /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(value)?.[1] || null;
}

export function clientIp(req) {
  // Render terminates TLS and supplies X-Forwarded-For. Only the first address
  // is used for the in-memory login rate limiter.
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 80);
}

export function isRobloxUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.href.length > 4096) return false;
    return url.hostname === "roblox.com" || url.hostname.endsWith(".roblox.com");
  } catch {
    return false;
  }
}

export function bytesToB64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function b64ToBytes(value) {
  if (!value) return new Uint8Array(0);
  const out = Buffer.from(String(value), "base64");
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
