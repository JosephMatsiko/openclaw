#!/usr/bin/env node
// Joseph's personal magazine — daily / friday / weekend / sunday editions
// delivered to Gmail as a draft, with a Telegram DM nudging him that the
// issue is ready.
//
// Each edition reads the relevant window of daily summaries, the memory-
// graph delta, and upcoming calendar, then asks Claude Sonnet (Max, Opus
// fallback) for editorial copy in a section layout matched to the edition.
// Rendered into a dark-themed HTML email and landed as a Gmail draft from
// Joseph to Joseph.
//
// Draft-only by design: our OAuth consent covers compose/read, not send.
// The Telegram DM compensates for Gmail's no-push-on-drafts by pinging
// him when a new issue is sitting in the Drafts folder.
//
// Editions:
//   daily    — one-day recap, runs each morning (default cover date: today)
//   friday   — Mon–Fri workweek wrap-up
//   weekend  — seven-day reflection, Saturday edition
//   sunday   — five-section magazine proper (Cover, Recap, Wins, Loops,
//              Week Ahead)
//
// Usage:
//   node extensions/memory-graph/scripts/magazine.mjs --edition sunday
//   node extensions/memory-graph/scripts/magazine.mjs --edition daily --apply
//   node extensions/memory-graph/scripts/magazine.mjs --edition friday --apply --no-ping
//   node extensions/memory-graph/scripts/magazine.mjs --edition weekend --date 2026-04-26 --apply
//
// Flags:
//   --edition NAME   One of: daily, friday, weekend, sunday. Default: sunday.
//   --apply          Create the Gmail draft + send Telegram ping.
//                    Default: dry-run prints plaintext to stdout.
//   --no-ping        Skip the Telegram DM even on --apply.
//   --date YYYY-MM-DD  End of the covered window. Default: today.
//   --issue N        Explicit issue number. Default: weeks-since-2026-01-05.
//                    Daily edition uses the ISO date as its "issue" instead.
//   --to EMAIL       Override recipient. Default: joematsikojr@gmail.com.
//   --target CHATID  Override Telegram chat id. Default: first entry in
//                    ~/.openclaw/credentials/telegram-default-allowFrom.json.

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
const TELEGRAM_ALLOW_FROM = join(
  HOME,
  ".openclaw",
  "credentials",
  "telegram-default-allowFrom.json",
);
const OPENCLAW_CLI = join(HOME, "Projects", "openclaw", "openclaw.mjs");
const NODE_BIN = process.execPath;

// ---- edition definitions -------------------------------------------------

