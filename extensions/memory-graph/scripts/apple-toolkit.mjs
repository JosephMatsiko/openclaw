#!/usr/bin/env node
// Apple Toolkit — Mac-native MCP server.
//
// Exposes Reminders, Messages, Safari/Chrome, and system notifications to
// any MCP client (Claude Code, Claude Desktop, and OpenClaw's main agent
// when mounted via `mcp.servers.apple-toolkit`).
//
// Runs entirely via `osascript` (AppleScript / JavaScript for Automation),
// so no API keys are required. First call to each app triggers a native
// "allow automation" dialog; once granted, subsequent calls are silent.
//
// Trust surface: these tools run on behalf of the logged-in user and
// inherit the user's access. When mounted into OpenClaw's agent, an
// approved Telegram sender can (via prompt) push the agent to send
// iMessages, add reminders, open URLs. Keep the execution gate in
// `assisted` mode if you want a human-in-the-loop on message send.
//
// Tools:
//   reminders_add(title, list?, notes?, dueISO?)
//   reminders_list(list?, limit?)
//   reminders_complete(id)
//   messages_send(to, text)           — iMessage via Messages.app
//   messages_list_chats(limit?)       — recent iMessage/SMS conversations
//   messages_thread(chatId, limit?)   — messages in a conversation
//   messages_search(query, limit?)    — full-text search across all messages
//   system_notification(title, body?) — native macOS banner
//   open_url(url, browser?)           — default browser or specific one
//   mac_app_open(app)                 — open a named .app
//
// Messages SQLite queries require Full Disk Access for the node binary
// running this toolkit. Grant once in
// System Settings → Privacy & Security → Full Disk Access → + node.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Messages chat.db — Apple's iMessage/SMS store. Kept in sync by macOS.
// Schema: message(ROWID, text, date, is_from_me, handle_id, service),
// chat(ROWID, chat_identifier, display_name), handle(ROWID, id),
// plus chat_message_join / chat_handle_join for M:M.
//
// date column is nanoseconds since 2001-01-01 UTC (Cocoa epoch).
// Conversion to JS date: (date / 1e9 + 978307200) * 1000 → ms.
const CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const COCOA_EPOCH_OFFSET_SECONDS = 978307200;

// Read-only handle to chat.db. Opened per-call to avoid holding a file
// lock while macOS rewrites the DB in-place for incoming messages.
// Returns null if FDA hasn't been granted (caller reports a friendly error).
function openChatDb() {
  if (!existsSync(CHAT_DB_PATH)) {
    return { ok: false, reason: "chat.db missing — Messages.app may not be set up" };
  }
  try {
    const db = new DatabaseSync(CHAT_DB_PATH, { readOnly: true });
    return { ok: true, db };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: msg.includes("authorization")
        ? "Full Disk Access not granted for this node binary. Add it in System Settings → Privacy & Security → Full Disk Access."
        : msg,
    };
  }
}

