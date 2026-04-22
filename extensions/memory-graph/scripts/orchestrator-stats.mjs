#!/usr/bin/env node
// Layer-5 Orchestrator — retrospective stats.
//
// Runs the heuristic classifier over every thread / thread_archive node in
// the memory graph and reports the tier distribution. Tells you, before you
// commit to Phase 3c gateway wiring, roughly what share of your real turns
// would route to Flash / Pro / Opus.
//
// Two outputs:
//   1. Tier distribution table (count + percentage)
//   2. Signals table (which rule fired most often — helpful for tuning)
//
// Usage:
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs --kind thread
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs --since 2026-04-01
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs --sample 5
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs --json
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs --llm-fallback          # call Gemini Flash on heuristic-miss rows
//   node extensions/memory-graph/scripts/orchestrator-stats.mjs --llm-fallback --concurrency 8

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Classifier (inlined to keep this script stdlib-only). Mirror of
// src/orchestrator.ts + the inline copy in mcp-server.mjs.
const ROUTING_TIER_TO_MODEL = {
  trivial: "gemini-2.5-flash",
  contextual: "gemini-2.5-pro",
  complex: "claude-opus-4-7",
};

const ROUTING_RE_CODE =
  /```|\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=|\bdef\s+\w+\s*\(|\bclass\s+\w+\s*[({]/i;
const ROUTING_RE_MEMORY_MUTATING =
  /\b(remember\s+(that|this)|please\s+(note|remember)|don'?t\s+let\s+me\s+forget|i\s+just\s+realized|actually,?\s+i)\b/i;
const ROUTING_RE_ENG_VERB =
  /\b(implement|refactor|debug|architect|migrate|benchmark|profile|deploy|optimize|design|review|build\s+me|write\s+a|fix|diagnose|ship|land|wire|hook|integrate)\b/i;
const ROUTING_RE_ACK =
  /^(hi+|hey+|hello|yo|sup|thanks|thank\s+you|ty|ok+|okay|sure|cool|nice|alright|got\s+it|noted|perfect|great|awesome|yes|no|yep|nope|yeah)[\s\W]*$/i;
const ROUTING_RE_RECALL =
  /\b(what\s+(did|do)\s+(i|we)\s+(talk|say|mention|discuss|cover|decide)|remind\s+me\s+(what|who|when|where|why)|summar(ize|y|ise)|what'?s\s+in\s+my\s+(memory|graph|notes))\b/i;

// ---- LLM fallback ----

const AUTH_PROFILES_PATH = join(
  homedir(),
  ".openclaw",
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);

function loadGeminiKey() {
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const data = JSON.parse(raw);
    const key = data?.profiles?.["google:default"]?.key;
    return typeof key === "string" && key.length > 20 ? key : "";
  } catch {
    return "";
  }
}

function buildClassifierPrompt(text) {
  return [
    "You are a routing classifier for a personal AI assistant.",
    "",
    "Classify the user's message into exactly ONE tier:",
    '- trivial: greetings, acks, one-word replies, echo-style instructions (e.g. "reply with FLASH"), very short factual questions',
    "- contextual: memory-recall questions, short factual questions with real content, simple clarifications",
    "- complex: code, architecture, memory-mutating statements, multi-step tasks, long messages, genuinely ambiguous content",
    "",
    "Output ONLY the tier word, lowercase. No punctuation, no explanation, no quotes.",
    "",
    "Message:",
    "<<<",
    text.trim(),
    ">>>",
  ].join("\n");
}

function normalizeTierLLM(raw) {
  const lower = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?"'`]/g, "");
  if (lower.includes("trivial")) {
    return "trivial";
  }
  if (lower.includes("contextual")) {
    return "contextual";
  }
  if (lower.includes("complex")) {
    return "complex";
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyOnce(text, apiKey, model, timeoutMs) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const body = {
    contents: [{ role: "user", parts: [{ text: buildClassifierPrompt(text) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 32,
      ...(/^gemini-2\.5/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const raw = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (!raw) {
      return { ok: false, status: 200, reason: "empty-response" };
    }
    const tier = normalizeTierLLM(raw);
    if (!tier) {
      return { ok: false, status: 200, reason: `unrecognized:${raw.slice(0, 24)}` };
    }
    return { ok: true, tier };
  } catch (err) {
    const name =
      err?.name === "AbortError" ? "timeout" : (err?.message ?? "fetch-error").slice(0, 48);
    return { ok: false, status: 0, reason: name };
  } finally {
    clearTimeout(timer);
  }
}

// Retry on 429 / 5xx with exponential backoff. Free-tier RPM limits are low,
// so a one-shot retrospective can sustain them only with per-call retries.
async function classifyTextByLLM(
  text,
  apiKey,
  { model = "gemini-2.5-flash", timeoutMs = 4000, maxRetries = 4 } = {},
) {
  if (!apiKey) {
    return { tier: "complex", signals: ["llm-fallback-failed", "no-api-key"] };
  }
  let lastReason = "unknown";
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const r = await classifyOnce(text, apiKey, model, timeoutMs);
    if (r.ok) {
      return { tier: r.tier, signals: ["llm-classifier"] };
    }
    lastReason = r.reason;
    const isTransient =
      r.status === 429 ||
      r.status === 500 ||
      r.status === 502 ||
      r.status === 503 ||
      r.status === 504 ||
      r.status === 0;
    if (!isTransient || attempt === maxRetries) {
      break;
    }
    // Exponential backoff with jitter. 429 at concurrency=1 + ~1.5s wait
    // keeps us under 60 RPM which is inside the Flash free-tier envelope.
    const backoffMs = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
    await sleep(backoffMs);
  }
  return { tier: "complex", signals: ["llm-fallback-failed", lastReason] };
}

// Bounded-concurrency parallel runner. Resolves to an array of results in
// input order. If any worker throws, it propagates — but classifyTextByLLM
// swallows its own errors so this shouldn't happen in practice.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function classify(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return { tier: "trivial", signals: ["empty"] };
  }
  if (ROUTING_RE_CODE.test(trimmed)) {
    return { tier: "complex", signals: ["code-markers"] };
  }
  if (ROUTING_RE_MEMORY_MUTATING.test(trimmed)) {
    return { tier: "complex", signals: ["memory-mutating"] };
  }
  if (ROUTING_RE_ENG_VERB.test(trimmed)) {
    return { tier: "complex", signals: ["engineering-verb"] };
  }
  const lineCount = trimmed.split(/\n/).length;
  const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 2).length;
  if (trimmed.length > 500 || lineCount > 4 || sentenceCount > 5) {
    return { tier: "complex", signals: ["length"] };
  }
  if (ROUTING_RE_RECALL.test(trimmed)) {
    return { tier: "contextual", signals: ["memory-recall-question"] };
  }
  if (ROUTING_RE_ACK.test(trimmed)) {
    return { tier: "trivial", signals: ["ack-or-greeting"] };
  }
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 4 && trimmed.endsWith("?")) {
    return { tier: "trivial", signals: ["very-short-question"] };
  }
  if (sentenceCount === 1 && trimmed.endsWith("?") && wordCount <= 20) {
    return { tier: "contextual", signals: ["short-question"] };
  }
  return { tier: "complex", signals: ["heuristic-miss"] };
}