// Each edition declares the window of summaries to include, the section tag
// layout Claude should emit, and a short description of its editorial voice.
// Keeping each edition's shape declarative means the renderer/parser/send
// paths are the same code — only the prompt and tags change.
const EDITIONS = {
  daily: {
    label: "Daily",
    windowDays: 1,
    sections: [
      {
        tag: "thread",
        title: "Today's Thread",
        render: "paragraph",
        prompt: "1-2 sentence cover. The single most interesting thread today.",
      },
      {
        tag: "recap",
        title: "The Recap",
        render: "paragraph",
        prompt: "3 sentences. What actually happened today and what moved.",
      },
      {
        tag: "captured",
        title: "Captured",
        render: "bullets",
        prompt:
          "Bullet list (max 5). New facts, preferences, open loops that landed in the memory graph today. Each bullet one crisp line.",
      },
      {
        tag: "tomorrow",
        title: "Tomorrow's Pull",
        render: "paragraph",
        prompt:
          "2 sentences. Grounded in the calendar feed below if there is one. One editorial nudge of what to focus on first tomorrow.",
      },
    ],
    voice:
      "Voice: terse, journal-adjacent. You are writing a personal end-of-day brief for Joseph. No fluff, no hedging.",
    subject: (date) => `Chuck daily - ${date}`,
    pingCopy: (date) => `Chuck daily is in your drafts - ${date}.`,
  },
  friday: {
    label: "Friday",
    windowDays: 5,
    sections: [
      {
        tag: "arc",
        title: "The Week's Arc",
        render: "paragraph",
        prompt: "3-5 sentences. Narrative arc of the workweek from the daily summaries.",
      },
      {
        tag: "shipped",
        title: "Shipped",
        render: "bullets",
        prompt: "Bullet list (2-4). Concrete wins this week. Each bullet one crisp line.",
      },
      {
        tag: "carried",
        title: "Carried Forward",
        render: "bullets",
        prompt: "Bullet list (2-5). Open loops going into the weekend.",
      },
      {
        tag: "weekend",
        title: "For The Weekend",
        render: "paragraph",
        prompt:
          "2 sentences. One rest-or-recharge editorial nudge + one thing worth touching before Monday if anything.",
      },
    ],
    voice: "Voice: end-of-workweek wrap. Specific. The tone of a good editor closing the week.",
    subject: (date) => `Chuck Friday - week ending ${date}`,
    pingCopy: (date) => `Chuck Friday wrap is in your drafts - week ending ${date}.`,
  },
  weekend: {
    label: "Weekend",
    windowDays: 7,
    sections: [
      {
        tag: "thread",
        title: "The Thread",
        render: "paragraph",
        prompt: "3 sentences. Narrative arc of the week - what this week was really about.",
      },
      {
        tag: "changed",
        title: "What Changed",
        render: "bullets",
        prompt:
          "Bullet list. Additions to the memory graph this week: new facts, preferences, constraints, open loops. Each bullet one line.",
      },
      {
        tag: "stayed",
        title: "What Stayed Open",
        render: "bullets",
        prompt: "Bullet list. Loops still unresolved heading into next week.",
      },
      {
        tag: "rest",
        title: "A Note on Rest",
        render: "paragraph",
        prompt:
          "2-3 sentences. A reflective, NOT productive-sounding editorial note. Grounded in the week's actual shape.",
      },
    ],
    voice: "Voice: Saturday morning reflective. Slower cadence than the daily. Not a task list.",
    subject: (date) => `Chuck weekend - week ending ${date}`,
    pingCopy: (date) => `Chuck weekend issue is in your drafts - week ending ${date}.`,
  },
  sunday: {
    label: "Sunday",
    windowDays: 7,
    sections: [
      {
        tag: "cover",
        title: "Cover",
        render: "paragraph",
        prompt: "1-2 sentences. Single most interesting thread of the week, teased.",
      },
      {
        tag: "recap",
        title: "The Recap",
        render: "paragraph",
        prompt: "3-5 sentences. Narrative arc of the week.",
      },
      {
        tag: "wins",
        title: "Wins",
        render: "bullets",
        prompt: "Bullet list (2-4). Concrete wins from the week.",
      },
      {
        tag: "loops",
        title: "Open Loops",
        render: "bullets",
        prompt: "Bullet list (2-5). Unresolved threads heading into next week.",
      },
      {
        tag: "lookahead",
        title: "Week Ahead",
        render: "paragraph",
        prompt: "2-4 sentences. Grounded in the calendar feed if present. One editorial nudge.",
      },
    ],
    voice: "Voice: magazine editor - specific, concrete, tightly edited.",
    subject: (date, issue) => `The World This Week - Issue ${issue} (week ending ${date})`,
    pingCopy: (date, subject) => {
      const issueNum = subject.match(/Issue (\d+)/)?.[1] ?? "";
      return `The World This Week, Issue ${issueNum} is in your drafts - week ending ${date}.`;
    },
  },
};

