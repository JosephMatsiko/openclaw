#!/usr/bin/env node
// "The World This Week" — weekly magazine digest delivered to Joseph's
// Gmail inbox.
//
// Reads the last seven days of daily summaries + what shifted in the
// memory graph + upcoming calendar this coming week, hands the bundle to
// Claude Sonnet to write editorial copy, renders an HTML email in the
// same dark palette as the phone UI, and lands it as a Gmail draft
// addressed from Joseph to Joseph.
//
// Draft-only by design: per our OAuth consent Joseph approved Gmail
// read + draft, not send. Opening Gmail on any device shows a "Drafts"
// entry, one click to send if he wants it to land in INBOX.
//
// Usage:
//   node extensions/memory-graph/scripts/weekly-magazine.mjs
//   node extensions/memory-graph/scripts/weekly-magazine.mjs --apply
//   node extensions/memory-graph/scripts/weekly-magazine.mjs --date 2026-04-27
//   node extensions/memory-graph/scripts/weekly-magazine.mjs --issue 4
//
// Flags:
//   --apply            Actually create the Gmail draft. Default: dry-run
//                      (prints the HTML + plaintext to stdout).
//   --date YYYY-MM-DD  End of the covered week (inclusive). Default: today.
//   --issue N          Issue number for the subject line. Default:
//                      weeks-since-2026-01-05 (rough count from new year).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const DB_PATH = join(HOME, ".openclaw", "memory", "graph.sqlite");
const SUMMARIES_DIR = join(HOME, ".openclaw", "workspace", "memory", "summaries");
const GMAIL_CRED = join(HOME, ".openclaw", "credentials", "gmail.json");
const AUTH_PROFILES = join(HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json");

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--apply") {
      out.flags.apply = true;
    } else if (t === "--date") {
      out.flags.date = argv[i + 1];
      i += 1;
    } else if (t === "--issue") {
      out.flags.issue = argv[i + 1];
      i += 1;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.flags.help) {
  console.log("usage: weekly-magazine.mjs [--apply] [--date YYYY-MM-DD] [--issue N]");
  process.exit(0);
}

const END_DATE = typeof args.flags.date === "string" ? args.flags.date : ymdLocal(new Date());

// Issue number defaults to weeks-since-new-year so each Sunday the count
// advances by 1. Not perfect but human-memorable.
function defaultIssue() {
  const jan5 = new Date("2026-01-05T00:00:00");
  const today = new Date(`${END_DATE}T00:00:00`);
  const weeks = Math.max(1, Math.floor((today.getTime() - jan5.getTime()) / (7 * 86400_000)));
  return String(weeks);
}

const ISSUE =
  typeof args.flags.issue === "string" && args.flags.issue.trim()
    ? args.flags.issue.trim()
    : defaultIssue();
const APPLY = args.flags.apply === true;

function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateDaysBefore(ymd, days) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() - days);
  return ymdLocal(d);
}

// ---- Data loaders --------------------------------------------------------

function loadWeekSummaries(endYmd) {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const ymd = dateDaysBefore(endYmd, i);
    const path = join(SUMMARIES_DIR, `${ymd}.md`);
    if (existsSync(path)) {
      days.push({ date: ymd, body: readFileSync(path, "utf8") });
    }
  }
  return days;
}

function loadMemoryDelta(endYmd) {
  if (!existsSync(DB_PATH)) {
    return { added: [], recent: [] };
  }
  const startMs = new Date(`${dateDaysBefore(endYmd, 6)}T00:00:00`).getTime();
  const endMs = new Date(`${endYmd}T23:59:59`).getTime();
  const db = new DatabaseSync(DB_PATH);
  try {
    const added = db
      .prepare(
        `SELECT kind, summary, confidence
           FROM nodes
          WHERE kind IN ('fact','preference','constraint','open-loop','entity')
            AND created_at BETWEEN ? AND ?
            AND scope = 'workspace' AND scope_id = 'default'
          ORDER BY created_at ASC
          LIMIT 30`,
      )
      .all(startMs, endMs);
    const recent = db
      .prepare(
        `SELECT kind, summary
           FROM nodes
          WHERE kind = 'open-loop'
            AND scope = 'workspace' AND scope_id = 'default'
          ORDER BY updated_at DESC
          LIMIT 12`,
      )
      .all();
    return {
      added: added.map((r) => ({
        kind: String(r.kind),
        summary: String(r.summary ?? "").slice(0, 200),
        confidence: Number(r.confidence ?? 0),
      })),
      recent: recent.map((r) => ({
        kind: String(r.kind),
        summary: String(r.summary ?? "").slice(0, 200),
      })),
    };
  } finally {
    db.close();
  }
}