// ---- args ----

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out.flags[key] = true;
    } else {
      out.flags[key] = next;
      i += 1;
    }
  }
  return out.flags;
}

const HOME = homedir();
const flags = parseArgs(process.argv.slice(2));
const DB_PATH =
  typeof flags.db === "string" ? flags.db : join(HOME, ".openclaw", "memory", "graph.sqlite");
const KIND_FILTER = typeof flags.kind === "string" ? flags.kind : null; // "thread" or "thread_archive" or null (both)
const SINCE_YMD = typeof flags.since === "string" ? flags.since : null; // "YYYY-MM-DD" local
const SAMPLE_PER_TIER = flags.sample === true ? 3 : Number.parseInt(flags.sample, 10) || 0;
const AS_JSON = flags.json === true;
const USE_LLM =
  flags["llm-fallback"] === true || flags.llm === true || flags["llm-fallback"] === "true";
// Concurrency 2 + per-call retry is a safe default against the Flash free-
// tier's RPM cap. Crank it up for paid tier / high-RPM keys.
const CONCURRENCY =
  Number.parseInt(flags.concurrency, 10) > 0 ? Number.parseInt(flags.concurrency, 10) : 2;
const LLM_MAX =
  Number.parseInt(flags["max-llm"], 10) > 0 ? Number.parseInt(flags["max-llm"], 10) : 0;

if (!existsSync(DB_PATH)) {
  console.error(`[orchestrator-stats] graph db not found at ${DB_PATH}`);
  process.exitCode = 1;
  process.exit();
}

const db = new DatabaseSync(DB_PATH);

