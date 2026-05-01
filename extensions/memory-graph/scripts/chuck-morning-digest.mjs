#!/usr/bin/env node
// chuck-morning-digest - one-screen daily summary at 08:05 CDT.
//
// Computes (over the last 24h, anchored to yesterday 08:05 local):
//   - shipped: docket tasks completed since the window start
//   - blockers: docket tasks in status=blocked or status=failed in the window
//   - decisions: bus events with type starting "chuck.decision." in the window
//   - awaiting: pending docket tasks with awaiting=joseph marker, or pending
//     tasks older than 24h if no marker exists
//
// Emits the digest in three formats:
//   --format=json      machine-readable (used by smoke tests; never posts)
//   --format=telegram  long-form markdown to stdout
//   --format=banner    short banner (<=180 chars) to stdout
//   (default)          markdown to stdout AND post to telegram via bot API
//
// Writes a receipt to ~/.openclaw/workspace/state/chuck-v3/morning-digest/
// digest-<yyyymmdd>.json. Idempotent: same-day reruns overwrite cleanly.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const STATE = join(HOME, ".openclaw/workspace/state");
const CHUCK_V3 = join(STATE, "chuck-v3");
const DOCKET_DIR = join(CHUCK_V3, "docket");
const EVENTS_FILE = join(STATE, "apex-events.jsonl");
const DIGEST_DIR = join(CHUCK_V3, "morning-digest");
const OPENCLAW_CFG = join(HOME, ".openclaw/openclaw.json");

const TELEGRAM_CHAT_ID = "8630163522";
const BANNER_MAX = 180;

const args = new Set(process.argv.slice(2));
const fmtArg = process.argv.slice(2).find((a) => a.startsWith("--format="));
const FORMAT = fmtArg ? fmtArg.split("=")[1] : "default";