// Format a chat.db nanosecond timestamp as ISO. Modern rows are ns-since-2001
// Cocoa epoch; legacy rows (pre-macOS 10.13) are seconds-since-2001. node:sqlite
// returns values >2^53 as BigInt, so divide first to stay in a safe integer
// range before the Number() cast.
function chatDbDateToIso(ns) {
  if (ns === null || ns === undefined) {
    return null;
  }
  let seconds;
  if (typeof ns === "bigint") {
    // Heuristic: post-macOS 10.13 values are in nanoseconds (> 1e15 in the
    // typical range). Divide by 1e9 BigInt-first so precision holds.
    seconds = ns > 1_000_000_000_000_000n ? Number(ns / 1_000_000_000n) : Number(ns);
  } else {
    const n = Number(ns);
    if (!Number.isFinite(n) || n <= 0) {
      return null;
    }
    seconds = n > 1e15 ? n / 1e9 : n;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const ms = (seconds + COCOA_EPOCH_OFFSET_SECONDS) * 1000;
  return new Date(ms).toISOString();
}

// ---- osascript runner ------------------------------------------------------

// Spawns /usr/bin/osascript with a timeout. Returns { ok, stdout, stderr }.
// We prefer JXA (-l JavaScript) for anything structured because its JSON
// output is more reliable than AppleScript's string coercions, and fall
// back to plain -e AppleScript for simple one-liners.
function runOsascript(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, stdout, stderr: stderr || `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: err?.message ?? String(err) });
    });
  });
}

function jxa(script, opts = {}) {
  return runOsascript(["-l", "JavaScript", "-e", script], opts);
}

function applescript(script, opts = {}) {
  return runOsascript(["-e", script], opts);
}

function sanitizeJxaString(s) {
  // Just escape backslash + double-quote; everything else survives
  // JS-in-a-shell because we pass script via argv, not shell.
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---- Reminders ------------------------------------------------------------

async function reminders_add({ title, list, notes, dueISO }) {
  const titleEsc = sanitizeJxaString(title);
  const listPick = list
    ? `const tgt = app.lists.whose({ name: "${sanitizeJxaString(list)}" })[0];`
    : `const tgt = app.defaultList();`;
  const props = [`name: "${titleEsc}"`];
  if (notes) {
    props.push(`body: "${sanitizeJxaString(notes)}"`);
  }
  if (dueISO) {
    // JXA can parse ISO via new Date()
    props.push(`dueDate: new Date("${sanitizeJxaString(dueISO)}")`);
  }
  const script = `
    const app = Application("Reminders");
    app.includeStandardAdditions = true;
    ${listPick}
    if (!tgt) throw new Error("list not found");
    const r = app.Reminder({ ${props.join(", ")} });
    tgt.reminders.push(r);
    JSON.stringify({ id: r.id(), name: r.name(), list: tgt.name() });
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function reminders_list({ list, limit = 20 } = {}) {
  const listFilter = list
    ? `const lists = app.lists.whose({ name: "${sanitizeJxaString(list)}" });`
    : `const lists = app.lists();`;
  const script = `
    const app = Application("Reminders");
    ${listFilter}
    const out = [];
    const cap = ${Number.isFinite(limit) && limit > 0 ? limit : 20};
    for (const l of lists) {
      const items = l.reminders.whose({ completed: false })();
      for (const r of items) {
        if (out.length >= cap) break;
        out.push({
          id: r.id(),
          name: r.name(),
          list: l.name(),
          body: r.body() || null,
          dueDate: (function() { try { const d = r.dueDate(); return d ? d.toISOString() : null; } catch { return null; } })(),
          priority: r.priority(),
        });
      }
      if (out.length >= cap) break;
    }
    JSON.stringify(out);
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

// ---- Calendar (Calendar.app via JXA) -------------------------------------

async function calendar_list_calendars() {
  const script = `
    const app = Application("Calendar");
    const out = [];
    for (const c of app.calendars()) {
      out.push({ name: c.name(), writable: c.writable() });
    }
    JSON.stringify(out);
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function calendar_events_range({ startISO, endISO, calendar, limit = 100 } = {}) {
  if (!startISO || !endISO) {
    return { error: "startISO and endISO required" };
  }
  const calFilter = calendar
    ? `const cals = app.calendars.whose({ name: "${sanitizeJxaString(calendar)}" });`
    : `const cals = app.calendars();`;
  const script = `
    const app = Application("Calendar");
    const startD = new Date("${sanitizeJxaString(startISO)}");
    const endD = new Date("${sanitizeJxaString(endISO)}");
    ${calFilter}
    const out = [];
    const cap = ${Number.isFinite(limit) && limit > 0 ? limit : 100};
    for (const c of cals) {
      for (const e of c.events()) {
        const sd = e.startDate();
        const ed = e.endDate();
        if (!sd || sd < startD || sd >= endD) continue;
        out.push({
          uid: e.uid(),
          summary: e.summary(),
          location: e.location() || null,
          startDate: sd ? sd.toISOString() : null,
          endDate: ed ? ed.toISOString() : null,
          calendar: c.name(),
          allDay: e.alldayEvent(),
        });
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    }
    out.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
    JSON.stringify(out);
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function calendar_events_today({ calendar } = {}) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  return calendar_events_range({ startISO: start, endISO: end, calendar });
}

// ---- Apple Notes ---------------------------------------------------------

async function notes_search({ query, limit = 20, deep = false } = {}) {
  if (!query || !String(query).trim()) {
    return { error: "query required" };
  }
  const q = sanitizeJxaString(String(query).toLowerCase());
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 20;
  // Two modes. Fast (default): name-only scan — ~1s on 515 notes.
  // Deep: iterate plaintext too — slower but catches body-only matches.
  const script = `
    const app = Application("Notes");
    const hits = [];
    const q = "${q}";
    const cap = ${cap};
    const deep = ${deep ? "true" : "false"};
    // Pass 1: name scan — always cheap.
    for (const n of app.notes()) {
      try {
        const name = (n.name() || "").toLowerCase();
        if (name.includes(q)) {
          hits.push({ id: n.id(), matchedOn: "name" });
        }
      } catch {}
      if (hits.length >= cap) break;
    }
    // Pass 2: body scan, if requested AND we have room.
    if (deep && hits.length < cap) {
      const seen = new Set(hits.map(h => h.id));
      for (const n of app.notes()) {
        if (hits.length >= cap) break;
        try {
          if (seen.has(n.id())) continue;
          const body = (n.plaintext() || "").toLowerCase();
          if (body.includes(q)) {
            hits.push({ id: n.id(), matchedOn: "body" });
          }
        } catch {}
      }
    }
    // Hydrate top-N with preview + metadata.
    const out = [];
    for (const h of hits) {
      try {
        const n = app.notes.byId(h.id);
        out.push({
          id: h.id,
          name: n.name(),
          matchedOn: h.matchedOn,
          preview: (n.plaintext() || "").slice(0, 240),
          modificationDate: (function() { try { const d = n.modificationDate(); return d ? d.toISOString() : null; } catch { return null; } })(),
          folder: (function() { try { return n.container().name(); } catch { return null; } })(),
        });
      } catch {}
    }
    JSON.stringify(out);
  `;
  const res = await jxa(script, { timeoutMs: deep ? 90000 : 20000 });
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function notes_list_recent({ limit = 10 } = {}) {
  // Two-pass. Pass 1: lightweight (id + name + modificationDate) across
  // ALL notes — plaintext is the slow part, so skip it here. Pass 2: for
  // the top N after sort, fetch plaintext for the preview. 515 notes
  // scanned metadata-only in JXA runs in ~1-2s.
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 10;
  const script = `
    const app = Application("Notes");
    const meta = [];
    for (const n of app.notes()) {
      try {
        let mod = null;
        try { const d = n.modificationDate(); if (d) mod = d.toISOString(); } catch {}
        meta.push({ id: n.id(), name: n.name(), modificationDate: mod });
      } catch {}
    }
    meta.sort((a, b) => (b.modificationDate ?? "").localeCompare(a.modificationDate ?? ""));
    const top = meta.slice(0, ${cap});
    const out = [];
    for (const m of top) {
      try {
        const n = app.notes.byId(m.id);
        out.push({
          id: m.id,
          name: m.name,
          preview: (n.plaintext() || "").slice(0, 160),
          modificationDate: m.modificationDate,
          folder: (function() { try { return n.container().name(); } catch { return null; } })(),
        });
      } catch {
        out.push({ ...m, preview: null, folder: null });
      }
    }
    JSON.stringify(out);
  `;
  const res = await jxa(script, { timeoutMs: 60000 });
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function notes_get({ id, name } = {}) {
  if (!id && !name) {
    return { error: "id or name required" };
  }
  const lookup = id
    ? `const n = app.notes.byId("${sanitizeJxaString(id)}");`
    : `const n = app.notes.whose({ name: "${sanitizeJxaString(name)}" })[0];`;
  const script = `
    const app = Application("Notes");
    ${lookup}
    if (!n) throw new Error("not found");
    JSON.stringify({
      id: n.id(),
      name: n.name(),
      body: n.plaintext() || "",
      modificationDate: (function() { try { const d = n.modificationDate(); return d ? d.toISOString() : null; } catch { return null; } })(),
      folder: (function() { try { return n.container().name(); } catch { return null; } })(),
    });
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function notes_create({ title, body = "", folder } = {}) {
  if (!title) {
    return { error: "title required" };
  }
  const folderPick = folder
    ? `const f = app.folders.whose({ name: "${sanitizeJxaString(folder)}" })[0]; if (!f) throw new Error("folder not found");`
    : `const f = app.defaultAccount().defaultFolder();`;
  const script = `
    const app = Application("Notes");
    ${folderPick}
    const html = "<h1>" + ${JSON.stringify(title)} + "</h1><p>" + ${JSON.stringify(body)} + "</p>";
    const n = app.Note({ name: ${JSON.stringify(title)}, body: html });
    f.notes.push(n);
    JSON.stringify({ id: n.id(), name: n.name(), folder: f.name() });
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

async function reminders_complete({ id }) {
  const script = `
    const app = Application("Reminders");
    const r = app.reminders.byId("${sanitizeJxaString(id)}");
    if (!r) throw new Error("not found");
    r.completed = true;
    JSON.stringify({ id: r.id(), name: r.name(), completed: true });
  `;
  const res = await jxa(script);
  if (!res.ok) {
    return { error: res.stderr || "osascript failed" };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

// ---- Messages (iMessage) --------------------------------------------------

async function messages_send({ to, text }) {
  // Using AppleScript — the Messages JXA surface is finicky about
  // buddies vs chats. The classic AppleScript send-to-buddy is stable.
  const toEsc = String(to).replace(/"/g, '\\"');
  const textEsc = String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "Messages"
  set svc to 1st service whose service type = iMessage
  set buddy to buddy "${toEsc}" of svc
  send "${textEsc}" to buddy
end tell
"sent"
`;
  const res = await applescript(script);
  if (!res.ok) {
    return { ok: false, error: res.stderr || "osascript failed" };
  }
  return { ok: true, to, chars: text.length };
}

async function messages_list_chats({ limit } = {}) {
  const opened = openChatDb();
  if (!opened.ok) {
    return { ok: false, error: opened.reason };
  }
  const n = Number.isFinite(limit) && Number(limit) > 0 ? Math.min(200, Number(limit)) : 25;
  try {
    // One row per chat: latest message + timestamp + counterparty handle(s).
    // The LEFT JOIN on handle resolves the other-side phone/email; group by
    // chat so multi-person chats collapse to their display_name.
    const stmt = opened.db.prepare(
      `SELECT
         c.ROWID            AS chatId,
         c.chat_identifier  AS chatIdentifier,
         c.display_name     AS displayName,
         c.service_name     AS service,
         m.text             AS lastText,
         m.date             AS lastDate,
         m.is_from_me       AS lastFromMe,
         (SELECT GROUP_CONCAT(h.id, ', ')
            FROM handle h
            JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
           WHERE chj.chat_id = c.ROWID) AS handles,
         (SELECT COUNT(*) FROM chat_message_join cmj WHERE cmj.chat_id = c.ROWID) AS msgCount
       FROM chat c
       LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
       LEFT JOIN message m ON m.ROWID = cmj.message_id
       WHERE m.ROWID = (
         SELECT m2.ROWID
           FROM message m2
           JOIN chat_message_join cmj2 ON cmj2.message_id = m2.ROWID
          WHERE cmj2.chat_id = c.ROWID
          ORDER BY m2.date DESC
          LIMIT 1
       )
       ORDER BY m.date DESC
       LIMIT ?`,
    );
    // chat.db date column is ns-since-2001, frequently >2^53. Default
    // node:sqlite throws on over-safe-int values; opt in to BigInt returns.
    stmt.setReadBigInts(true);
    const rows = stmt.all(n);
    return {
      ok: true,
      count: rows.length,
      chats: rows.map((r) => ({
        chatId: Number(r.chatId),
        identifier: r.chatIdentifier ?? null,
        displayName: r.displayName ?? null,
        handles: r.handles ?? null,
        service: r.service ?? null,
        lastDate: chatDbDateToIso(r.lastDate),
        lastText: typeof r.lastText === "string" ? r.lastText.slice(0, 400) : null,
        lastFromMe: Number(r.lastFromMe) === 1,
        msgCount: Number(r.msgCount) || 0,
      })),
    };
  } finally {
    opened.db.close();
  }
}

async function messages_thread({ chatId, limit } = {}) {
  const id = Number(chatId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: "chatId must be the numeric chatId from messages_list_chats" };
  }
  const opened = openChatDb();
  if (!opened.ok) {
    return { ok: false, error: opened.reason };
  }
  const n = Number.isFinite(limit) && Number(limit) > 0 ? Math.min(500, Number(limit)) : 50;
  try {
    // Most-recent N, reversed to chronological order on return.
    const stmt = opened.db.prepare(
      `SELECT
         m.ROWID       AS id,
         m.text        AS text,
         m.date        AS date,
         m.is_from_me  AS fromMe,
         m.service     AS service,
         h.id          AS senderId
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE cmj.chat_id = ?
       ORDER BY m.date DESC
       LIMIT ?`,
    );
    stmt.setReadBigInts(true);
    const rows = stmt.all(id, n);
    const msgs = rows
      .toReversed()
      .map((r) => ({
        id: Number(r.id),
        at: chatDbDateToIso(r.date),
        fromMe: Number(r.fromMe) === 1,
        sender: r.senderId ?? (Number(r.fromMe) === 1 ? "me" : null),
        service: r.service ?? null,
        text: typeof r.text === "string" ? r.text : null,
      }))
      .filter((m) => m.text !== null);
    return { ok: true, chatId: id, count: msgs.length, messages: msgs };
  } finally {
    opened.db.close();
  }
}

async function messages_search({ query, limit } = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    return { ok: false, error: "query is required" };
  }
  const opened = openChatDb();
  if (!opened.ok) {
    return { ok: false, error: opened.reason };
  }
  const n = Number.isFinite(limit) && Number(limit) > 0 ? Math.min(200, Number(limit)) : 30;
  try {
    // LIKE scan is fine for ~50k messages. chat.db has no FTS index by
    // default. Case-insensitive via LOWER on both sides.
    const stmt = opened.db.prepare(
      `SELECT
         m.ROWID       AS id,
         m.text        AS text,
         m.date        AS date,
         m.is_from_me  AS fromMe,
         h.id          AS senderId,
         cmj.chat_id   AS chatId,
         c.chat_identifier AS chatIdentifier,
         c.display_name    AS displayName
       FROM message m
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       LEFT JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE m.text IS NOT NULL
         AND LOWER(m.text) LIKE LOWER(?)
       ORDER BY m.date DESC
       LIMIT ?`,
    );
    stmt.setReadBigInts(true);
    const rows = stmt.all(`%${q}%`, n);
    return {
      ok: true,
      query: q,
      count: rows.length,
      hits: rows.map((r) => ({
        id: Number(r.id),
        at: chatDbDateToIso(r.date),
        fromMe: Number(r.fromMe) === 1,
        sender: r.senderId ?? (Number(r.fromMe) === 1 ? "me" : null),
        chatId: Number(r.chatId) || null,
        chatIdentifier: r.chatIdentifier ?? null,
        displayName: r.displayName ?? null,
        text: typeof r.text === "string" ? r.text.slice(0, 400) : null,
      })),
    };
  } finally {
    opened.db.close();
  }
}

// ---- System notification (native macOS banner) ----------------------------

async function system_notification({ title, body }) {
  const titleEsc = String(title).replace(/"/g, '\\"');
  const bodyEsc = (body ?? "").replace(/"/g, '\\"');
  const script = `display notification "${bodyEsc}" with title "${titleEsc}"`;
  const res = await applescript(script);
  if (!res.ok) {
    return { ok: false, error: res.stderr || "osascript failed" };
  }
  return { ok: true, title };
}

// ---- open URL ------------------------------------------------------------

async function open_url({ url, browser }) {
  // Default to `open <url>` which launches the user's default browser.
  // If a specific browser is named, try that via `open -a`.
  return new Promise((resolve) => {
    const args = browser ? ["-a", browser, String(url)] : [String(url)];
    const child = spawn("/usr/bin/open", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, url, browser: browser ?? "default" });
      } else {
        resolve({ ok: false, error: stderr || `open exited ${code}` });
      }
    });
  });
}

