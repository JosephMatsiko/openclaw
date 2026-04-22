#!/usr/bin/env node
// Morning brief — proactive daily Telegram DM.
//
// Pulls yesterday's summary, today's open loops, durable memory, and
// (optionally) a scan of `state/watch-events.jsonl`, hands them to Gemini
// 2.5 Flash, and — with `--send` — dispatches a concise personal brief to
// Joseph's Telegram via `openclaw message send`.
//
// Dry-run default so the script can't surprise-DM during setup.
//
// Usage:
//   node extensions/memory-graph/scripts/morning-brief.mjs                 # compose + print
//   node extensions/memory-graph/scripts/morning-brief.mjs --send          # compose + DM
//   node extensions/memory-graph/scripts/morning-brief.mjs --date 2026-04-21
//   node extensions/memory-graph/scripts/morning-brief.mjs --json          # JSON output
//
// Flags:
//   --send              Actually dispatch to Telegram. Default: dry-run
//                       prints to stdout.
//   --date YYYY-MM-DD   Base date for "today". Default: today (local CDT).
//                       Brief references yesterday = date - 1.
//   --target <chat-id>  Telegram chat id. Default: first entry in
//                       ~/.openclaw/credentials/telegram-default-allowFrom.json.
//   --model NAME        Gemini model. Default: gemini-2.5-flash with fallback
//                       to pro → flash-lite on transient failure.
//   --json              Print { brief, target, date, ... } as JSON.
//   -h, --help          Help.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---- args ----

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--send") {
      out.flags.send = true;
    } else if (t === "--json") {
      out.flags.json = true;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    } else if (t === "--date" || t === "--target" || t === "--model") {
      out.flags[t.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      out.positional.push(t);
    }
  }
  return out;
}

const HOME = homedir();
const DB_PATH = join(HOME, ".openclaw", "memory", "graph.sqlite");
const WORKSPACE_MEMORY = join(HOME, ".openclaw", "workspace", "memory");
const SUMMARIES_DIR = join(WORKSPACE_MEMORY, "summaries");
const ALLOW_FROM_PATH = join(HOME, ".openclaw", "credentials", "telegram-default-allowFrom.json");
const OPENCLAW_CLI = join(HOME, "Projects", "openclaw", "openclaw.mjs");
const NODE_BIN = process.execPath;

const args = parseArgs(process.argv.slice(2));
if (args.flags.help) {
  console.log(`morning-brief.mjs — composes and (with --send) DMs a daily Telegram brief.

See header comment for flags.`);
  process.exit(0);
}

const SEND = args.flags.send === true;
const AS_JSON = args.flags.json === true;

// ---- helpers ----

function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const TODAY = typeof args.flags.date === "string" ? args.flags.date : ymdLocal(new Date());
function yesterdayOf(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return ymdLocal(d);
}
const YESTERDAY = yesterdayOf(TODAY);

function resolveTarget() {
  if (typeof args.flags.target === "string" && args.flags.target.trim()) {
    return args.flags.target.trim();
  }
  try {
    const raw = readFileSync(ALLOW_FROM_PATH, "utf8");
    const data = JSON.parse(raw);
    const first = Array.isArray(data?.allowFrom) ? data.allowFrom[0] : undefined;
    if (typeof first === "string" && first.trim()) {
      return first.trim();
    }
  } catch {
    // fall through
  }
  return "";
}

