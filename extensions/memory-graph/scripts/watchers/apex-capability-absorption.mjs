#!/usr/bin/env node
// Apex capability absorption — monthly scan for new Claude-in-Chrome
// tool surface, flag features Apex hasn't absorbed yet.
//
// Anthropic ships Claude-in-Chrome tools via the Chrome extension.
// Feature set grows over time (new actions, new browser verbs, new
// recording primitives). Apex's parity depends on absorbing each.
//
// Strategy:
//   1. Enumerate the current Claude-in-Chrome tool names by asking
//      `claude -p` inside a Claude Code session to list MCP tools
//      with prefix `mcp__Claude_in_Chrome__*`
//   2. Compare against the known list in KNOWN_TOOLS below
//   3. Any delta (new tool shipped) → propose-pending graph node so
//      Joseph sees "Anthropic added X; Apex should absorb"
//   4. Record deltas in state/apex-capability-deltas.jsonl
//
// Monthly cadence (apex-better scans capabilities every 6h already;
// this is specifically the cross-vendor tool-surface watch).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".openclaw", "workspace", "state");
const DELTAS_LOG = join(STATE_DIR, "apex-capability-deltas.jsonl");
const KNOWN_PATH = join(STATE_DIR, "apex-absorbed-tools.json");

// Baseline of Claude-in-Chrome tools absorbed into apex-chrome-cdp-*
// modules. Update this list as new tools land.
const ABSORBED = new Set([
  "switch_browser",
  "tabs_close_mcp",
  "tabs_create_mcp",
  "tabs_context_mcp",
  "browser_batch",
  "computer",
  "form_input",
  "javascript_tool",
  "navigate",
  "read_console_messages",
  "read_network_requests",
  "shortcuts_execute",
  "shortcuts_list",
  "upload_image",
  "file_upload",
  "find",
  "get_page_text",
  "gif_creator",
  "read_page",
  "resize_window",
]);

function ensureDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readKnown() {
  if (!existsSync(KNOWN_PATH)) {
    return [...ABSORBED];
  }
  try {
    return JSON.parse(readFileSync(KNOWN_PATH, "utf8"));
  } catch {
    return [...ABSORBED];
  }
}

function writeKnown(list) {
  ensureDir();
  writeFileSync(
    KNOWN_PATH,
    JSON.stringify(
      [...new Set(list)].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      null,
      2,
    ),
    "utf8",
  );
}

async function listChromeTools() {
  return new Promise((resolve) => {
    const prompt =
      "List ONLY the unprefixed tool names available under mcp__Claude_in_Chrome__* in your current session, one per line, no prose. If you don't have Claude-in-Chrome MCP, output 'NO_CHROME_MCP'.";
    const p = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        "opus",
        "--fallback-model",
        "sonnet",
        "--output-format",
        "text",
        "--allowedTools",
        "mcp__Claude_in_Chrome__*",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      resolve({ ok: false, tools: [], error: "timeout" });
    }, 60_000);
    p.stdout.on("data", (c) => {
      out += c.toString();
    });
    p.stderr.on("data", (c) => {
      err += c.toString();
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, tools: [], error: err.slice(0, 200) });
        return;
      }
      if (/NO_CHROME_MCP/.test(out)) {
        resolve({ ok: true, tools: [], error: "no-chrome-mcp-in-session" });
        return;
      }
      const tools = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^\s*$/.test(l) && !l.includes(" "))
        .map((l) => l.replace(/^mcp__Claude_in_Chrome__/, ""));
      resolve({ ok: true, tools });
    });
  });
}

export async function scan() {
  ensureDir();
  const r = await listChromeTools();
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  const known = new Set(readKnown());
  const currentSet = new Set(r.tools);
  const newTools = [...currentSet].filter((t) => !known.has(t));
  const droppedTools = [...known].filter((t) => !currentSet.has(t));
  const entry = {
    ts: new Date().toISOString(),
    totalCurrent: currentSet.size,
    totalKnown: known.size,
    newTools,
    droppedTools,
  };
  try {
    appendFileSync(DELTAS_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    /* best-effort */
  }
  if (newTools.length > 0 || droppedTools.length > 0) {
    writeKnown([...currentSet]);
  }
  return { ok: true, ...entry };
}

export async function tick() {
  return await scan();
}

async function mainCli() {
  const r = await tick();
  console.log(JSON.stringify(r, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[apex-capability-absorption] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