function readJson(p, fb) {
  if (!existsSync(p)) {
    return fb;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function listDocketFiles() {
  if (!existsSync(DOCKET_DIR)) {
    return [];
  }
  try {
    return readdirSync(DOCKET_DIR)
      .filter((n) => n.startsWith("task-") && n.endsWith(".json"))
      .map((n) => join(DOCKET_DIR, n));
  } catch {
    return [];
  }
}

function parseTs(v) {
  if (!v) {
    return null;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Window = yesterday at 08:05 local through now.
function computeWindow(now = new Date()) {
  const start = new Date(now);
  start.setHours(8, 5, 0, 0);
  if (start.getTime() > now.getTime()) {
    // before today's 08:05 -> use yesterday's 08:05
    start.setDate(start.getDate() - 1);
  } else {
    // after today's 08:05 -> still anchor to yesterday's 08:05 (24h+ window)
    start.setDate(start.getDate() - 1);
  }
  return {
    startMs: start.getTime(),
    startIso: start.toISOString(),
    endMs: now.getTime(),
    endIso: now.toISOString(),
  };
}

function loadTasks() {
  const out = [];
  for (const path of listDocketFiles()) {
    const data = readJson(path, null);
    if (!data) {
      continue;
    }
    const status = String(data.status ?? "unknown").toLowerCase();
    const updatedAt = parseTs(
      data.updatedAt ?? data.finishedAt ?? data.startedAt ?? data.createdAt,
    );
    const finishedAt = parseTs(data.finishedAt);
    const createdAt = parseTs(data.createdAt);
    out.push({
      id:
        data.id ??
        data.taskId ??
        path
          .split("/")
          .pop()
          .replace(/\.json$/, ""),
      title: data.title ?? data.intent ?? data.summary ?? "(untitled)",
      status,
      awaiting: data.awaiting ?? data.awaitingOperator ?? null,
      updatedAt,
      finishedAt,
      createdAt,
      raw: data,
    });
  }
  return out;
}

function readDecisionEvents(startMs, endMs) {
  if (!existsSync(EVENTS_FILE)) {
    return [];
  }
  // Stream-aware enough for our scale: file reads in <100ms typically.
  const lines = readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .filter((l) => l.length);
  const out = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      const ts = parseTs(ev.ts);
      if (!ts || ts < startMs || ts > endMs) {
        continue;
      }
      if (typeof ev.type === "string" && ev.type.startsWith("chuck.decision.")) {
        out.push({ ts: ev.ts, type: ev.type, source: ev.source ?? null });
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function shortLine(task) {
  const title = (task.title ?? "").replace(/\s+/g, " ").trim();
  return title.length > 90 ? title.slice(0, 87) + "..." : title;
}

function computeDigest(now = new Date()) {
  const win = computeWindow(now);
  const tasks = loadTasks();
  const dayMs = 24 * 60 * 60 * 1000;

  const shipped = tasks.filter(
    (t) =>
      ["completed", "done", "closed", "shipped", "succeeded"].includes(t.status) &&
      t.finishedAt &&
      t.finishedAt >= win.startMs &&
      t.finishedAt <= win.endMs,
  );

  const blockers = tasks.filter(
    (t) =>
      (t.status === "blocked" || t.status === "failed") &&
      (t.updatedAt ?? 0) >= win.startMs &&
      (t.updatedAt ?? 0) <= win.endMs,
  );

  const decisions = readDecisionEvents(win.startMs, win.endMs);

  const explicitAwaiting = tasks.filter(
    (t) =>
      t.status === "pending" &&
      (t.awaiting === "joseph" || t.awaiting === true || t.raw.awaitingOperator === true),
  );
  const awaiting =
    explicitAwaiting.length > 0
      ? explicitAwaiting
      : tasks.filter(
          (t) => t.status === "pending" && t.createdAt && now.getTime() - t.createdAt > dayMs,
        );

  return { window: win, shipped, blockers, decisions, awaiting };
}

function fmtMarkdown(d) {
  const date = new Date(d.window.endMs).toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# Chuck morning digest - ${date}`);
  lines.push("");
  lines.push(`Window: ${d.window.startIso} -> ${d.window.endIso}`);
  lines.push("");
  lines.push(`**Shipped (${d.shipped.length}):**`);
  if (d.shipped.length === 0) {
    lines.push("  (none)");
  }
  for (const t of d.shipped.slice(0, 8)) {
    lines.push(`  - ${shortLine(t)}`);
  }
  lines.push("");
  lines.push(`**Blockers / failed (${d.blockers.length}):**`);
  if (d.blockers.length === 0) {
    lines.push("  (none)");
  }
  for (const t of d.blockers.slice(0, 8)) {
    lines.push(`  - [${t.status}] ${shortLine(t)}`);
  }
  lines.push("");
  lines.push(`**Decisions auto-applied (${d.decisions.length}):**`);
  if (d.decisions.length === 0) {
    lines.push("  (none)");
  }
  for (const e of d.decisions.slice(0, 8)) {
    lines.push(`  - ${e.type}`);
  }
  lines.push("");
  lines.push(`**Awaiting Joseph (${d.awaiting.length}):**`);
  if (d.awaiting.length === 0) {
    lines.push("  (none)");
  }
  for (const t of d.awaiting.slice(0, 8)) {
    lines.push(`  - ${shortLine(t)}`);
  }
  return lines.join("\n");
}

function fmtBanner(d) {
  const banner = `Chuck digest: ${d.shipped.length} shipped, ${d.blockers.length} blocked, ${d.decisions.length} decisions, ${d.awaiting.length} awaiting Joseph`;
  return banner.length > BANNER_MAX ? banner.slice(0, BANNER_MAX - 3) + "..." : banner;
}

function fmtJson(d) {
  return {
    ts: new Date().toISOString(),
    window: { startIso: d.window.startIso, endIso: d.window.endIso },
    counts: {
      shipped: d.shipped.length,
      blockers: d.blockers.length,
      decisions: d.decisions.length,
      awaiting: d.awaiting.length,
    },
    shipped: d.shipped.map((t) => ({ id: t.id, title: shortLine(t) })),
    blockers: d.blockers.map((t) => ({ id: t.id, status: t.status, title: shortLine(t) })),
    decisions: d.decisions,
    awaiting: d.awaiting.map((t) => ({ id: t.id, title: shortLine(t) })),
  };
}

// Migrated 2026-05-01: post via `openclaw message send` instead of raw Telegram
// bot API. The openclaw-native path enrolls every digest in the notification
// ledger, emits a bus event, picks up Herald's attention-tier routing, and
// participates in the gating-taxonomy. Falls back to raw bot API only if the
// openclaw subprocess fails (preserves availability during gateway issues).
async function postToTelegram(text) {
  const { spawn } = await import("node:child_process");
  const node = process.execPath;
  const openclawCli = "/Users/josephmatsiko/Projects/openclaw/dist/index.js";

  // Try the openclaw-native path first.
  const native = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(
      node,
      [
        openclawCli,
        "message",
        "send",
        "--channel",
        "telegram",
        "--target",
        TELEGRAM_CHAT_ID,
        "--message",
        text,
        "--silent",
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, reason: "timeout" });
    }, 30_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, reason: `exit ${code}`, stderr: stderr.slice(-500) });
        return;
      }
      try {
        // Parse the JSON envelope `openclaw message send --json` emits at the end of stdout.
        const lastBrace = stdout.lastIndexOf("\n{");
        const payloadJson = lastBrace >= 0 ? stdout.slice(lastBrace).trim() : stdout.trim();
        const payload = JSON.parse(payloadJson);
        const ok = payload?.payload?.ok === true;
        resolve({ ok, payload });
      } catch (err) {
        resolve({ ok: false, reason: `parse ${err?.message ?? err}`, stdout: stdout.slice(-500) });
      }
    });
  });

  if (native.ok) {
    process.stderr.write(
      `[telegram] sent via openclaw message send (msg ${native.payload?.payload?.messageId ?? "?"})\n`,
    );
    return true;
  }

  // Fall back to raw bot API if openclaw native failed (network / gateway / config issue).
  process.stderr.write(
    `[telegram] openclaw send failed (${native.reason ?? "?"}); falling back to raw bot API\n`,
  );

  const cfg = readJson(OPENCLAW_CFG, {});
  const token = cfg?.channels?.telegram?.botToken;
  if (!token) {
    process.stderr.write("[telegram] no botToken in openclaw.json; skipping post\n");
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      process.stderr.write(`[telegram] fallback non-2xx ${r.status}: ${txt.slice(0, 200)}\n`);
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(`[telegram] fallback failed: ${err?.message ?? err}\n`);
    return false;
  }
}

