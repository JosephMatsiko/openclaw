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

function jxa(script) {
  return runOsascript(["-l", "JavaScript", "-e", script]);
}

function applescript(script) {
  return runOsascript(["-e", script]);
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
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