async function loadCalendarLookahead() {
  const script = `
tell application "Calendar"
  set lookahead to {}
  set startDate to current date
  set endDate to current date + 7 * days
  repeat with c in calendars
    try
      repeat with e in (events of c whose start date is greater than or equal to startDate and start date is less than endDate)
        set eSummary to summary of e
        set eStart to start date of e
        set end of lookahead to {name of c, eSummary, eStart as string}
      end repeat
    on error
    end try
  end repeat
  return lookahead
end tell
  `.trim();
  const res = await runOsascript(["-e", script], 15000);
  if (!res.ok) {
    return [];
  }
  const raw = res.stdout.trim();
  if (!raw) {
    return [];
  }
  // AppleScript list output uses comma separators; good-enough parse.
  const tokens = raw.split(", ");
  const events = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    events.push({ calendar: tokens[i], title: tokens[i + 1], startRaw: tokens[i + 2] });
  }
  return events.slice(0, 20);
}

function runOsascript(argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

// ---- Claude editorial --------------------------------------------------

async function callClaudeCli(prompt) {
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
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error("claude CLI empty output"));
        return;
      }
      resolve(text);
    });
    child.on("error", (err) => reject(err));
  });
}

function buildEditorialPrompt({ endDate, summaries, memory, calendar }) {
  const lines = [];
  lines.push(
    `You are the editor of "The World This Week" — Joseph Matsiko's personal weekly magazine.`,
  );
  lines.push("");
  lines.push(
    "Your job: take the raw feed below and produce editorial copy for five sections. Write like a real magazine editor — specific, concrete, tightly edited. American spelling. No emojis. No filler.",
  );
  lines.push("");
  lines.push(`Issue cover date: week ending ${endDate}`);
  lines.push("");
  lines.push(
    "Deliver the output as this EXACT structure — one section per line starting with the section tag in square brackets. The renderer will parse these tags:",
  );
  lines.push("");
  lines.push(
    "[cover] 1–2 sentence cover line. Pick the single most interesting thread of the week and tease it.",
  );
  lines.push(
    "[recap] 3–5 sentences. Narrative arc of the week from the daily summaries. What actually happened, what shifted, what mattered.",
  );
  lines.push(
    "[wins] bullet list (use markdown dashes). 2–4 concrete wins from the week. Each bullet one crisp line.",
  );
  lines.push(
    "[loops] bullet list. 2–5 open loops or unresolved threads heading into next week. Each bullet one line.",
  );
  lines.push(
    "[lookahead] 2–4 sentences. What the coming week holds — grounded in the calendar feed below — and one editorial nudge of what to focus on.",
  );
  lines.push("");
  lines.push("=== DAILY SUMMARIES THIS WEEK ===");
  if (summaries.length === 0) {
    lines.push("(no daily summaries captured this week)");
  } else {
    for (const s of summaries) {
      lines.push(`--- ${s.date} ---`);
      lines.push(s.body.trim().slice(0, 2000));
      lines.push("");
    }
  }
  lines.push("=== MEMORY GRAPH ADDITIONS (facts/prefs/loops added this week) ===");
  if (memory.added.length === 0) {
    lines.push("(none)");
  } else {
    for (const c of memory.added) {
      lines.push(`- [${c.kind}] ${c.summary}`);
    }
  }
  lines.push("");
  lines.push("=== OPEN LOOPS (most recently active) ===");
  if (memory.recent.length === 0) {
    lines.push("(none)");
  } else {
    for (const c of memory.recent) {
      lines.push(`- ${c.summary}`);
    }
  }
  lines.push("");
  lines.push("=== NEXT 7 DAYS CALENDAR ===");
  if (calendar.length === 0) {
    lines.push("(no upcoming events or calendar unavailable)");
  } else {
    for (const e of calendar) {
      lines.push(`- ${e.startRaw} · ${e.calendar}: ${e.title}`);
    }
  }
  lines.push("");
  lines.push("Write the five sections now. Tag each one as specified.");
  return lines.join("\n");
}

