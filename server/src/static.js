import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SITE = path.join(REPO, "apps", "site");
const IWA = path.join(REPO, "apps", "iwa");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const HEADERS = {
  "content-security-policy":
    "base-uri 'self' http: https:; default-src 'self'; object-src 'none'; frame-src 'self' https: blob: data:; " +
    "connect-src 'self' https: wss: blob: data:; script-src 'self' 'wasm-unsafe-eval'; " +
    "img-src 'self' https: blob: data:; media-src 'self' https: blob: data:; " +
    "font-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
    "require-trusted-types-for 'script'; frame-ancestors 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function fileFor(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const rel = decoded === "/" ? "home.html" : decoded.replace(/^\/+/, "");
  const candidates = decoded.startsWith("/engine/")
    ? [path.join(IWA, rel)]
    : [path.join(SITE, rel), path.join(IWA, rel)];
  for (const root of [SITE, IWA]) {
    for (const candidate of candidates) {
      if (candidate !== path.join(root, rel)) continue;
      if (!candidate.startsWith(root + path.sep)) continue;
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return { path: candidate, size: stat.size };
      } catch {}
    }
  }
  return null;
}

export function serveStatic(req, res, urlPath) {
  const file = fileFor(urlPath);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const headers = { ...HEADERS };
  // The unified home allows the login iframe without COEP, but keeps COOP so
  // its relationship with the about:blank client survives launcher navigation.
  if (urlPath === "/") {
    delete headers["cross-origin-embedder-policy"];
  } else if (urlPath === "/roblox-login.html") {
    delete headers["cross-origin-opener-policy"];
    delete headers["cross-origin-embedder-policy"];
  }
  res.writeHead(200, {
    ...headers,
    "content-type": TYPES[path.extname(file.path).toLowerCase()] || "application/octet-stream",
    "content-length": file.size,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file.path);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
