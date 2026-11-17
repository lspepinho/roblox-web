export function basicCredentials(req, realm) {
  const value = req.headers.authorization || "";
  if (!/^Basic /i.test(value)) return null;
  try {
    const decoded = Buffer.from(value.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function basicChallenge(res, realm) {
  res.writeHead(401, {
    "www-authenticate": `Basic realm="${realm}", charset="UTF-8"`,
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required");
}