// ---- args ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--apply") {
      out.flags.apply = true;
    } else if (t === "--no-ping") {
      out.flags.noPing = true;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    } else if (
      t === "--edition" ||
      t === "--date" ||
      t === "--issue" ||
      t === "--to" ||
      t === "--target"
    ) {
      out.flags[t.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.flags.help) {
  console.log(
    "usage: magazine.mjs [--edition daily|friday|weekend|sunday] [--apply] [--no-ping] [--date YYYY-MM-DD] [--issue N] [--to EMAIL] [--target CHATID]",
  );
  process.exit(0);
}

const EDITION_NAME =
  typeof args.flags.edition === "string" && EDITIONS[args.flags.edition]
    ? args.flags.edition
    : "sunday";
const EDITION = EDITIONS[EDITION_NAME];

const END_DATE = typeof args.flags.date === "string" ? args.flags.date : ymdLocal(new Date());

function defaultIssue() {
  if (EDITION_NAME === "daily") {
    return END_DATE;
  }
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
const NO_PING = args.flags.noPing === true;
const TO_EMAIL = typeof args.flags.to === "string" ? args.flags.to : "joematsikojr@gmail.com";

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

function loadWindowSummaries(endYmd, windowDays) {
  const days = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const ymd = dateDaysBefore(endYmd, i);
    const path = join(SUMMARIES_DIR, `${ymd}.md`);
    if (existsSync(path)) {
      days.push({ date: ymd, body: readFileSync(path, "utf8") });
    }
  }
  return days;
}

function loadMemoryDelta(endYmd, windowDays) {
  if (!existsSync(DB_PATH)) {
    return { added: [], recent: [] };
  }
  const startMs = new Date(`${dateDaysBefore(endYmd, windowDays - 1)}T00:00:00`).getTime();
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

async function loadCalendarLookahead(lookaheadDays) {
  const script = `
tell application "Calendar"
  set lookahead to {}
  set startDate to current date
  set endDate to current date + ${lookaheadDays} * days
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

// ---- Claude editorial ---------------------------------------------------

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

function buildEditorialPrompt({ edition, endDate, summaries, memory, calendar }) {
  const lines = [];
  lines.push(
    `You are Chuck, Joseph Matsiko's personal AI assistant + editor. Produce the ${edition.label} edition.`,
  );
  lines.push("");
  lines.push(edition.voice);
  lines.push(
    "American spelling. No emojis. No filler. Edit like a real editor; every sentence earns its place.",
  );
  lines.push("");
  lines.push(`Cover date: ${endDate}`);
  lines.push("");
  lines.push(
    "Output EXACTLY this structure - one section per line starting with the section tag in square brackets. The renderer parses these tags:",
  );
  lines.push("");
  for (const s of edition.sections) {
    lines.push(`[${s.tag}] ${s.prompt}`);
  }
  lines.push("");
  lines.push("=== DAILY SUMMARIES IN WINDOW ===");
  if (summaries.length === 0) {
    lines.push("(no daily summaries in this window)");
  } else {
    for (const s of summaries) {
      lines.push(`--- ${s.date} ---`);
      lines.push(s.body.trim().slice(0, 2000));
      lines.push("");
    }
  }
  lines.push("=== MEMORY GRAPH ADDITIONS IN WINDOW ===");
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
  lines.push("=== CALENDAR LOOKAHEAD ===");
  if (calendar.length === 0) {
    lines.push("(no upcoming events or calendar unavailable)");
  } else {
    for (const e of calendar) {
      lines.push(`- ${e.startRaw} · ${e.calendar}: ${e.title}`);
    }
  }
  lines.push("");
  lines.push(`Write the ${edition.sections.length} sections now. Tag each one as specified.`);
  return lines.join("\n");
}

function parseEditorial(edition, text) {
  const tagSet = new Set(edition.sections.map((s) => s.tag));
  const buf = {};
  let currentTag = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[([a-z]+)\]\s*(.*)$/);
    if (match && tagSet.has(match[1])) {
      currentTag = match[1];
      buf[currentTag] = match[2] ? [match[2]] : [];
      continue;
    }
    if (currentTag) {
      buf[currentTag].push(line);
    }
  }
  const out = {};
  for (const s of edition.sections) {
    out[s.tag] = (buf[s.tag] ?? []).join("\n").trim();
  }
  return out;
}

// ---- Render -------------------------------------------------------------

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
    return `<p style="margin:0;color:#838387;">(nothing this window)</p>`;
  }
  return `<ul style="margin:0;padding-left:20px;line-height:1.55;">${items
    .map((i) => `<li style="margin:4px 0;">${escapeHtml(i)}</li>`)
    .join("")}</ul>`;
}

function paragraphHtml(text) {
  if (!text) {
    return `<p style="margin:0;color:#838387;">-</p>`;
  }
  return text
    .split(/\n\n+/)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;line-height:1.6;">${escapeHtml(p.trim()).replaceAll("\n", "<br>")}</p>`,
    )
    .join("");
}