async function mac_app_open({ app }) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/open", ["-a", String(app)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, app });
      } else {
        resolve({ ok: false, error: stderr || `open -a ${app} exited ${code}` });
      }
    });
  });
}

// ---- MCP server -----------------------------------------------------------

const server = new Server(
  { name: "apple-toolkit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const toolDefs = [
  {
    name: "reminders_add",
    description:
      "Add a reminder to Apple Reminders on the logged-in user's Mac. Uses the default list unless `list` is specified. `dueISO` is an ISO-8601 timestamp (e.g. 2026-04-23T15:00:00). First call triggers a macOS 'allow automation' dialog; once granted, subsequent calls are silent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        list: { type: "string" },
        notes: { type: "string" },
        dueISO: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "reminders_list",
    description:
      "List incomplete reminders (up to `limit`, default 20). Optionally filter by `list`. Returns id, name, list, body, dueDate (ISO), priority.",
    inputSchema: {
      type: "object",
      properties: {
        list: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "reminders_complete",
    description: "Mark a reminder complete by id (obtained from reminders_list).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "messages_send",
    description:
      "Send an iMessage from Joseph's Apple ID to the specified recipient. `to` is a phone number (+15555550123) or Apple ID email. CRITICAL ACTION — the execution gate should require approval for this tool in assisted mode. First call triggers macOS 'allow automation' dialog.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "messages_list_chats",
    description:
      "List Joseph's most recent iMessage/SMS conversations (direct + group). Reads chat.db directly via SQLite — needs Full Disk Access for the node binary running this toolkit. Returns chatId (use for messages_thread), display_name/handles, last message text + timestamp, and whether the last message was from him.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "messages_thread",
    description:
      "Read an iMessage/SMS conversation by numeric chatId (obtained from messages_list_chats). Returns up to `limit` messages in chronological order. Direct SQLite read — fast across multi-year threads.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["chatId"],
      additionalProperties: false,
    },
  },
  {
    name: "messages_search",
    description:
      "Full-text search across every iMessage/SMS Joseph has ever sent or received. Case-insensitive LIKE scan across chat.db. Returns chatId + text excerpt + timestamp so the caller can decide whether to pull a thread.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "system_notification",
    description:
      "Show a native macOS notification banner on Joseph's Mac. Use for time-sensitive nudges that don't warrant a full Telegram DM.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "open_url",
    description:
      "Open a URL in the default browser (or a specific one if `browser` is given, e.g. 'Safari' or 'Google Chrome').",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1 },
        browser: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "mac_app_open",
    description: "Open a named macOS application (e.g. 'Obsidian', 'Messages', 'Calendar').",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", minLength: 1 } },
      required: ["app"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_list_calendars",
    description:
      "List Calendar.app calendars on Joseph's Mac. Returns name + writable flag for each. Works via AppleScript without Full Disk Access.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_events_range",
    description:
      "List Calendar.app events in [startISO, endISO) across all calendars (or a named one). Returns uid/summary/location/start/end/calendar/allDay, sorted by start. Works via AppleScript without Full Disk Access.",
    inputSchema: {
      type: "object",
      properties: {
        startISO: { type: "string" },
        endISO: { type: "string" },
        calendar: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["startISO", "endISO"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_events_today",
    description:
      "Convenience: list today's events (midnight-to-midnight, local time) across all calendars or a named one.",
    inputSchema: {
      type: "object",
      properties: { calendar: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "notes_search",
    description:
      "Case-insensitive substring search across Apple Notes. Fast name-only scan by default (~1s on 500 notes). Pass `deep:true` to also scan body text — accurate but slow (up to ~1min on a large note corpus). Returns id/name/matchedOn/preview/folder/modificationDate.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        deep: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_list_recent",
    description:
      "List the most recently modified notes (default 10, max 100). Returns id/name/preview/folder/modificationDate.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "notes_get",
    description:
      "Fetch the full plaintext body of a specific note by id (from notes_search/notes_list_recent) or by name.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "notes_create",
    description:
      "Create a new note with title + body. Goes in the default folder unless `folder` is named. Body is plain text; basic HTML (<h1>, <p>) will render.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        folder: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result;
  switch (name) {
    case "reminders_add":
      result = await reminders_add(args);
      break;
    case "reminders_list":
      result = await reminders_list(args);
      break;
    case "reminders_complete":
      result = await reminders_complete(args);
      break;
    case "messages_send":
      result = await messages_send(args);
      break;
    case "messages_list_chats":
      result = await messages_list_chats(args);
      break;
    case "messages_thread":
      result = await messages_thread(args);
      break;
    case "messages_search":
      result = await messages_search(args);
      break;
    case "system_notification":
      result = await system_notification(args);
      break;
    case "open_url":
      result = await open_url(args);
      break;
    case "mac_app_open":
      result = await mac_app_open(args);
      break;
    case "calendar_list_calendars":
      result = await calendar_list_calendars();
      break;
    case "calendar_events_range":
      result = await calendar_events_range(args);
      break;
    case "calendar_events_today":
      result = await calendar_events_today(args);
      break;
    case "notes_search":
      result = await notes_search(args);
      break;
    case "notes_list_recent":
      result = await notes_list_recent(args);
      break;
    case "notes_get":
      result = await notes_get(args);
      break;
    case "notes_create":
      result = await notes_create(args);
      break;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