function parseEditorial(text) {
  const sections = { cover: "", recap: "", wins: "", loops: "", lookahead: "" };
  const tagOrder = ["cover", "recap", "wins", "loops", "lookahead"];
  let currentTag = null;
  const buf = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[([a-z]+)\]\s*(.*)$/);
    if (match && tagOrder.includes(match[1])) {
      currentTag = match[1];
      buf[currentTag] = match[2] ? [match[2]] : [];
      continue;
    }
    if (currentTag) {
      buf[currentTag].push(line);
    }
  }
  for (const t of tagOrder) {
    sections[t] = (buf[t] ?? []).join("\n").trim();
  }
  return sections;
}

// ---- Render HTML --------------------------------------------------------

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bulletListHtml(text) {
  const items = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l.length > 0);
  if (items.length === 0) {
    return `<p style="margin:0;color:#838387;">(nothing this week)</p>`;
  }
  return `<ul style="margin:0;padding-left:20px;line-height:1.55;">${items
    .map((i) => `<li style="margin:4px 0;">${escapeHtml(i)}</li>`)
    .join("")}</ul>`;
}

function paragraphHtml(text) {
  if (!text) {
    return `<p style="margin:0;color:#838387;">—</p>`;
  }
  return text
    .split(/\n\n+/)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;line-height:1.6;">${escapeHtml(p.trim()).replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
}

function renderHtml({ issue, endDate, sections }) {
  const accent = "#ff5c5c";
  const bg = "#0e1015";
  const card = "#161920";
  const border = "#1e2028";
  const text = "#d4d4d8";
  const strong = "#f4f4f5";
  const muted = "#838387";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${bg};color:${text};font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
    <div style="border-bottom:2px solid ${accent};padding-bottom:12px;margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${muted};">Issue ${escapeHtml(issue)} &middot; week ending ${escapeHtml(endDate)}</div>
      <div style="font-size:28px;font-weight:700;color:${strong};letter-spacing:-0.02em;margin-top:4px;">The World This Week</div>
    </div>

    <div style="background:${card};border:1px solid ${border};border-radius:12px;padding:18px 20px;margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">Cover</div>
      <div style="font-size:18px;line-height:1.5;color:${strong};">${paragraphHtml(sections.cover)}</div>
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">The Recap</div>
      ${paragraphHtml(sections.recap)}
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">Wins</div>
      ${bulletListHtml(sections.wins)}
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">Open Loops</div>
      ${bulletListHtml(sections.loops)}
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">Week Ahead</div>
      ${paragraphHtml(sections.lookahead)}
    </div>

    <div style="border-top:1px solid ${border};margin-top:24px;padding-top:12px;font-size:11px;color:${muted};line-height:1.5;">
      Drafted by Chuck via Claude Sonnet on ${escapeHtml(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC.<br>
      Source: ~/.openclaw/workspace/memory/summaries + memory-graph + Calendar.app.
    </div>
  </div>
</body></html>`;
}

function renderPlaintext({ issue, endDate, sections }) {
  const lines = [];
  lines.push(`THE WORLD THIS WEEK — Issue ${issue}, week ending ${endDate}`);
  lines.push("=".repeat(64));
  lines.push("");
  lines.push("COVER");
  lines.push(sections.cover || "—");
  lines.push("");
  lines.push("THE RECAP");
  lines.push(sections.recap || "—");
  lines.push("");
  lines.push("WINS");
  lines.push(sections.wins || "—");
  lines.push("");
  lines.push("OPEN LOOPS");
  lines.push(sections.loops || "—");
  lines.push("");
  lines.push("WEEK AHEAD");
  lines.push(sections.lookahead || "—");
  lines.push("");
  lines.push("— Drafted by Chuck via Claude Sonnet");
  return lines.join("\n");
}

// ---- Gmail draft create -------------------------------------------------

function loadGmailCreds() {
  const profiles = JSON.parse(readFileSync(AUTH_PROFILES, "utf8"));
  const app = profiles?.profiles?.["google-gmail:default"];
  if (!app?.key || !app?.secret) {
    throw new Error(
      `profiles["google-gmail:default"] missing from ${AUTH_PROFILES} — run gmail-toolkit --login once.`,
    );
  }
  const tokens = JSON.parse(readFileSync(GMAIL_CRED, "utf8"));
  return { clientId: app.key, clientSecret: app.secret, tokens };
}

async function refreshGmailAccessToken(creds) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.tokens.refresh_token,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gmail refresh ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  return String(data.access_token);
}

function buildMimeMessage({ to, from, subject, html, text }) {
  // Multipart/alternative with text + html parts. Gmail drafts API wants
  // a base64url-encoded RFC 2822 message.
  const boundary = `boundary_${Date.now().toString(36)}`;
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push("");
  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(text);
  lines.push("");
  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/html; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(html);
  lines.push("");
  lines.push(`--${boundary}--`);
  const raw = lines.join("\r\n");
  // base64url
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

async function createGmailDraft({ subject, html, text, toEmail }) {
  const creds = loadGmailCreds();
  const accessToken = await refreshGmailAccessToken(creds);
  const raw = buildMimeMessage({
    to: toEmail,
    from: toEmail,
    subject,
    html,
    text,
  });
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gmail drafts create ${res.status}: ${txt.slice(0, 400)}`);
  }
  return await res.json();
}

