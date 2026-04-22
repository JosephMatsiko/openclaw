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
//   system_notification(title, body?) — native macOS banner
//   open_url(url, browser?)           — default browser or specific one
//   mac_app_open(app)                 — open a named .app

import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
