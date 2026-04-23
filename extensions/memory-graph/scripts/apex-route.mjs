#!/usr/bin/env node
// Apex Route — the single front door to the Sovereign Apex.
//
// Super intelligent + intuitive: takes a natural-language request in any
// form Joseph types, reads his durable memory + recent open loops to
// ground in what he already knows, classifies intent, selects the right
// subordinate worker based on task shape + worker health + Pro-block
// realities, dispatches, and returns a tight Apex-style result.
//
// Intent classes:
//   brief            — morning-brief subordinate (short personal synthesis)
//   magazine         — magazine subordinate for a named edition
//   deep-research    — twin-worker research on a topic
//   vanguard         — trigger apex-vanguard stages (or summarize last run)
//   status           — worker health + recent editions + flagged items
//   ask              — single-turn Q&A, memory-grounded, routed to best model
//   remember         — store a typed claim in memory-graph
//   recall           — semantic recall from memory-graph
//
// Usage:
//   node apex-route.mjs "what happened in Uganda this week"
//   node apex-route.mjs --json "what's on my plate tomorrow"
//   node apex-route.mjs "dig deeper on the Sovereignty Bill" --items 8
//
// The router never fails hard — if intent is ambiguous, it routes to
// `ask` with a memory-primed prompt, which beats silence.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatch } from "./apex-dispatch.mjs";
import { withPolicy } from "./apex-policy.mjs";
import { deepResearchBeat } from "./deep-research.mjs";
import { askAiStudioChat } from "./research-aistudio-chat.mjs";
import { askChatGPTChat } from "./research-chatgpt-chat.mjs";
import { askClaudeAiChat } from "./research-claude-ai-chat.mjs";
import { askGrokChat } from "./research-grok-chat.mjs";
import { askPerplexityChat } from "./research-perplexity-chat.mjs";
import { probeAll, isHealthy } from "./worker-probe.mjs";

const HOME = homedir();
const DB_PATH = join(HOME, ".openclaw", "memory", "graph.sqlite");
const WORKSPACE = join(HOME, ".openclaw", "workspace");

// ---- intent classification ---------------------------------------------

// Heuristic classifier — fast, no LLM hop. If it truly can't decide, it
// falls through to `ask` (which still memory-grounds the answer).
function classifyIntent(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase();
  if (!t) {
    return { intent: "status", confidence: "high" };
  }
  // Explicit verbs first.
  if (/^brief\b|morning brief|daily brief/.test(t)) {
    return { intent: "brief", confidence: "high" };
  }
  if (/^magazine\b|the world this week|weekly issue/.test(t)) {
    return { intent: "magazine", confidence: "high" };
  }
  if (/^(deep ?research|research)\b|dig deeper|dig into|investigate|cover this beat/.test(t)) {
    return { intent: "deep-research", confidence: "high" };
  }
  if (/^vanguard\b|nightly audit|audit the apex|run the vanguard/.test(t)) {
    return { intent: "vanguard", confidence: "high" };
  }
  if (/^status\b|apex status|health check|workers? (health|status)|probe/.test(t)) {
    return { intent: "status", confidence: "high" };
  }
  if (/^remember\b|^note\b|^save\b|^record\b/.test(t)) {
    return { intent: "remember", confidence: "high" };
  }
  if (/^recall\b|^what do i know\b|^tell me about me and\b/.test(t)) {
    return { intent: "recall", confidence: "high" };
  }
  // News-shaped cues → deep-research.
  if (
    /news|this week|last 7 days|latest|recent developments|what's happening|happened (this|last)/.test(
      t,
    )
  ) {
    return { intent: "deep-research", confidence: "medium" };
  }
  return { intent: "ask", confidence: "low" };
}

// ---- memory grounding --------------------------------------------------

