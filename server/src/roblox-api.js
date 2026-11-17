import { randomUUID } from "node:crypto";
import { b64ToBytes, bytesToB64, isRobloxUrl } from "./http.js";

const GAMEJOIN = "https://gamejoin.roblox.com/v1/join-game";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cookieHeader(session) {
  const value = String(session.robloxCookie || "").trim();
  if (!value) return "";
  return value.includes("=") ? value : `.ROBLOSECURITY=${value}`;
}

async function robloxFetch(session, url, init = {}, native = false) {
  const headers = {};
  for (const [key, value] of Object.entries(init.headers || {})) {
    if (!/^(cookie|authorization|host|content-length)$/i.test(key)) headers[key] = value;
  }
  const cookie = cookieHeader(session);
  if (cookie) headers.Cookie = cookie;
  if (native) {
    headers["User-Agent"] = "Roblox/WinInet";
    headers.Requester = "Client";
  }
  let body = init.body;
  if (init.bodyB64) body = b64ToBytes(init.bodyB64);
  return fetch(url, {
    method: init.method || "GET",
    headers,
    body,
    redirect: "manual",
  });
}

export async function requestRoblox(session, url, init = {}) {
  if (!isRobloxUrl(url)) {
    const error = new Error("Roblox URL is not allowed");
    error.statusCode = 400;
    throw error;
  }
  const response = await robloxFetch(session, url, init);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    url: response.url || url,
    headers: Object.fromEntries(response.headers.entries()),
    body: bytesToB64(bytes),
  };
}

export async function joinNative(session, placeId, selection = {}) {
  const place = Number(placeId);
  if (!Number.isSafeInteger(place) || place <= 0) {
    const error = new Error("invalid placeId");
    error.statusCode = 400;
    throw error;
  }
  if (!cookieHeader(session)) {
    const error = new Error("a Roblox session cookie is required");
    error.statusCode = 401;
    throw error;
  }

  const selected = {};
  if (selection.jobId) selected.gameInstanceId = String(selection.jobId);
  if (selection.accessCode) selected.accessCode = String(selection.accessCode);
  if (selection.linkCode) selected.privateServerLinkCode = String(selection.linkCode);

  const post = async (jobId) => {
    const response = await robloxFetch(session, GAMEJOIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        placeId: place,
        isTeleport: false,
        gameJoinAttemptId: randomUUID(),
        browserTrackerId: 0,
        playSessionId: randomUUID(),
        eventId: randomUUID(),
        launchData: "",
        joinAttemptOrigin: "PlayButton",
        ...selected,
        ...(jobId ? { jobId } : {}),
      }),
    }, true);
    return response.json();
  };

  let reply = await post(null);
  let tries = 0;
  while (reply.status === 0 && tries++ < 25) {
    await sleep(400);
    reply = await post(null);
  }
  if (reply.status !== 2) {
    const error = new Error(`join status ${reply.status} ${reply.message || ""}`);
    error.statusCode = 502;
    throw error;
  }

  let script = reply.joinScript;
  let carrier = reply;
  if (!script || typeof script !== "object") {
    const again = await post(reply.jobId);
    if (again.joinScript && typeof again.joinScript === "object") {
      script = again.joinScript;
      carrier = again;
    }
  }
  if (!script || typeof script !== "object") {
    const error = new Error("join script missing");
    error.statusCode = 502;
    throw error;
  }

  const udmux = (script.UdmuxEndpoints || [])[0] || null;
  const connections = script.ServerConnections || null;
  return {
    reply: carrier,
    requestedJobId: selected.gameInstanceId || null,
    jobId: reply.jobId,
    tries,
    userId: script.UserId,
    userName: script.UserName,
    machine: script.MachineAddress,
    serverPort: script.ServerPort,
    udmux,
    connections,
    token: script.TokenValue,
    pepper: script.PepperId,
    clientTicket: script.ClientTicket,
    gameId: script.GameId,
    placeId: script.PlaceId,
    script,
  };
}