function writeReceipt(d, emitted) {
  if (!existsSync(DIGEST_DIR)) {
    try {
      mkdirSync(DIGEST_DIR, { recursive: true });
    } catch {
      /* nbd */
    }
  }
  const date = new Date(d.window.endMs).toISOString().slice(0, 10).replace(/-/g, "");
  const path = join(DIGEST_DIR, `digest-${date}.json`);
  const payload = {
    ...fmtJson(d),
    emitted: {
      markdown: emitted.markdown ?? null,
      banner: emitted.banner ?? null,
      telegramPosted: emitted.telegramPosted ?? null,
    },
    receiptPath: path,
  };
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`[receipt] write failed: ${err?.message ?? err}\n`);
  }
  return path;
}

async function main() {
  const d = computeDigest();
  const md = fmtMarkdown(d);
  const banner = fmtBanner(d);

  if (FORMAT === "json") {
    const out = fmtJson(d);
    writeReceipt(d, { markdown: md, banner, telegramPosted: false });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }
  if (FORMAT === "telegram") {
    writeReceipt(d, { markdown: md, banner, telegramPosted: false });
    process.stdout.write(md + "\n");
    return 0;
  }
  if (FORMAT === "banner") {
    writeReceipt(d, { markdown: md, banner, telegramPosted: false });
    process.stdout.write(banner + "\n");
    return 0;
  }

  // default: stdout + telegram post (best-effort)
  process.stdout.write(md + "\n");
  const posted = await postToTelegram(md);
  writeReceipt(d, { markdown: md, banner, telegramPosted: posted });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[fatal] ${err?.stack ?? err}\n`);
    process.exit(1);
  });