function readIfExists(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function loadClaims() {
  if (!existsSync(DB_PATH)) {
    return [];
  }
  const db = new DatabaseSync(DB_PATH);
  try {
    const rows = db
      .prepare(
        `SELECT kind, summary, confidence FROM nodes
           WHERE kind IN ('fact','preference','constraint','open-loop','entity')
             AND scope = 'workspace' AND scope_id = 'default'
           ORDER BY updated_at DESC
           LIMIT 30`,
      )
      .all();
    return rows.map((r) => ({
      kind: String(r.kind),
      summary: String(r.summary ?? ""),
      confidence: Number(r.confidence ?? 0),
    }));
  } finally {
    db.close();
  }
}

function buildPrompt({ claims, yesterdaySummary, todayLog, heartbeatMd }) {
  const lines = [];
  lines.push(
    "You are Joseph Matsiko's personal AI assistant (Bezalel Node) composing a proactive morning-brief DM for Telegram.",
  );
  lines.push("");
  lines.push(
    "This brief is going to his PHONE as a push notification, so every line must earn its place.",
  );
  lines.push("");
  lines.push("Rules:");
  lines.push(`- Open with a single-line greeting that mentions today's date (${TODAY}).`);
  lines.push(
    "- Pull from the durable claims (facts, preferences, constraints, open-loops) so the brief feels personal and grounded — not generic.",
  );
  lines.push(
    "- Reference yesterday's arc if a summary is provided — one tight sentence, no recap dump.",
  );
  lines.push(
    "- If there are real open-loops or work in flight, name them concretely with a next-step hint.",
  );
  lines.push("- End with one concrete question or nudge that invites a reply.");
  lines.push("- Terse, telegraph-style markdown. No fluff, no hedging.");
  lines.push("- Do NOT use emojis.");
  lines.push("- Hard cap: 600 characters total. Fit the Telegram preview cleanly.");
  lines.push("- American spelling.");
  lines.push("");
  lines.push(`Today: ${TODAY}`);
  lines.push(`Yesterday: ${YESTERDAY}`);
  lines.push("");

  if (claims.length > 0) {
    lines.push("=== DURABLE CLAIMS ===");
    for (const c of claims) {
      lines.push(`- [${c.kind}] ${c.summary}`);
    }
    lines.push("=== END CLAIMS ===");
    lines.push("");
  }

  if (yesterdaySummary) {
    lines.push("=== YESTERDAY'S SUMMARY ===");
    lines.push(yesterdaySummary.trim());
    lines.push("=== END YESTERDAY ===");
    lines.push("");
  }

  if (todayLog) {
    lines.push("=== TODAY'S NOTES SO FAR (may be empty) ===");
    lines.push(todayLog.trim());
    lines.push("=== END TODAY ===");
    lines.push("");
  }

  if (heartbeatMd) {
    lines.push("=== HEARTBEAT PROTOCOL (for your own reference; do not quote) ===");
    lines.push(heartbeatMd.trim().slice(0, 1200));
    lines.push("=== END HEARTBEAT ===");
    lines.push("");
  }

  lines.push("Produce the brief now. Start with the greeting; end with the question or nudge.");
  return lines.join("\n");
}

// ---- Gemini call with fallback chain ----

async function callClaudeCli(prompt) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--model", "sonnet", "--fallback-model", "opus", "--output-format", "text"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 400) || "(no stderr)"}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error("claude CLI produced empty output"));
        return;
      }
      resolve({ text, modelUsed: "claude-cli/sonnet" });
    });
    child.on("error", (err) => reject(err));
  });
}

// ---- Telegram send via openclaw CLI ----

function sendViaOpenClawCli(target, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      NODE_BIN,
      [
        OPENCLAW_CLI,
        "message",
        "send",
        "--channel",
        "telegram",
        "--target",
        target,
        "--message",
        message,
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("openclaw message send timed out after 60s"));
    }, 60000);
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`openclaw exited ${code}: ${stderr.slice(0, 400)}`));
      }
    });
  });
}

// ---- main ----

async function main() {
  const target = resolveTarget();
  if (SEND && !target) {
    console.error(
      "[morning-brief] no --target and no allowFrom entry found; pass --target <chat-id>",
    );
    process.exitCode = 1;
    return;
  }

  const claims = loadClaims();
  const yesterdaySummary = readIfExists(join(SUMMARIES_DIR, `${YESTERDAY}.md`));
  const todayLog = readIfExists(join(WORKSPACE_MEMORY, `${TODAY}.md`));
  const heartbeatMd = readIfExists(join(HOME, ".openclaw", "workspace", "HEARTBEAT.md"));

  const prompt = buildPrompt({ claims, yesterdaySummary, todayLog, heartbeatMd });
  const started = Date.now();
  // Route through Claude Max (Sonnet primary, Opus fallback) — Joseph's
  // Google prepayment is depleted so the old Gemini REST path 429s, and
  // Max covers sonnet+opus unlimited via the claude CLI.
  const { text: brief, modelUsed } = await callClaudeCli(prompt);
  const latencyMs = Date.now() - started;

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          date: TODAY,
          yesterday: YESTERDAY,
          target,
          brief,
          modelUsed,
          latencyMs,
          sent: false,
          claimsUsed: claims.length,
          hadYesterdaySummary: Boolean(yesterdaySummary),
          hadTodayLog: Boolean(todayLog),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[morning-brief] ${TODAY} · model=${modelUsed} · ${latencyMs}ms · claims=${claims.length} · yesterday_summary=${yesterdaySummary ? "yes" : "no"}`,
    );
    console.log("");
    console.log(brief);
    console.log("");
  }

  if (!SEND) {
    if (!AS_JSON) {
      console.log(`[morning-brief] dry-run — pass --send to DM chat ${target || "<no-target>"}`);
    }
    return;
  }

  try {
    const result = await sendViaOpenClawCli(target, brief);
    if (AS_JSON) {
      console.log(JSON.stringify({ sent: true, target, cli: result.stdout }, null, 2));
    } else {
      console.log(`[morning-brief] SENT to telegram:${target}`);
      if (result.stdout) {
        console.log(result.stdout);
      }
    }
  } catch (err) {
    console.error(
      `[morning-brief] send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[morning-brief] fatal: ${msg}`);
  process.exitCode = 1;
});