const clauses = ["kind IN ('thread', 'thread_archive')"];
const params = [];
if (KIND_FILTER) {
  clauses.pop();
  clauses.push("kind = ?");
  params.push(KIND_FILTER);
}
if (SINCE_YMD) {
  const start = new Date(`${SINCE_YMD}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    console.error(`[orchestrator-stats] invalid --since: ${SINCE_YMD}`);
    process.exitCode = 1;
    process.exit();
  }
  clauses.push("updated_at >= ?");
  params.push(start.getTime());
}

const sql = `SELECT kind, summary FROM nodes WHERE ${clauses.join(" AND ")}`;
const rows = db.prepare(sql).all(...params);
db.close();

const tierCounts = { trivial: 0, contextual: 0, complex: 0 };
const signalCounts = {};
const samples = { trivial: [], contextual: [], complex: [] };
const kindBreakdown = {}; // { kind: { tier: count } }
// source[i] ∈ {"heuristic","llm"} per row — so we can report how many
// final tiers came from each classifier path.
const sourceCounts = { heuristic: 0, llm: 0 };

// First pass: heuristic for every row; collect LLM candidates.
const firstPass = rows.map((row) => {
  const v = classify(row.summary ?? "");
  return { row, verdict: v };
});

// LLM pass: re-classify heuristic-miss rows. Bounded concurrency so we
// don't spray 400 in-flight requests at the API on the first retrospective.
if (USE_LLM) {
  const apiKey = loadGeminiKey();
  if (!apiKey) {
    console.error(
      `[orchestrator-stats] --llm-fallback on but no Gemini API key at ${AUTH_PROFILES_PATH}`,
    );
    process.exitCode = 1;
    process.exit();
  }
  let candidates = firstPass.filter(({ verdict }) => verdict.signals.includes("heuristic-miss"));
  if (LLM_MAX > 0 && candidates.length > LLM_MAX) {
    candidates = candidates.slice(0, LLM_MAX);
  }
  const startedAt = Date.now();
  process.stderr.write(
    `[orchestrator-stats] ${candidates.length} heuristic-miss rows → Gemini Flash (concurrency=${CONCURRENCY})\n`,
  );
  const llmResults = await mapWithConcurrency(candidates, CONCURRENCY, async (entry) => {
    const summary = (entry.row.summary ?? "").trim();
    const r = await classifyTextByLLM(summary, apiKey);
    return r;
  });
  const dur = Date.now() - startedAt;
  process.stderr.write(`[orchestrator-stats] LLM pass finished in ${dur}ms\n`);
  // Merge back in-place.
  for (let i = 0; i < candidates.length; i += 1) {
    const target = candidates[i];
    target.verdict = {
      tier: llmResults[i].tier,
      signals: llmResults[i].signals,
    };
  }
}

// Tally.
for (const { row, verdict } of firstPass) {
  tierCounts[verdict.tier] += 1;
  for (const sig of verdict.signals) {
    signalCounts[sig] = (signalCounts[sig] ?? 0) + 1;
  }
  sourceCounts[verdict.signals.includes("llm-classifier") ? "llm" : "heuristic"] += 1;
  if (!kindBreakdown[row.kind]) {
    kindBreakdown[row.kind] = { trivial: 0, contextual: 0, complex: 0 };
  }
  kindBreakdown[row.kind][verdict.tier] += 1;
  if (SAMPLE_PER_TIER > 0 && samples[verdict.tier].length < SAMPLE_PER_TIER) {
    const s = (row.summary ?? "").replace(/\s+/g, " ").trim();
    samples[verdict.tier].push(s.length > 100 ? s.slice(0, 100) + "…" : s);
  }
}

const total = rows.length;

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        total,
        tierCounts,
        signalCounts,
        sourceCounts,
        kindBreakdown,
        samples,
        tierToModel: ROUTING_TIER_TO_MODEL,
        filters: { kind: KIND_FILTER, since: SINCE_YMD, llmFallback: USE_LLM },
      },
      null,
      2,
    ),
  );
  process.exit();
}

function pct(n) {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;
}

console.log(`orchestrator retrospective on ${total} thread rows`);
console.log(
  `  filters: kind=${KIND_FILTER ?? "thread+thread_archive"}, since=${SINCE_YMD ?? "all-time"}, llm-fallback=${USE_LLM ? "on" : "off"}`,
);
if (USE_LLM) {
  console.log(`  source:  heuristic=${sourceCounts.heuristic}  llm=${sourceCounts.llm}`);
}
console.log("");
console.log("TIER        MODEL                  COUNT    SHARE");
for (const tier of ["trivial", "contextual", "complex"]) {
  const count = tierCounts[tier];
  console.log(
    `${tier.padEnd(11)} ${ROUTING_TIER_TO_MODEL[tier].padEnd(22)} ${String(count).padStart(6)}   ${pct(count)}`,
  );
}

if (Object.keys(kindBreakdown).length > 1) {
  console.log("");
  console.log("BY KIND");
  for (const [kind, dist] of Object.entries(kindBreakdown)) {
    const k = kind.padEnd(16);
    console.log(
      `  ${k} trivial=${dist.trivial}  contextual=${dist.contextual}  complex=${dist.complex}`,
    );
  }
}

console.log("");
console.log("TOP SIGNALS (rule that fired first)");
const ranked = Object.entries(signalCounts).toSorted((a, b) => b[1] - a[1]);
for (const [sig, c] of ranked.slice(0, 10)) {
  console.log(`  ${sig.padEnd(32)} ${String(c).padStart(5)}   ${pct(c)}`);
}

if (SAMPLE_PER_TIER > 0) {
  console.log("");
  console.log(`SAMPLES (first ${SAMPLE_PER_TIER} per tier)`);
  for (const tier of ["trivial", "contextual", "complex"]) {
    console.log(`  [${tier}]`);
    for (const s of samples[tier]) {
      console.log(`    • ${s}`);
    }
  }
}

console.log("");
console.log(
  `if every turn had routed: ${pct(tierCounts.trivial)} to Flash, ${pct(tierCounts.contextual)} to Pro, ${pct(tierCounts.complex)} to Opus`,
);
