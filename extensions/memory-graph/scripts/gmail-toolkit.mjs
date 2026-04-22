#!/usr/bin/env node
// Gmail Toolkit — MCP server.
//
// Exposes Gmail read tools + draft-create to MCP clients. Sending mail
// is NOT exposed here on purpose — drafts are non-destructive; actual
// send is the kind of action that should be done from Gmail itself
// after human review, or added later with the execution gate flipped
// to `assisted`.
//
// OAuth2 flow on first run: opens Joseph's default browser, receives
// callback on localhost, persists refresh token at
// `~/.openclaw/credentials/gmail.json` (owner-only). Access tokens
// are silently refreshed thereafter.
//
// Setup (one-time, ~5 min):
//   1. https://console.cloud.google.com → pick/create a project
//      (you likely already have one for your Gemini key — reuse it)
//   2. "APIs & Services" → "Library" → enable "Gmail API"
//   3. "APIs & Services" → "OAuth consent screen":
//        - User type: External
//        - Add your own Google account as a test user
//        - Scopes: /auth/gmail.readonly and /auth/gmail.compose
//   4. "APIs & Services" → "Credentials" → "Create Credentials" →
//      "OAuth client ID" → "Desktop app" (NOT web).
//      Copy the client_id + client_secret.
//   5. Paste into ~/.openclaw/agents/main/agent/auth-profiles.json
//      under `profiles["google-gmail:default"]`:
//        { "type": "api_key", "provider": "google-gmail",
//          "key": "<client_id>", "secret": "<client_secret>" }
//   6. Restart gateway. First tool call triggers browser consent.
//
// Tools:
//   gmail_list_messages(query?, limit?) — Gmail search syntax
//   gmail_get_message(id)               — headers + plaintext body
//   gmail_get_thread(id)                — full thread with all messages
//   gmail_labels_list()                 — all labels
//   gmail_draft_create(to, subject, body, cc?, bcc?) — creates a DRAFT,
//     never sends. Review + send via Gmail itself.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const HOME = homedir();
const AUTH_PROFILES_PATH = join(HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
const CREDENTIALS_PATH = join(HOME, ".openclaw", "credentials", "gmail.json");
const CALLBACK_PORT = 18792;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/gmail/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

// ---- credential load / persist -------------------------------------------

function loadAppCreds() {
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const data = JSON.parse(raw);
    const p = data?.profiles?.["google-gmail:default"];
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
    const d = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    return {
      accessToken: String(d.access_token ?? ""),
      refreshToken: String(d.refresh_token ?? ""),
      expiresAtMs: Number(d.expires_at_ms ?? 0),
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

// ---- OAuth --------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function runOAuthFlow(clientId, clientSecret) {
  const state = b64url(randomBytes(16));
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  const codePromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
        if (u.pathname !== "/gmail/callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = u.searchParams.get("code");
        const gotState = u.searchParams.get("state");
        if (!code || gotState !== state) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("gmail: missing code or state mismatch — close this tab");
          server.close();
          reject(new Error("oauth callback bad state"));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("gmail: auth complete — you can close this tab");
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

  spawn("/usr/bin/open", [authUrl.toString()], { stdio: "ignore" }).unref();
  const code = await codePromise;

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gmail token exchange ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const expiresAtMs = Date.now() + Number(data.expires_in ?? 3600) * 1000 - 60_000;
  const tokenState = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAtMs,
  };
  saveTokenState(tokenState);
  return tokenState;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gmail refresh ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const expiresAtMs = Date.now() + Number(data.expires_in ?? 3600) * 1000 - 60_000;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAtMs,
  };
}

// ---- Token orchestration + API helper -----------------------------------

let cachedToken = null;

async function ensureAccessToken() {
  const app = loadAppCreds();
  if (!app) {
    throw new Error(
      "gmail: no credentials at ~/.openclaw/agents/main/agent/auth-profiles.json profiles['google-gmail:default'] {key, secret}. See header comment for setup.",
    );
  }
  if (cachedToken && cachedToken.expiresAtMs > Date.now()) {
    return cachedToken.accessToken;
  }
  let stored = loadTokenState();
  if (!stored || !stored.refreshToken) {
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
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) {
        continue;
      }
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
  const text = await res.text().catch(() => "");
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    return { error: `gmail ${method} ${path} → ${res.status}`, body: parsed };
  }
  return parsed;
}

// ---- helpers -----------------------------------------------------------

