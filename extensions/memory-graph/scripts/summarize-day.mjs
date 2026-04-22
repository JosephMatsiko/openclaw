#!/usr/bin/env node
// Layer-2 Context summarizer (Bezalel Node).
//
// Reads the last 24h of thread nodes + typed claims from the memory graph
// plus the raw daily-log markdown, hands them to Gemini 2.5 Flash over REST,
// and writes a structured daily summary under
// `~/.openclaw/workspace/memory/summaries/YYYY-MM-DD.md`.
//
// Why REST direct instead of `openclaw infer`:
//   OpenClaw's google-provider backend currently hangs 30s+ on inference
//   calls on this install. Direct REST rides the same API key under 1s and
//   keeps the script stdlib-only.
//
// Usage:
//   node extensions/memory-graph/scripts/summarize-day.mjs
//   node extensions/memory-graph/scripts/summarize-day.mjs --date 2026-04-21
//   node extensions/memory-graph/scripts/summarize-day.mjs --yesterday --prune
//   node extensions/memory-graph/scripts/summarize-day.mjs --model gemini-2.5-pro
//   node extensions/memory-graph/scripts/summarize-day.mjs --scope workspace --scope-id main
//
// Flags:
//   --date YYYY-MM-DD   Day window (local time). Defaults to today. Wins
//                       over --yesterday if both are passed.
//   --yesterday         Shortcut for --date <today minus 1>. Convenience for
//                       schedulers that fire shortly after local midnight.
//   --prune             Delete the consumed 'thread' nodes after the summary
//                       is written. Default is dry-run (no deletes).
//                       Never touches 'thread_archive' rows.
//   --model NAME        Gemini model id. Default: gemini-2.5-flash. On
//                       persistent 503/429 the script falls back through
//                       flash → pro → flash-lite automatically.
//   --scope NAME        Graph scope. Default: workspace.
//   --scope-id ID       Graph scope id. Default: default (matches the
//                       memory-graph plugin's default for workspace scope).
//   --max-threads N     Cap on thread rows sent to the model. Default: 800.
//   --body-chars N      Per-thread body truncation. Default: 500.
//   --retries N         Retry attempts per model on transient failure.
//                       Default: 3.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const HOME = homedir();
const AUTH_PATH = join(HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
const DB_PATH = join(HOME, ".openclaw", "memory", "graph.sqlite");
const WORKSPACE_MEMORY = join(HOME, ".openclaw", "workspace", "memory");
const SUMMARIES_DIR = join(WORKSPACE_MEMORY, "summaries");

// --yesterday is a scheduler convenience. LaunchAgent / cron fires shortly
// after midnight; the interesting window is the calendar day that just ended.
// Explicit --date wins if both are provided.
function resolveDate() {
  if (typeof args.date === "string") {
    return args.date;
  }
  const base = new Date();
  if (args.yesterday === true) {
    base.setDate(base.getDate() - 1);
  }
  return ymdLocal(base);
}

const MODEL = typeof args.model === "string" ? args.model : "gemini-2.5-flash";
// Model chain for 503/429 fallback. The primary is MODEL; if it is already
// in this list we keep its position, otherwise we prepend.
const FALLBACK_CHAIN = dedupe(
  [MODEL, "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"].filter(Boolean),
);
const MAX_RETRIES = toInt(args.retries, 3);
const PRUNE = args.prune === true;
const DATE = resolveDate();
const SCOPE = typeof args.scope === "string" ? args.scope : "workspace";
// memory-graph defaults to scopeId "default" for workspace scope (see
// extensions/memory-graph/index.ts:11). Keep the script's default aligned.
const SCOPE_ID = typeof args["scope-id"] === "string" ? args["scope-id"] : "default";
const MAX_THREADS = toInt(args["max-threads"], 800);
const BODY_CHARS = toInt(args["body-chars"], 500);

// Raw conversation rows ('thread' = live, 'thread_archive' = bulk-imported
// Claude Code history). Both are excluded from the typed-claims pane so the
// summarizer only pulls high-signal nodes (fact/preference/constraint/
// open-loop/entity) into the "Durable claims seen" section.
const RAW_CONVERSATION_KINDS = ["thread", "thread_archive"];

// ---- main ------------------------------------------------------------------

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[summarize-day] fatal: ${msg}`);
  process.exitCode = 1;
});

async function main() {
  const { startMs, endMs } = localDayWindow(DATE);
  log(
    `window ${DATE} local (${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()})`,
  );
  log(`model=${MODEL} prune=${PRUNE} scope=${SCOPE}:${SCOPE_ID}`);

  const apiKey = loadApiKey();

  const db = openDb(DB_PATH);
  try {
    const threads = loadThreads(db, { startMs, endMs, limit: MAX_THREADS });
    const claims = loadClaims(db, { startMs, endMs });
    const dailyLog = loadDailyLog(DATE);
    log(
      `threads=${threads.length} (cap=${MAX_THREADS}) claims=${claims.length} daily_log=${dailyLog ? "yes" : "no"}`,
    );

    if (threads.length === 0 && claims.length === 0 && !dailyLog) {
      log("nothing to summarize for this window — exiting");
      return;
    }

    const prompt = buildPrompt({ date: DATE, threads, claims, dailyLog });
    log(`prompt size ~${approxKb(prompt)}KB`);

    const started = Date.now();
    const { text: summary, modelUsed } = await callGeminiWithFallback(apiKey, prompt);
    log(`gemini ${modelUsed} replied in ${Date.now() - started}ms`);

    const frontmatter = buildFrontmatter({
      date: DATE,
      model: modelUsed,
      scope: SCOPE,
      scopeId: SCOPE_ID,
      threadCount: threads.length,
      claimCount: claims.length,
      hadDailyLog: Boolean(dailyLog),
      pruned: PRUNE,
    });
    const outPath = writeSummary(DATE, frontmatter + summary.trimEnd() + "\n");
    log(`wrote ${relativeToHome(outPath)}`);

    if (PRUNE && threads.length > 0) {
      const n = pruneThreads(db, threads);
      log(`pruned ${n} thread node(s)`);
    } else if (threads.length > 0) {
      log(`dry-run — rerun with --prune to delete the ${threads.length} consumed thread nodes`);
    }
  } finally {
    db.close();
  }
}

// ---- helpers ---------------------------------------------------------------

function log(msg) {
  console.log(`[summarize-day] ${msg}`);
}

function toInt(v, fallback) {
  if (v === undefined || v === true) {
    return fallback;
  }
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDayWindow(ymd) {
  // `new Date("YYYY-MM-DDTHH:mm:ss")` (no Z) parses as local time, which is
  // what we want: the script runs on Joseph's Mac (Central Time per persona).
  const start = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`invalid --date value: ${ymd}`);
  }
  const startMs = start.getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startMs, endMs };
}

function loadApiKey() {
  let raw;
  try {
    raw = readFileSync(AUTH_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read auth-profiles at ${relativeToHome(AUTH_PATH)}: ${err?.message ?? err}`,
      { cause: err },
    );
  }
  const data = JSON.parse(raw);
  const key = data?.profiles?.["google:default"]?.key;
  if (typeof key !== "string" || key.length < 20) {
    throw new Error(`profiles["google:default"].key missing from ${relativeToHome(AUTH_PATH)}`);
  }
  return key;
}