// ---- main --------------------------------------------------------------

async function main() {
  console.error(`[weekly-magazine] issue ${ISSUE} · week ending ${END_DATE} · apply=${APPLY}`);

  const summaries = loadWeekSummaries(END_DATE);
  console.error(`[weekly-magazine] summaries loaded: ${summaries.length}/7 days`);

  const memory = loadMemoryDelta(END_DATE);
  console.error(
    `[weekly-magazine] memory delta: ${memory.added.length} new, ${memory.recent.length} open loops`,
  );

  const calendar = await loadCalendarLookahead();
  console.error(`[weekly-magazine] calendar lookahead: ${calendar.length} events`);

  const prompt = buildEditorialPrompt({ endDate: END_DATE, summaries, memory, calendar });
  console.error(`[weekly-magazine] editorial prompt ~${Math.round(prompt.length / 1024)}KB`);

  const editorialRaw = await callClaudeCli(prompt);
  const sections = parseEditorial(editorialRaw);
  console.error(
    `[weekly-magazine] sections: cover=${sections.cover.length}c recap=${sections.recap.length}c wins=${sections.wins.length}c loops=${sections.loops.length}c lookahead=${sections.lookahead.length}c`,
  );

  const html = renderHtml({ issue: ISSUE, endDate: END_DATE, sections });
  const text = renderPlaintext({ issue: ISSUE, endDate: END_DATE, sections });
  const subject = `The World This Week — Issue ${ISSUE} (week ending ${END_DATE})`;

  if (!APPLY) {
    console.log("--- PLAINTEXT ---\n");
    console.log(text);
    console.log("\n--- HTML SIZE ---", html.length, "bytes");
    console.error(
      "[weekly-magazine] dry run. Pass --apply to create a Gmail draft addressed to yourself.",
    );
    return;
  }

  // Use the same email as the Gmail-connected account so the draft lands
  // in Joseph's own drafts view.
  const me = "joematsikojr@gmail.com";
  const draft = await createGmailDraft({ subject, html, text, toEmail: me });
  console.error(`[weekly-magazine] gmail draft id=${draft.id} created in ${me} drafts.`);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[weekly-magazine] fatal: ${msg}`);
  process.exitCode = 1;
});