function renderHtml({ edition, issue, endDate, sections, editionName }) {
  const accent = "#ff5c5c";
  const bg = "#0e1015";
  const card = "#161920";
  const border = "#1e2028";
  const text = "#d4d4d8";
  const strong = "#f4f4f5";
  const muted = "#838387";
  const coverSection = edition.sections[0];
  const restSections = edition.sections.slice(1);
  const kicker =
    editionName === "daily"
      ? `${escapeHtml(edition.label)} · ${escapeHtml(endDate)}`
      : editionName === "sunday"
        ? `Issue ${escapeHtml(issue)} · week ending ${escapeHtml(endDate)}`
        : `${escapeHtml(edition.label)} edition · ${escapeHtml(endDate)}`;
  const masthead =
    editionName === "sunday" ? "The World This Week" : `Chuck — ${edition.label} edition`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${bg};color:${text};font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
    <div style="border-bottom:2px solid ${accent};padding-bottom:12px;margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${muted};">${kicker}</div>
      <div style="font-size:28px;font-weight:700;color:${strong};letter-spacing:-0.02em;margin-top:4px;">${escapeHtml(masthead)}</div>
    </div>

    <div style="background:${card};border:1px solid ${border};border-radius:12px;padding:18px 20px;margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">${escapeHtml(coverSection.title)}</div>
      <div style="font-size:18px;line-height:1.5;color:${strong};">${paragraphHtml(sections[coverSection.tag])}</div>
    </div>

    ${restSections
      .map(
        (s) => `
    <div style="margin-bottom:20px;">
      <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${accent};margin-bottom:8px;">${escapeHtml(s.title)}</div>
      ${s.render === "bullets" ? bulletListHtml(sections[s.tag]) : paragraphHtml(sections[s.tag])}
    </div>`,
      )
      .join("")}

    <div style="border-top:1px solid ${border};margin-top:24px;padding-top:12px;font-size:11px;color:${muted};line-height:1.5;">
      Drafted by Chuck via Claude Sonnet on ${escapeHtml(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC.<br>
      Source: ~/.openclaw/workspace/memory/summaries + memory-graph + Calendar.app.
    </div>
  </div>
</body></html>`;
}

function renderPlaintext({ edition, issue, endDate, sections, editionName }) {
  const lines = [];
  if (editionName === "sunday") {
    lines.push(`THE WORLD THIS WEEK - Issue ${issue}, week ending ${endDate}`);
  } else {
    lines.push(`CHUCK - ${edition.label.toUpperCase()} EDITION - ${endDate}`);
  }
  lines.push("=".repeat(64));
  lines.push("");
  for (const s of edition.sections) {
    lines.push(s.title.toUpperCase());
    lines.push(sections[s.tag] || "-");
    lines.push("");
  }
  lines.push("- Drafted by Chuck via Claude Sonnet");
  return lines.join("\n");
}

// ---- Gmail draft + Telegram ping ---------------------------------------

function loadGmailCreds() {
  const profiles = JSON.parse(readFileSync(AUTH_PROFILES, "utf8"));
  const app = profiles?.profiles?.["google-gmail:default"];
  if (!app?.key || !app?.secret) {
    throw new Error(
      `profiles["google-gmail:default"] missing from ${AUTH_PROFILES} - run gmail-toolkit --login once.`,
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

function resolveTelegramTarget() {
  if (typeof args.flags.target === "string" && args.flags.target.trim()) {
    return args.flags.target.trim();
  }
  try {
    const data = JSON.parse(readFileSync(TELEGRAM_ALLOW_FROM, "utf8"));
    const first = Array.isArray(data?.allowFrom) ? data.allowFrom[0] : undefined;
    return typeof first === "string" ? first.trim() : "";
  } catch {
    return "";
  }
}

// Telegram's practical message limit is 4096 chars. We send the FULL
// magazine body (not just a ping) so Joseph can read the issue directly
// in chat without opening Gmail. Long editions get auto-split at paragraph
// boundaries.
const TELEGRAM_CHUNK_LIMIT = 3800;

function splitForTelegram(text) {
  if (text.length <= TELEGRAM_CHUNK_LIMIT) {
    return [text];
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_CHUNK_LIMIT) {
    // Prefer splitting on blank line, then newline, then hard-cut.
    let cut = remaining.lastIndexOf("\n\n", TELEGRAM_CHUNK_LIMIT);
    if (cut < TELEGRAM_CHUNK_LIMIT / 2) {
      cut = remaining.lastIndexOf("\n", TELEGRAM_CHUNK_LIMIT);
    }
    if (cut < TELEGRAM_CHUNK_LIMIT / 2) {
      cut = TELEGRAM_CHUNK_LIMIT;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

async function sendTelegramBody(body) {
  const target = resolveTelegramTarget();
  if (!target) {
    console.error("[magazine] no Telegram target resolved — skipping delivery.");
    return false;
  }
  const chunks = splitForTelegram(body);
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk =
      chunks.length > 1 ? `${chunks[i]}\n\n— part ${i + 1}/${chunks.length}` : chunks[i];
    // CLI signature (openclaw message send --help):
    //   --channel <telegram|...> --target <dest> --message <body>
    // The body is a NAMED option, not a positional; passing it as a
    // positional fails with "too many arguments for 'send'".
    const ok = await new Promise((resolve) => {
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
          chunk,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("close", (code) => {
        if (code !== 0) {
          console.error(`[magazine] telegram send exit=${code}: ${stderr.slice(0, 300)}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
      child.on("error", (err) => {
        console.error(`[magazine] telegram send error: ${err.message}`);
        resolve(false);
      });
    });
    if (!ok) {
      return false;
    }
  }
  return true;
}