function openDb(path) {
  if (!existsSync(path)) {
    throw new Error(`graph db missing at ${relativeToHome(path)}`);
  }
  return new DatabaseSync(path);
}

function loadThreads(db, { startMs, endMs, limit }) {
  const rows = db
    .prepare(
      `SELECT id, summary, body, source_session_id, source_surface, updated_at
       FROM nodes
       WHERE kind = 'thread'
         AND scope = ?
         AND scope_id = ?
         AND updated_at >= ?
         AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(SCOPE, SCOPE_ID, startMs, endMs, limit);
  return rows.map((r) => ({
    id: String(r.id),
    summary: String(r.summary ?? ""),
    body: String(r.body ?? ""),
    sessionId: r.source_session_id ? String(r.source_session_id) : null,
    surface: r.source_surface ? String(r.source_surface) : null,
    updatedAt: Number(r.updated_at),
  }));
}

function loadClaims(db, { startMs, endMs }) {
  const placeholders = RAW_CONVERSATION_KINDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, kind, summary, body, confidence, source_surface, updated_at
       FROM nodes
       WHERE kind NOT IN (${placeholders})
         AND scope = ?
         AND scope_id = ?
         AND updated_at >= ?
         AND updated_at < ?
       ORDER BY kind ASC, updated_at ASC`,
    )
    .all(...RAW_CONVERSATION_KINDS, SCOPE, SCOPE_ID, startMs, endMs);
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    summary: String(r.summary ?? ""),
    body: r.body ? String(r.body) : null,
    confidence: Number(r.confidence ?? 0),
    surface: r.source_surface ? String(r.source_surface) : null,
    updatedAt: Number(r.updated_at),
  }));
}

