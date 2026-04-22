#!/usr/bin/env node
// Spotify Toolkit — MCP server.
//
// Exposes Spotify Web API tools (now playing, play/pause, search, queue,
// playlists) to MCP clients. Handles PKCE OAuth automatically on first
// run — opens Joseph's default browser, receives the callback on
// localhost, persists the refresh token at
// `~/.openclaw/credentials/spotify.json` (owner-only). Subsequent runs
// silently refresh the access token.
//
// Setup (one-time, ~2 min):
//   1. https://developer.spotify.com/dashboard → Create app
//   2. Redirect URI: http://127.0.0.1:18790/spotify/callback
//   3. Paste client_id + client_secret into
//      ~/.openclaw/agents/main/agent/auth-profiles.json under
//      `profiles["spotify:default"]`:
//        { "type": "api_key", "provider": "spotify",
//          "key": "<client_id>", "secret": "<client_secret>" }
//   4. Restart gateway. First tool call triggers browser OAuth.
//
// Tools:
//   spotify_now_playing()            — title / artist / album / progress
//   spotify_play(uri?, deviceId?)    — resume, or play a spotify URI
//   spotify_pause(deviceId?)
//   spotify_next(deviceId?) / spotify_prev(deviceId?)
//   spotify_search(query, type?, limit?)  — tracks/albums/artists/playlists
//   spotify_queue_add(uri)
//   spotify_recent(limit?)           — recently played tracks
//   spotify_devices()                — active playback devices
//   spotify_volume(percent, deviceId?)

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HOME = homedir();
const AUTH_PROFILES_PATH = join(HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
const CREDENTIALS_PATH = join(HOME, ".openclaw", "credentials", "spotify.json");
const CALLBACK_PORT = 18790;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/spotify/callback`;
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-read-private",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

// ---- credential load / persist -------------------------------------------

function loadAppCreds() {
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const data = JSON.parse(raw);
    const p = data?.profiles?.["spotify:default"];
    if (!p || typeof p.key !== "string" || typeof p.secret !== "string") {
      return null;
    }
    return { clientId: p.key, clientSecret: p.secret };
  } catch {
    return null;
  }
}

function loadTokenState() {
  if (!existsSync(CREDENTIALS_PATH)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    return {
      accessToken: String(data.access_token ?? ""),
      refreshToken: String(data.refresh_token ?? ""),
      expiresAtMs: Number(data.expires_at_ms ?? 0),
      tokenType: String(data.token_type ?? "Bearer"),
    };
  } catch {
    return null;
  }
}

function saveTokenState(state) {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify(
      {
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        expires_at_ms: state.expiresAtMs,
        token_type: state.tokenType,
        saved_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  try {
    chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    // best-effort
  }
}

// ---- OAuth: PKCE flow via localhost callback -----------------------------

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function newPkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function runOAuthFlow(clientId, clientSecret) {
  const { verifier, challenge } = newPkcePair();
  const state = b64url(randomBytes(16));
  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("state", state);

  const codePromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
        if (u.pathname !== "/spotify/callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = u.searchParams.get("code");
        const gotState = u.searchParams.get("state");
        if (!code || gotState !== state) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("spotify: missing code or state mismatch — close this tab");
          server.close();
          reject(new Error("oauth callback bad state"));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("spotify: auth complete — you can close this tab");
        server.close();
        resolve(code);
      } catch (err) {
        res.writeHead(500);
        res.end();
        server.close();
        reject(err);
      }
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(
      () => {
        server.close();
        reject(new Error("oauth timed out waiting for callback"));
      },
      5 * 60 * 1000,
    );
  });

  // Open the browser so the user can consent. Non-blocking.
  spawn("/usr/bin/open", [authUrl.toString()], { stdio: "ignore" }).unref();

  const code = await codePromise;

  // Exchange code → tokens
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`spotify token exchange ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const expiresAtMs = Date.now() + Number(data.expires_in ?? 3600) * 1000 - 60_000;
  const tokenState = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAtMs,
    tokenType: data.token_type ?? "Bearer",
  };
  saveTokenState(tokenState);
  return tokenState;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`spotify refresh ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const expiresAtMs = Date.now() + Number(data.expires_in ?? 3600) * 1000 - 60_000;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAtMs,
    tokenType: data.token_type ?? "Bearer",
  };
}

// ---- Token orchestration -------------------------------------------------

let cachedToken = null;

async function ensureAccessToken() {
  const app = loadAppCreds();
  if (!app) {
    throw new Error(
      "spotify: no credentials at ~/.openclaw/agents/main/agent/auth-profiles.json profiles['spotify:default'] {key, secret}. See header comment for setup.",
    );
  }
  if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
    return cachedToken.accessToken;
  }
  let stored = loadTokenState();
  if (!stored || !stored.refreshToken) {
    // First run — need consent via browser.
    stored = await runOAuthFlow(app.clientId, app.clientSecret);
  } else if (stored.expiresAtMs <= Date.now()) {
    stored = await refreshAccessToken(stored.refreshToken, app.clientId, app.clientSecret);
    saveTokenState(stored);
  }
  cachedToken = stored;
  return stored.accessToken;
}

async function api(path, { method = "GET", body, query } = {}) {
  const token = await ensureAccessToken();
  const url = new URL(`https://api.spotify.com/v1${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) {
        continue;
      }
      // Narrow the type explicitly: Spotify query params are only ever
      // string | number | boolean. Anything else is a caller bug.
      const rendered =
        typeof v === "string"
          ? v
          : typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v);
      url.searchParams.set(k, rendered);
    }
  }
  const init = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  };
  const res = await fetch(url.toString(), init);
  if (res.status === 204) {
    return { ok: true };
  }
  const text = await res.text().catch(() => "");
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    return { error: `spotify ${method} ${path} → ${res.status}`, body: parsed };
  }
  return parsed;
}

