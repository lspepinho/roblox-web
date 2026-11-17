const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail !== undefined ? " -> " + JSON.stringify(detail) : ""));
  if (!ok) failures++;
}

for (const file of [
  "apps/site/index.html",
  "apps/site/home.html",
  "apps/site/launch.html",
  "apps/site/launch.js",
  "apps/site/client-launch.js",
  "apps/site/blank-writer.js",
  "apps/site/site-app.js",
  "apps/site/site-auth.js",
  "apps/site/transport-websocket.js",
  "apps/site/roblox-login.html",
  "apps/site/roblox-login.js",
  "apps/iwa/index.html",
  "apps/iwa/rbx-net.js",
  "apps/iwa/ring.js",
  "apps/iwa/fflags.json",
  "apps/iwa/engine/WebClient.wasm",
  "apps/iwa/engine/WebClient.js",
  "apps/iwa/engine/WasmPlayer.js",
  "apps/iwa/engine/WebClient.metadata.json",
  "server/src/index.js",
  "render.yaml",
]) {
  check(file, fs.statSync(path.join(root, file)).size > 0);
}

for (const file of [
  "apps/site/launch.js",
  "apps/site/client-launch.js",
  "apps/site/blank-writer.js",
  "apps/site/site-app.js",
  "apps/site/site-auth.js",
  "apps/site/transport-websocket.js",
  "apps/site/roblox-login.js",
  "apps/iwa/ring.js",
  "apps/iwa/rbx-net.js",
  "apps/iwa/engine/WebClient.js",
  "apps/iwa/engine/WasmPlayer.js",
]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  check(`syntax ${file}`, result.status === 0, result.stderr || undefined);
}

const metadata = JSON.parse(fs.readFileSync(path.join(root, "apps/iwa/engine/WebClient.metadata.json"), "utf8"));
const missing = [];
const wrongSize = [];
for (const entry of metadata) {
  const file = path.join(root, "apps/iwa/engine", ...entry.path.slice(1).split("/"));
  if (!fs.existsSync(file)) missing.push(entry.path);
  else if (fs.statSync(file).size !== entry.size) wrongSize.push(entry.path);
}
check("all metadata assets are present", missing.length === 0, missing.slice(0, 5));
check("all asset sizes are exact", wrongSize.length === 0, wrongSize.slice(0, 5));
check("patched engine has the expected size", fs.statSync(path.join(root, "apps/iwa/engine/WebClient.wasm")).size === 101882095);

const ring = fs.readFileSync(path.join(root, "apps/iwa/ring.js"), "utf8");
check("ring supports both socket transports", ring.includes("__webloxSocketFactory") && ring.includes("UDPSocket"));
const launch = fs.readFileSync(path.join(root, "apps/site/client-launch.js"), "utf8");
check("about:blank supports initial launch and same-tab join", launch.includes("__webloxOpenClient") && launch.includes("__webloxRewriteClient"));
check("about:blank controller accepts only the service origin", launch.includes("event.origin !== origin"));
const launcherSource = fs.readFileSync(path.join(root, "apps/site/launch.js"), "utf8");
check("launcher waits for the client and keeps a working fallback", launcherSource.includes("weblox-client-ready") && launcherSource.includes("document.body.append("));
const writer = fs.readFileSync(path.join(root, "apps/site/blank-writer.js"), "utf8");
check("about:blank writer downloads and writes the full client", writer.includes("/index.html") && writer.includes("document.write"));
const home = fs.readFileSync(path.join(root, "apps/site/home.html"), "utf8");
check("root unifies iframe, manual cookie and Place ID", home.includes("roblox-login-panel") && home.includes("roblox-cookie") && home.includes("join-form"));
const serverSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
check("origin bootstrap has one route", (serverSource.match(/url\.pathname === "\/origin\.js"/g) || []).length === 1);
const auth = fs.readFileSync(path.join(root, "apps/site/site-auth.js"), "utf8");
check("Roblox cookie is not persisted by the client", !auth.includes("localStorage.setItem"));
check("expired sessions return to root login", auth.includes("sessionExpired") && auth.includes('url.searchParams.set("login", "1")'));
const render = fs.readFileSync(path.join(root, "render.yaml"), "utf8");
check("Render has health check", render.includes("healthCheckPath: /health"));

console.log(failures ? `\n${failures} FAILED` : "\nall harnesses passed");
process.exit(failures ? 1 : 0);