function b64urlEncodeUtf8(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeB64UrlToString(b64) {
  if (!b64) {
    return "";
  }
  const pad = b64.length % 4;
  const normalized =
    b64.replace(/-/g, "+").replace(/_/g, "/") + (pad === 0 ? "" : "=".repeat(4 - pad));
  try {
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

// Walk Gmail's MIME-tree payload and pull the first text/plain body.
// Returns empty string when a message is pure attachments.
function extractPlainTextFromPayload(payload) {
  if (!payload) {
    return "";
  }
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeB64UrlToString(payload.body.data);
  }
  const parts = payload.parts ?? [];
  for (const p of parts) {
    if (p.mimeType === "text/plain" && p.body?.data) {
      return decodeB64UrlToString(p.body.data);
    }
  }
  for (const p of parts) {
    const nested = extractPlainTextFromPayload(p);
    if (nested) {
      return nested;
    }
  }
  // Last resort: fall back to the first text/html body stripped of tags.
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeB64UrlToString(payload.body.data)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  for (const p of parts) {
    if (p.mimeType === "text/html" && p.body?.data) {
      return decodeB64UrlToString(p.body.data)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return "";
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const h of headers ?? []) {
    if ((h.name ?? "").toLowerCase() === target) {
      return h.value ?? "";
    }
  }
  return "";
}

function summarizeMessage(msg) {
  const headers = msg?.payload?.headers ?? [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    cc: headerValue(headers, "Cc"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    snippet: msg.snippet ?? "",
    labelIds: msg.labelIds ?? [],
    internalDate: msg.internalDate ?? null,
  };
}

// ---- Tool implementations ----------------------------------------------

async function gmail_list_messages({ query, limit = 20 } = {}) {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? limit : 20;
  const r = await api("/messages", {
    query: { q: query, maxResults: Math.min(100, Math.max(1, normalizedLimit)) },
  });
  if (r?.error) {
    return r;
  }
  const ids = (r?.messages ?? []).map((m) => m.id);
  if (ids.length === 0) {
    return [];
  }
  // Fetch metadata for each (Gmail's list endpoint returns only IDs).
  // Keep this serial — parallel + token refresh during shared-promise
  // window has caused token-thrashing bugs in similar code.
  const out = [];
  for (const id of ids) {
    const m = await api(`/messages/${id}`, {
      query: { format: "metadata", metadataHeaders: "From,To,Cc,Subject,Date" },
    });
    if (m && !m.error) {
      out.push(summarizeMessage(m));
    }
  }
  return out;
}

async function gmail_get_message({ id } = {}) {
  if (!id) {
    return { error: "id required" };
  }
  const m = await api(`/messages/${id}`, { query: { format: "full" } });
  if (m?.error) {
    return m;
  }
  const summary = summarizeMessage(m);
  const body = extractPlainTextFromPayload(m.payload);
  return { ...summary, body };
}

async function gmail_get_thread({ id } = {}) {
  if (!id) {
    return { error: "id required" };
  }
  const t = await api(`/threads/${id}`, { query: { format: "full" } });
  if (t?.error) {
    return t;
  }
  const messages = [];
  for (const m of t.messages ?? []) {
    const s = summarizeMessage(m);
    s.body = extractPlainTextFromPayload(m.payload);
    messages.push(s);
  }
  return {
    id: t.id,
    historyId: t.historyId,
    messages,
  };
}

async function gmail_labels_list() {
  const r = await api("/labels");
  if (r?.error) {
    return r;
  }
  return (r?.labels ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    messagesTotal: l.messagesTotal,
    messagesUnread: l.messagesUnread,
  }));
}

async function gmail_draft_create({ to, subject, body, cc, bcc } = {}) {
  if (!to || !subject || !body) {
    return { error: "to, subject, body required" };
  }
  const lines = [`To: ${to}`, `Subject: ${subject}`];
  if (cc) {
    lines.push(`Cc: ${cc}`);
  }
  if (bcc) {
    lines.push(`Bcc: ${bcc}`);
  }
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("");
  lines.push(body);
  const raw = b64urlEncodeUtf8(lines.join("\r\n"));
  const r = await api("/drafts", {
    method: "POST",
    body: { message: { raw } },
  });
  if (r?.error) {
    return r;
  }
  return {
    draftId: r.id,
    messageId: r.message?.id,
    threadId: r.message?.threadId,
    to,
    subject,
    note: "Draft created in Gmail. Review and send from Gmail itself — this tool intentionally does NOT send.",
  };
}

// ---- MCP server ---------------------------------------------------------

const server = new Server(
  { name: "gmail-toolkit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const toolDefs = [
  {
    name: "gmail_list_messages",
    description:
      "Search or list Gmail messages using standard Gmail query syntax (e.g. 'from:alice@example.com newer_than:7d', 'is:unread label:inbox', 'subject:invoice'). Returns id/threadId/from/to/cc/subject/date/snippet/labelIds for up to `limit` results (default 20, max 100).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gmail_get_message",
    description:
      "Fetch full message details by id (from gmail_list_messages): headers + plaintext body (falls back to stripped HTML when no text/plain part).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_get_thread",
    description:
      "Fetch a full thread by id: all messages with headers + plaintext body, in Gmail's canonical order.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_labels_list",
    description:
      "List all Gmail labels (system + user) with message counts. Useful before composing a query that filters by a specific label name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gmail_draft_create",
    description:
      "Create a Gmail DRAFT. Does NOT send — drafts land in the Drafts folder for human review + manual send via Gmail. `to`, `subject`, `body` required; `cc`, `bcc` optional. Use this for any agent-generated outbound email; the human sends after reviewing.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", minLength: 1 },
        subject: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["to", "subject", "body"],
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
      case "gmail_list_messages":
        result = await gmail_list_messages(args);
        break;
      case "gmail_get_message":
        result = await gmail_get_message(args);
        break;
      case "gmail_get_thread":
        result = await gmail_get_thread(args);
        break;
      case "gmail_labels_list":
        result = await gmail_labels_list();
        break;
      case "gmail_draft_create":
        result = await gmail_draft_create(args);
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