function loadDailyLog(ymd) {
  const path = join(WORKSPACE_MEMORY, `${ymd}.md`);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function truncate(s, n) {
  if (s.length <= n) {
    return s;
  }
  return s.slice(0, n) + "…";
}

function buildPrompt({ date, threads, claims, dailyLog }) {
  const lines = [];
  lines.push(
    "You are the Layer-2 Context node for Joseph Matsiko's personal AI stack (Bezalel Node architecture).",
  );
  lines.push("");
  lines.push(
    "Your job: turn one day of raw conversation threads plus typed claims plus a daily freehand log into a structured daily summary that the Layer-1 Memory graph can keep instead of 500+ raw thread rows.",
  );
  lines.push("");
  lines.push("Rules:");
  lines.push("- Write in terse, telegraph-style markdown. No fluff, no filler.");
  lines.push("- Faithfully reflect what is in the inputs. Do not invent facts.");
  lines.push("- If something is ambiguous, say so.");
  lines.push("- Preserve Joseph's voice and priorities; do not soften or sanitize.");
  lines.push("- Do not emit emojis or decorative headers.");
  lines.push('- No hedging boilerplate ("it is important to note", etc.).');
  lines.push("- Use American spelling.");
  lines.push("");
  lines.push(
    "Output sections (emit in this exact order, omit a section cleanly if it has nothing):",
  );
  lines.push("1. ## Summary  — 3-7 bullets: the day's arc in Joseph's language, not mine.");
  lines.push("2. ## Decisions  — concrete choices made and why (bullet per decision).");
  lines.push("3. ## Work landed  — code/config/ops changes that shipped today.");
  lines.push(
    "4. ## Open threads  — explicit TODOs, questions unanswered, things left hanging. Use `- [ ]` checkbox syntax.",
  );
  lines.push(
    "5. ## Durable claims seen  — restate typed claims (facts, preferences, constraints, open-loops) that appeared or were reinforced today. One bullet each.",
  );
  lines.push(
    "6. ## Signal for tomorrow  — 1-3 bullets on what the next session should pick up first.",
  );
  lines.push("");
  lines.push(`Day: ${date}`);
  lines.push("");

  if (dailyLog) {
    lines.push("=== DAILY LOG (freehand markdown written during the day) ===");
    lines.push(dailyLog.trim());
    lines.push("=== END DAILY LOG ===");
    lines.push("");
  }

  if (claims.length > 0) {
    lines.push(`=== TYPED CLAIMS (${claims.length}) ===`);
    for (const c of claims) {
      const body = c.body ? ` — ${truncate(c.body, 240)}` : "";
      lines.push(`- [${c.kind} conf=${c.confidence.toFixed(2)}] ${c.summary}${body}`);
    }
    lines.push("=== END TYPED CLAIMS ===");
    lines.push("");
  }

  if (threads.length > 0) {
    lines.push(`=== THREAD NODES (${threads.length}, chronological) ===`);
    lines.push("Each item: [session / surface] user-summary → assistant-body");
    for (const t of threads) {
      const tag = `${t.sessionId ? t.sessionId.slice(0, 8) : "unknown"}/${t.surface ?? "unknown"}`;
      const u = truncate(t.summary.replace(/\s+/g, " "), BODY_CHARS);
      const a = truncate(t.body.replace(/\s+/g, " "), BODY_CHARS);
      lines.push(`- [${tag}] ${u} → ${a}`);
    }
    lines.push("=== END THREAD NODES ===");
    lines.push("");
  }

  lines.push(
    "Produce the summary now. Start with the first section heading. Do not prefix with any preamble.",
  );
  return lines.join("\n");
}

async function callGeminiWithFallback(apiKey, prompt) {
  const errors = [];
  for (const model of FALLBACK_CHAIN) {
    try {
      const text = await callGeminiWithRetries(apiKey, model, prompt);
      return { text, modelUsed: model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${model}: ${msg}`);
      // Non-retryable errors (auth, 400, etc.) should not cascade. Only try
      // the next model on "overloaded / transient" failures.
      if (!isTransientError(err)) {
        throw new Error(`Gemini ${model} failed (non-transient): ${msg}`, { cause: err });
      }
      log(`fallback: ${model} still failing after retries, trying next model`);
    }
  }
  throw new Error(`all Gemini models in fallback chain failed: ${errors.join(" | ")}`);
}

async function callGeminiWithRetries(apiKey, model, prompt) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await callGemini(apiKey, model, prompt);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === MAX_RETRIES) {
        throw err;
      }
      const backoffMs = 750 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      log(
        `${model} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${shortErr(err)}), retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Gemini 2.5 models default to "thinking" mode where reasoning tokens are
  // also billed against maxOutputTokens. For a structured summarization task
  // like this one we want every output token to be final prose, so we clamp
  // thinkingBudget to 0 for 2.5 models. (The field is silently ignored on
  // older/non-2.5 models, so this is safe.)
  const is25 = /^gemini-2\.5/i.test(model);

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.95,
      maxOutputTokens: 8192,
      ...(is25 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 800)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`Gemini returned no content parts: ${JSON.stringify(data).slice(0, 800)}`);
  }
  const text = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (!text) {
    throw new Error("Gemini returned empty text");
  }
  const finishReason = candidate?.finishReason ?? "unknown";
  const usage = data?.usageMetadata ?? {};
  if (finishReason !== "STOP") {
    log(
      `warning: finishReason=${finishReason} (usage: prompt=${usage.promptTokenCount ?? "?"} output=${usage.candidatesTokenCount ?? "?"} thoughts=${usage.thoughtsTokenCount ?? 0}) — output may be truncated`,
    );
  }
  return text;
}

function isTransientError(err) {
  if (!err) {
    return false;
  }
  const status = err.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /UNAVAILABLE|overload|high demand|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg);
}