// ---- main --------------------------------------------------------------

async function main() {
  console.error(
    `[magazine] edition=${EDITION_NAME} issue=${ISSUE} window=${EDITION.windowDays}d end=${END_DATE} apply=${APPLY}`,
  );

  const summaries = loadWindowSummaries(END_DATE, EDITION.windowDays);
  console.error(`[magazine] summaries: ${summaries.length}/${EDITION.windowDays} days loaded`);

  const memory = loadMemoryDelta(END_DATE, EDITION.windowDays);
  console.error(
    `[magazine] memory delta: ${memory.added.length} new, ${memory.recent.length} open loops`,
  );

  const calendarLookaheadDays = EDITION_NAME === "daily" ? 2 : EDITION_NAME === "friday" ? 3 : 7;
  const calendar = await loadCalendarLookahead(calendarLookaheadDays);
  console.error(`[magazine] calendar lookahead: ${calendar.length} events`);

  const prompt = buildEditorialPrompt({
    edition: EDITION,
    endDate: END_DATE,
    summaries,
    memory,
    calendar,
  });
  console.error(`[magazine] editorial prompt ~${Math.round(prompt.length / 1024)}KB`);

  const editorialRaw = await callClaudeCli(prompt);
  const sections = parseEditorial(EDITION, editorialRaw);
  const lens = EDITION.sections.map((s) => `${s.tag}=${sections[s.tag].length}c`).join(" ");
  console.error(`[magazine] sections: ${lens}`);

  const html = renderHtml({
    edition: EDITION,
    issue: ISSUE,
    endDate: END_DATE,
    sections,
    editionName: EDITION_NAME,
  });
  const text = renderPlaintext({
    edition: EDITION,
    issue: ISSUE,
    endDate: END_DATE,
    sections,
    editionName: EDITION_NAME,
  });
  const subject = EDITION.subject(END_DATE, ISSUE);

  if (!APPLY) {
    console.log(`--- SUBJECT ---\n${subject}`);
    console.log(`--- PLAINTEXT ---\n\n${text}`);
    console.log(`\n--- HTML ---  ${html.length} bytes`);
    console.error(
      `[magazine] dry run. Pass --apply to create a Gmail draft${NO_PING ? "" : " + Telegram ping"}.`,
    );
    return;
  }

  const draft = await createGmailDraft({ subject, html, text, toEmail: TO_EMAIL });
  console.error(`[magazine] gmail draft id=${draft.id} created in ${TO_EMAIL} drafts.`);

  if (NO_PING) {
    console.error("[magazine] --no-ping set — skipping Telegram delivery.");
    return;
  }
  // Deliver the whole plaintext issue to Telegram so Joseph can read it
  // in the chat interface natively (push notification included) AND still
  // has the HTML version sitting in Drafts for longer-form desktop read.
  const telegramBody = `${subject}\n\n${text}`;
  const delivered = await sendTelegramBody(telegramBody);
  console.error(`[magazine] telegram delivery: ${delivered ? "sent" : "skipped/failed"}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[magazine] fatal: ${msg}`);
  process.exitCode = 1;
});