// ---- Tool implementations ------------------------------------------------

async function spotify_now_playing() {
  const r = await api("/me/player/currently-playing");
  if (!r || r.error) {
    return r ?? { error: "unknown" };
  }
  if (!r.item) {
    return { playing: false };
  }
  const item = r.item;
  return {
    playing: r.is_playing === true,
    title: item.name,
    artist: (item.artists ?? []).map((a) => a.name).join(", "),
    album: item.album?.name ?? null,
    progressMs: r.progress_ms ?? null,
    durationMs: item.duration_ms ?? null,
    uri: item.uri,
    url: item.external_urls?.spotify ?? null,
  };
}

async function spotify_play({ uri, deviceId } = {}) {
  const path = "/me/player/play";
  const query = deviceId ? { device_id: deviceId } : undefined;
  const body = uri ? { uris: Array.isArray(uri) ? uri : [uri] } : undefined;
  return api(path, { method: "PUT", body, query });
}

async function spotify_pause({ deviceId } = {}) {
  return api("/me/player/pause", {
    method: "PUT",
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

async function spotify_next({ deviceId } = {}) {
  return api("/me/player/next", {
    method: "POST",
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

async function spotify_prev({ deviceId } = {}) {
  return api("/me/player/previous", {
    method: "POST",
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

async function spotify_search({ query, type = "track", limit = 10 } = {}) {
  if (!query) {
    return { error: "query required" };
  }
  const r = await api("/search", { query: { q: query, type, limit } });
  if (r?.error) {
    return r;
  }
  const key = `${type}s`;
  const items = r?.[key]?.items ?? [];
  return items.map((it) => ({
    uri: it.uri,
    name: it.name,
    type,
    artist: (it.artists ?? []).map((a) => a.name).join(", "),
    album: it.album?.name ?? null,
    url: it.external_urls?.spotify ?? null,
  }));
}

async function spotify_queue_add({ uri } = {}) {
  if (!uri) {
    return { error: "uri required" };
  }
  return api("/me/player/queue", {
    method: "POST",
    query: { uri },
  });
}

async function spotify_recent({ limit = 10 } = {}) {
  const r = await api("/me/player/recently-played", { query: { limit } });
  if (r?.error) {
    return r;
  }
  return (r?.items ?? []).map((x) => ({
    playedAt: x.played_at,
    title: x.track?.name,
    artist: (x.track?.artists ?? []).map((a) => a.name).join(", "),
    uri: x.track?.uri,
  }));
}

async function spotify_devices() {
  const r = await api("/me/player/devices");
  if (r?.error) {
    return r;
  }
  return (r?.devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    isActive: d.is_active,
    volumePercent: d.volume_percent,
  }));
}

async function spotify_volume({ percent, deviceId } = {}) {
  if (!Number.isFinite(percent)) {
    return { error: "percent required (0-100)" };
  }
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return api("/me/player/volume", {
    method: "PUT",
    query: { volume_percent: p, ...(deviceId ? { device_id: deviceId } : {}) },
  });
}

// ---- MCP server ---------------------------------------------------------

const server = new Server(
  { name: "spotify-toolkit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const toolDefs = [
  {
    name: "spotify_now_playing",
    description:
      "Current track on the operator's Spotify: title, artist, album, progress, playing state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "spotify_play",
    description:
      "Resume playback, or play a specific URI (spotify:track:... / spotify:album:... / spotify:playlist:...). `uri` can be a single string or an array.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        deviceId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spotify_pause",
    description: "Pause playback on the active device (or a specific device).",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spotify_next",
    description: "Skip to the next track.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spotify_prev",
    description: "Skip to the previous track.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "spotify_search",
    description: "Search Spotify for tracks/albums/artists/playlists.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        type: { type: "string", enum: ["track", "album", "artist", "playlist"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "spotify_queue_add",
    description: "Queue a URI onto the active playback device.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", minLength: 1 } },
      required: ["uri"],
      additionalProperties: false,
    },
  },
  {
    name: "spotify_recent",
    description: "Recently played tracks (most recent first).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: "spotify_devices",
    description: "List playback devices the Spotify account currently sees as available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "spotify_volume",
    description: "Set volume (0-100) on the active device (or a specific one).",
    inputSchema: {
      type: "object",
      properties: {
        percent: { type: "integer", minimum: 0, maximum: 100 },
        deviceId: { type: "string" },
      },
      required: ["percent"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result;
  try {
    switch (name) {
      case "spotify_now_playing":
        result = await spotify_now_playing();
        break;
      case "spotify_play":
        result = await spotify_play(args);
        break;
      case "spotify_pause":
        result = await spotify_pause(args);
        break;
      case "spotify_next":
        result = await spotify_next(args);
        break;
      case "spotify_prev":
        result = await spotify_prev(args);
        break;
      case "spotify_search":
        result = await spotify_search(args);
        break;
      case "spotify_queue_add":
        result = await spotify_queue_add(args);
        break;
      case "spotify_recent":
        result = await spotify_recent(args);
        break;
      case "spotify_devices":
        result = await spotify_devices();
        break;
      case "spotify_volume":
        result = await spotify_volume(args);
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