function shortErr(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 160);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function buildFrontmatter({
  date,
  model,
  scope,
  scopeId,
  threadCount,
  claimCount,
  hadDailyLog,
  pruned,
}) {
  const generatedAt = new Date().toISOString();
  return [
    "---",
    `date: ${date}`,
    `generated_at: ${generatedAt}`,
    `model: ${model}`,
    `scope: ${scope}`,
    `scope_id: ${scopeId}`,
    "sources:",
    `  threads: ${threadCount}`,
    `  claims: ${claimCount}`,
    `  daily_log: ${hadDailyLog ? "true" : "false"}`,
    `pruned_threads: ${pruned ? "true" : "false"}`,
    "---",
    "",
    `# ${date} — daily summary`,
    "",
  ].join("\n");
}

function writeSummary(date, body) {
  if (!existsSync(SUMMARIES_DIR)) {
    mkdirSync(SUMMARIES_DIR, { recursive: true, mode: 0o700 });
  }
  const path = join(SUMMARIES_DIR, `${date}.md`);
  writeFileSync(path, body, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort; tests run in environments without chmod
  }
  return path;
}

function pruneThreads(db, threads) {
  if (threads.length === 0) {
    return 0;
  }
  const del = db.prepare("DELETE FROM nodes WHERE id = ?");
  let count = 0;
  db.exec("BEGIN");
  try {
    for (const t of threads) {
      const info = del.run(t.id);
      count += Number(info.changes ?? 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return count;
}

function approxKb(s) {
  return Math.round(Buffer.byteLength(s, "utf8") / 1024);
}

function relativeToHome(p) {
  if (p.startsWith(HOME)) {
    return "~" + p.slice(HOME.length);
  }
  return p;
}