function loadPinnedClaims({ limit = 20 } = {}) {
  if (!existsSync(DB_PATH)) {
    return [];
  }
  const db = new DatabaseSync(DB_PATH);
  try {
    const rows = db
      .prepare(
        `SELECT kind, summary, confidence, updated_at FROM nodes
           WHERE kind IN ('fact','preference','constraint','open-loop','entity')
             AND scope = 'workspace' AND scope_id = 'default'
           ORDER BY updated_at DESC
           LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      kind: String(r.kind),
      summary: String(r.summary ?? "").slice(0, 220),
      confidence: Number(r.confidence ?? 0),
    }));
  } finally {
    db.close();
  }
}

function loadRecentSummaries({ days = 3 } = {}) {
  const dir = join(WORKSPACE, "memory", "summaries");
  if (!existsSync(dir)) {
    return [];
  }
  const summaries = [];
  const today = new Date();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const path = join(dir, `${ymd}.md`);
    if (existsSync(path)) {
      summaries.push({ date: ymd, body: readFileSync(path, "utf8").slice(0, 3000) });
    }
  }
  return summaries;
}

// ---- worker selection (adaptive) ---------------------------------------

function _pickAskModel({ heavy: _heavy = false } = {}) {
  // Top-tier by default, regardless of perceived task size. Max covers
  // Opus unlimited; there's no reason to downgrade routine queries.
  return { bin: "claude", model: "opus", fallback: "sonnet" };
}

// ---- callers -----------------------------------------------------------

function spawnCli(bin, args, { timeoutMs = 240_000, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(stdout.trim());
    });
    if (stdin) {
      child.stdin.end(stdin, "utf8");
    }
  });
}

function buildAskPrompt({ text, claims, summaries, role }) {
  return [
    `You are a subordinate worker under the Sovereign Apex Gateway, synthesizing for Joseph Matsiko.`,
    `Worker role: ${role}. The Gateway is dispatching multiple workers in parallel and will merge your output with the other worker's in a final synthesis pass.`,
    ``,
    `CORE DIRECTIVE: answer his request tightly. Use his durable memory + recent summaries to ground the answer in what he already knows and values — do NOT repeat things he's already logged. Flag anything genuinely new.`,
    ``,
    `=== DURABLE CLAIMS (facts, preferences, constraints, open loops) ===`,
    claims.length ? claims.map((c) => `- [${c.kind}] ${c.summary}`).join("\n") : "(none)",
    ``,
    `=== RECENT DAILY SUMMARIES ===`,
    summaries.length ? summaries.map((s) => `--- ${s.date} ---\n${s.body}`).join("\n\n") : "(none)",
    ``,
    `=== JOSEPH'S REQUEST ===`,
    text,
    ``,
    `Answer in Apex style: telegraph, no filler, specific, American spelling. If the request is ambiguous, state what you're interpreting it as, then answer. No emojis.`,
  ].join("\n");
}

async function askClaudeOpus({ prompt }) {
  return await spawnCli("claude", [
    "-p",
    prompt,
    "--model",
    "opus",
    "--fallback-model",
    "sonnet",
    "--output-format",
    "text",
    "--allowedTools",
    "WebSearch,WebFetch,Read,Grep,Glob",
  ]);
}

async function askGeminiPro({ prompt }) {
  // Gemini CLI in OAuth mode — Pro first, cascades on quota exhaustion.
  // We try Pro 3.1 → 2.5 Pro in sequence; beyond that we skip (Flash is
  // not competitive with Opus for ask-intent conversational synthesis).
  const models = ["gemini-3.1-pro-preview", "gemini-2.5-pro"];
  const errs = [];
  for (const m of models) {
    try {
      const out = await spawnCli(
        "gemini",
        ["-p", prompt, "--model", m, "--output-format", "text"],
        {
          timeoutMs: 120_000,
        },
      );
      return { text: out, modelUsed: `gemini-cli/${m}` };
    } catch (err) {
      errs.push(`${m} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`gemini ask chain exhausted: ${errs.join(" | ")}`);
}

async function handleAsk({ text, claims, summaries, single = false }) {
  if (single) {
    const prompt = buildAskPrompt({ text, claims, summaries, role: "solo" });
    const out = await askClaudeOpus({ prompt });
    return { intent: "ask", mode: "single", answer: out, workersUsed: ["claude-opus"] };
  }
  // Default: N-plex dispatch (Claude Opus + Gemini Pro + ChatGPT Plus +
  // Perplexity Pro) + Opus synthesis. Each worker sees the grounded
  // prompt so per-worker answers are already memory-aware; the
  // synthesis step gets the same grounding plus the witnesses.
  const groundedPrompt = buildAskPrompt({ text, claims, summaries, role: "n-plex" });
  // Dynamic worker list — each entry describes how to reach a frontier
  // model. Health-gated at dispatch time (skip workers whose probe is
  // DOWN) and policy-wrapped so tier-swaps are never silent.
  const health = await probeAll({ forceRefresh: false });
  const workerCatalog = [
    {
      id: "claude-opus",
      probeKey: "claude",
      policyTarget: "claude-opus-4-7",
      ask: async ({ prompt }) =>
        withPolicy({ target: "claude-opus-4-7", prompt }, async ({ prompt }) => ({
          text: await askClaudeOpus({ prompt }),
          modelUsed: "claude-cli/claude-opus-4-7",
        })),
    },
    {
      id: "gemini-pro",
      probeKey: "gemini",
      policyTarget: "gemini-3.1-pro-preview",
      ask: async ({ prompt }) =>
        withPolicy(
          { target: "gemini-3.1-pro-preview", prompt },
          async ({ prompt }) => await askGeminiPro({ prompt }),
        ),
    },
    {
      id: "chatgpt-plus",
      probeKey: "chatgpt",
      policyTarget: "gpt-5",
      ask: async ({ prompt }) =>
        withPolicy(
          { target: "gpt-5", prompt },
          async ({ prompt }) => await askChatGPTChat({ prompt }),
        ),
    },
    {
      id: "perplexity-pro",
      probeKey: "perplexity",
      policyTarget: "perplexity-pro",
      ask: async ({ prompt }) =>
        withPolicy(
          { target: "perplexity-pro", prompt },
          async ({ prompt }) => await askPerplexityChat({ prompt }),
        ),
    },
    {
      id: "claude-ai",
      probeKey: "claude-ai",
      policyTarget: "claude-opus-via-claude-ai",
      ask: async ({ prompt }) =>
        withPolicy(
          { target: "claude-opus-via-claude-ai", prompt },
          async ({ prompt }) => await askClaudeAiChat({ prompt }),
        ),
    },
    {
      id: "aistudio",
      probeKey: "aistudio",
      policyTarget: "gemini-3.1-pro-webchat",
      ask: async ({ prompt }) =>
        withPolicy(
          { target: "gemini-3.1-pro-webchat", prompt },
          async ({ prompt }) => await askAiStudioChat({ prompt }),
        ),
    },
    {
      id: "grok",
      probeKey: "grok",
      ask: async ({ prompt }) => await askGrokChat({ prompt }),
    },
  ];
  const workers = workerCatalog.filter((w) => isHealthy(health, w.probeKey));
  if (workers.length === 0) {
    throw new Error(`handleAsk: no healthy workers — health=${JSON.stringify(health)}`);
  }
  const result = await dispatch({
    prompt: groundedPrompt,
    workers,
    merge: "synthesize",
    synthesisContext: {
      claims,
      summaries,
      meta: `Joseph's raw request (before grounding): ${text}`,
    },
  });
  return {
    intent: "ask",
    mode: result.mode,
    answer: result.answer,
    workersUsed: result.workersUsed,
    errors: result.errors.length ? result.errors : undefined,
  };
}

async function handleDeepResearch({ text, items = 5, deep = false }) {
  // Strip imperative prefixes so the beat is the actual topic.
  const beat = text
    .replace(/^(dig ?deeper on|research|deep ?research|investigate|cover this beat[:]?)\s*/i, "")
    .trim();
  const res = await deepResearchBeat(beat, { items, deep });
  return {
    intent: "deep-research",
    beat,
    confidence: res.confidence,
    workersUsed: res.workersUsed,
    cached: Boolean(res.cached),
    consensus: res.consensus.length,
    divergences: res.divergences.length,
    deep,
    deepEnriched: res.deepDominance?.enriched ?? 0,
    unified: res.unified,
  };
}

async function handleStatus() {
  const health = await probeAll({ forceRefresh: false });
  return {
    intent: "status",
    workers: health,
    summary: Object.entries(health)
      .map(([k, v]) => `${k}=${v.healthy ? "READY" : "DOWN"}(${v.latencyMs}ms)`)
      .join("  "),
  };
}

// ---- main dispatcher ---------------------------------------------------

export async function route(
  text,
  { items = 5, asJson: _asJson = false, single = false, deep = false } = {},
) {
  const { intent, confidence: _confidence } = classifyIntent(text);
  const health = await probeAll({ forceRefresh: false });
  const claims = loadPinnedClaims();
  const summaries = loadRecentSummaries();
  if (intent === "status") {
    return await handleStatus();
  }
  if (intent === "deep-research") {
    return await handleDeepResearch({ text, items, deep });
  }
  if (intent === "brief") {
    return {
      intent: "brief",
      dispatch:
        "Run `node extensions/memory-graph/scripts/morning-brief.mjs --send` (or omit --send for dry run).",
      workers: health,
    };
  }
  if (intent === "magazine") {
    const edition =
      text.match(/\b(daily|friday|weekend|sunday)\b/i)?.[1]?.toLowerCase() ?? "sunday";
    return {
      intent: "magazine",
      edition,
      dispatch: `Run \`node extensions/memory-graph/scripts/magazine.mjs --edition ${edition} --apply\``,
    };
  }
  if (intent === "vanguard") {
    return {
      intent: "vanguard",
      dispatch: "Run `node extensions/memory-graph/scripts/apex-vanguard.mjs`",
    };
  }
  if (intent === "remember" || intent === "recall") {
    return {
      intent,
      note: "Use memory-graph MCP tools directly (memory_store / memory_semantic_search); Apex Route refuses to mutate memory implicitly.",
    };
  }
  // Default: ask — twin dispatch (Claude Opus + Gemini Pro) + synthesis.
  // Override with single=true for quick factual lookups.
  return await handleAsk({ text, claims, summaries, single });
}

// ---- CLI ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { items: 5, asJson: false, single: false, deep: false, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--json") {
      out.asJson = true;
    } else if (t === "--single") {
      out.single = true;
    } else if (t === "--deep") {
      out.deep = true;
    } else if (t === "--items") {
      out.items = Number.parseInt(argv[i + 1] ?? "5", 10);
      i += 1;
    } else if (t === "-h" || t === "--help") {
      console.log(
        "usage: apex-route.mjs [--json] [--items N] [--single] [--deep] <natural-language request>",
      );
      process.exit(0);
    } else {
      out.positional.push(t);
    }
  }
  return out;
}

async function mainCli() {
  const args = parseArgs(process.argv.slice(2));
  const text = args.positional.join(" ").trim();
  if (!text) {
    console.error('error: pass a request, e.g. apex-route.mjs "what happened in Uganda this week"');
    process.exit(2);
  }
  const result = await route(text, { items: args.items, single: args.single, deep: args.deep });
  if (args.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // Human-readable Apex style.
  console.log(`# Intent: ${result.intent}`);
  if (result.answer) {
    console.log("");
    console.log(result.answer);
    return;
  }
  if (result.intent === "status") {
    console.log(result.summary);
    return;
  }
  if (result.intent === "deep-research") {
    console.log(
      `beat=${result.beat} · confidence=${result.confidence} · workers=${result.workersUsed.join(",")}${result.cached ? " (cached)" : ""}`,
    );
    for (const it of result.unified ?? []) {
      const mark = it.sources.length >= 2 ? "★" : "·";
      console.log(`  ${mark} ${it.title} — ${it.summary} (${it.source}) → ${it.url}`);
    }
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-route] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
