#!/usr/bin/env node
// memory-graph MCP server
//
// Standalone Node process that exposes Joseph's OpenClaw memory-graph SQLite
// store to any MCP-compatible client (Claude Code, Claude Desktop, Cursor).
// Reads and writes the same DB file OpenClaw's gateway writes to, so facts
// captured from Telegram turns show up in Claude Code sessions and vice versa.
//
// Run standalone:
//   node mcp-server.mjs
// Register with Claude Code:
//   claude mcp add memory-graph -- node <abs path to this file>

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// Experimental in Node 22, stable in 24. Matches what the main plugin uses.
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "graph.sqlite");
const DB_PATH = process.env.MEMORY_GRAPH_DB_PATH || DEFAULT_DB_PATH;
const SCOPE = process.env.MEMORY_GRAPH_SCOPE || "workspace";
const SCOPE_ID = process.env.MEMORY_GRAPH_SCOPE_ID || "default";
const WORKSPACE_DIR =
  process.env.MEMORY_GRAPH_WORKSPACE || join(homedir(), ".openclaw", "workspace");
const SELF_EDIT_AUDIT_PATH =
  process.env.MEMORY_GRAPH_SELF_EDIT_AUDIT_PATH ||
  join(WORKSPACE_DIR, "state", "chuck-v2", "memory-self-edit-events.jsonl");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PERSONA_FILES = {
  soul: "SOUL.md",
  identity: "IDENTITY.md",
  user: "USER.md",
  agents: "AGENTS.md",
  tools: "TOOLS.md",
  heartbeat: "HEARTBEAT.md",
  bootstrap: "BOOTSTRAP.md",
  memory: "MEMORY.md",
};
const DEFAULT_PERSONA_FILES = ["soul", "identity", "user", "agents", "memory"];

const NODE_KINDS = /** @type {const} */ ([
  "fact",
  "preference",
  "open-loop",
  "thread",
  "thread_archive",
  "entity",
  "constraint",
]);
// Both raw-conversation kinds are excluded from prompt injection; only
// high-signal claims go into the <user-memory> block.
const RAW_CONVERSATION_KINDS = new Set(["thread", "thread_archive"]);
const INJECTION_KINDS = NODE_KINDS.filter((k) => !RAW_CONVERSATION_KINDS.has(k));

const SCHEMA_VERSION = 5;

const MIGRATIONS = [
  // v1: nodes + edges + metadata.
  `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_session_id TEXT,
    source_session_key TEXT,
    source_entry_id TEXT
  );
  CREATE INDEX IF NOT EXISTS nodes_scope_idx ON nodes (scope, scope_id);
  CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes (kind);
  CREATE INDEX IF NOT EXISTS nodes_updated_idx ON nodes (updated_at DESC);
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    weight REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS edges_from_idx ON edges (from_id);
  CREATE INDEX IF NOT EXISTS edges_to_idx ON edges (to_id);
  CREATE INDEX IF NOT EXISTS edges_kind_idx ON edges (kind);
  `,
  // v2: per-node semantic embedding (384-d Float32 BLOB) + model id.
  `
  ALTER TABLE nodes ADD COLUMN embedding BLOB;
  ALTER TABLE nodes ADD COLUMN embedding_model TEXT;
  `,
  // v3: source_surface — which interface produced this node
  // ('telegram' | 'openclaw-terminal' | 'claude-code' | 'claude-desktop' |
  // 'explicit' | 'unknown'). Lets downstream queries separate "things I
  // discussed on Telegram" from "things I discussed while coding."
  `
  ALTER TABLE nodes ADD COLUMN source_surface TEXT;
  CREATE INDEX IF NOT EXISTS nodes_source_surface_idx ON nodes (source_surface);
  `,
  // v4: split raw thread bulk from bulk-ingested historical transcripts.
  // memory_ingest_claude_code used to write every historical user turn as
  // kind='thread' with ingest-time timestamps, which polluted the Layer-2
  // daily summary window. Relabel those rows as 'thread_archive' so the
  // live-vs-historical boundary is queryable. Keep this aligned with
  // src/schema.ts — same migration must run through both the plugin's
  // SqliteGraphStorage and the standalone MCP server.
  `
  UPDATE nodes
     SET kind = 'thread_archive'
   WHERE kind = 'thread'
     AND source_surface = 'claude-code'
     AND source_session_id LIKE 'cc:%';
  `,
  // v5: origin_label — free-form cohort tag for bulk-purgeable writes.
  // Smoke-test runners, evaluation harnesses, and one-off backfills set
  // process.env.OPENCLAW_MEMORY_ORIGIN_LABEL and every node written during
  // that process inherits the label so after-the-fact cleanup via
  // scripts/memory-purge-by-label.mjs does not need hand-picked ids.
  // Keep in sync with src/schema.ts.
  `
  ALTER TABLE nodes ADD COLUMN origin_label TEXT;
  CREATE INDEX IF NOT EXISTS nodes_origin_label_idx ON nodes (origin_label);
  `,
];

// Rule-based claim extraction, kept in sync with src/extractor.ts. Running
// here too lets Claude Code transcript ingestion mine typed claims from
// user text, not just raw threads. If the TS-side patterns evolve, mirror
// them here — both should see the same signal.
const CLAIM_PATTERNS = [
  {
    kind: "fact",
    regex: /\b(?:please\s+)?remember\s+(?:that\s+)?(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => (m[1] ?? "").trim(),
    confidence: 0.98,
  },
  {
    kind: "fact",
    regex:
      /\bi(?:\s+am|'m)\s+(allergic\s+to|afraid\s+of|from|based\s+in|living\s+in|married\s+to|working\s+(?:at|for)|born\s+in|named)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `I'm ${(m[1] ?? "").trim()} ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.9,
  },
  {
    kind: "fact",
    regex:
      /\b(?:my|our)\s+(name|age|wife|husband|spouse|partner|son|daughter|kid|child|cat|dog|pet|address|phone|email|job|role|title|company|boss|manager|teammate|birthday|deadline)\s+(?:is|are)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `${(m[1] ?? "").trim()} is ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.9,
  },
  {
    kind: "preference",
    regex: /\bmy\s+favorite\s+(\w+(?:\s+\w+)?)\s+(?:is|are)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `favorite ${(m[1] ?? "").trim()}: ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.9,
  },
  {
    kind: "preference",
    regex: /\bi\s+(like|love|adore|enjoy|hate|dislike|prefer)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `${(m[1] ?? "").trim()} ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.75,
  },
  {
    kind: "open-loop",
    regex:
      /\b(?:remind\s+me\s+to|i\s+need\s+to|i\s+have\s+to|i\s+must|don'?t\s+let\s+me\s+forget\s+to|follow\s+up\s+(?:on|about)|todo:)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => (m[1] ?? "").trim(),
    confidence: 0.9,
  },
  {
    kind: "constraint",
    regex: /\bi\s+can'?t\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `can't ${(m[1] ?? "").trim()}`.trim(),
    confidence: 0.6,
  },
  {
    kind: "constraint",
    regex: /\b(?:please\s+)?(?:never|don'?t\s+ever)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `never ${(m[1] ?? "").trim()}`.trim(),
    confidence: 0.7,
  },
];

function extractClaims(text) {
  if (!text || typeof text !== "string") {
    return [];
  }
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const pattern of CLAIM_PATTERNS) {
    for (const m of normalized.matchAll(pattern.regex)) {
      const raw = pattern.format(m);
      const summary = raw.replace(/\s+/g, " ").trim();
      if (summary.length < 2 || summary.length > 200) {
        continue;
      }
      const key = `${pattern.kind}:${summary.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ kind: pattern.kind, summary, confidence: pattern.confidence });
    }
  }
  return out;
}

// ---------- Layer-5 Orchestrator (routing classifier) ----------
//
// Inlined from src/orchestrator.ts to keep this server stdlib-only. If the
// rules diverge, the TS unit tests are authoritative; mirror changes here.

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

function routingVerdict(tier, rationale, confidence, signals, tierToModel) {
  return {
    tier,
    model: (tierToModel ?? ROUTING_TIER_TO_MODEL)[tier],
    rationale,
    confidence,
    signals,
    viaHeuristic: true,
  };
}

// Lazy API-key load for the LLM classifier fallback. Same file the Layer-2
// summarizer uses so a single config surface serves both.
const AUTH_PROFILES_PATH = join(
  homedir(),
  ".openclaw",
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);

let cachedGeminiKey = null;

function loadGeminiKey() {
  if (cachedGeminiKey !== null) {
    return cachedGeminiKey;
  }
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const data = JSON.parse(raw);
    const key = data?.profiles?.["google:default"]?.key;
    cachedGeminiKey = typeof key === "string" && key.length > 20 ? key : "";
  } catch {
    cachedGeminiKey = "";
  }
  return cachedGeminiKey;
}

function buildClassifierPromptText(text) {
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

async function classifyByLLM(text, opts = {}) {
  const apiKey = loadGeminiKey();
  if (!apiKey) {
    return {
      tier: "complex",
      model: ROUTING_TIER_TO_MODEL.complex,
      rationale: "LLM fallback failed (no-api-key); defaulting to complex",
      confidence: 0.5,
      signals: ["llm-fallback-failed", "no-api-key"],
      viaHeuristic: false,
    };
  }
  const model = opts.model ?? "gemini-2.5-flash";
  const timeoutMs = opts.timeoutMs ?? 4000;
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const body = {
    contents: [{ role: "user", parts: [{ text: buildClassifierPromptText(text) }] }],
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
      return classifyLLMFail(`http-${res.status}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const raw = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (!raw) {
      return classifyLLMFail("empty-response");
    }
    const tier = normalizeTierLLM(raw);
    if (!tier) {
      return classifyLLMFail(`unrecognized:${raw.slice(0, 24)}`);
    }
    return {
      tier,
      model: ROUTING_TIER_TO_MODEL[tier],
      rationale: `LLM classifier (${model}) returned "${tier}"`,
      confidence: 0.85,
      signals: ["llm-classifier", `llm-model:${model}`],
      viaHeuristic: false,
    };
  } catch (err) {
    const name =
      err?.name === "AbortError" ? "timeout" : (err?.message ?? "fetch-error").slice(0, 48);
    return classifyLLMFail(name);
  } finally {
    clearTimeout(timer);
  }
}

function classifyLLMFail(reason) {
  return {
    tier: "complex",
    model: ROUTING_TIER_TO_MODEL.complex,
    rationale: `LLM fallback failed (${reason}); defaulting to complex`,
    confidence: 0.5,
    signals: ["llm-fallback-failed", reason],
    viaHeuristic: false,
  };
}

async function classifyMessageWithLLMFallback(text, opts = {}) {
  const v = classifyMessage(text, opts);
  if (!v.signals.includes("heuristic-miss")) {
    return v;
  }
  return classifyByLLM(text, opts);
}

// ---- Route-and-answer (single-turn delegate via Gemini) ----

async function callGeminiForAnswer(
  text,
  model,
  { apiKey, timeoutMs = 15000, maxOutputTokens = 1024, systemPrompt = "" } = {},
) {
  if (!apiKey) {
    return { answer: null, error: "no-api-key" };
  }
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const body = {
    contents: [{ role: "user", parts: [{ text: text.trim() }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens,
      ...(/^gemini-2\.5/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  if (systemPrompt && systemPrompt.trim()) {
    body.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
  }
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
      return { answer: null, error: `http-${res.status}` };
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const raw = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (!raw) {
      return { answer: null, error: "empty-response" };
    }
    return { answer: raw };
  } catch (err) {
    const reason =
      err?.name === "AbortError" ? "timeout" : (err?.message ?? "fetch-error").slice(0, 48);
    return { answer: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// MCP variant: single-turn delegate. For tier=complex, returns
// answeredBy="opus-absent" with answer=null — the calling agent (which is
// already Opus) handles complex turns itself rather than re-invoking Opus
// via a subprocess. This tool only saves Opus quota for trivial/contextual.
async function routeAndAnswerForMcp(
  text,
  { lastAssistantEndedInQuestion = false, systemPrompt = "" } = {},
) {
  const started = Date.now();
  const classifyOpts = { lastAssistantEndedInQuestion };
  const verdict = await classifyMessageWithLLMFallback(text, classifyOpts);
  if (verdict.tier === "trivial" || verdict.tier === "contextual") {
    const model = verdict.tier === "trivial" ? "gemini-2.5-flash" : "gemini-2.5-pro";
    const apiKey = loadGeminiKey();
    const { answer, error } = await callGeminiForAnswer(text, model, {
      apiKey,
      systemPrompt,
    });
    if (answer === null) {
      return {
        verdict: {
          ...verdict,
          signals: [...verdict.signals, `answer-error:${error ?? "unknown"}`],
        },
        answer: null,
        answeredBy: "error",
        latencyMs: Date.now() - started,
        answerModel: model,
      };
    }
    return {
      verdict,
      answer,
      answeredBy: verdict.tier === "trivial" ? "flash" : "pro",
      latencyMs: Date.now() - started,
      answerModel: model,
    };
  }
  // tier=complex: caller (Opus) handles it themselves.
  return {
    verdict,
    answer: null,
    answeredBy: "opus-absent",
    latencyMs: Date.now() - started,
  };
}

function classifyMessage(text, opts = {}) {
  const trimmed = (text ?? "").trim();
  const table = opts.tierToModel;
  if (!trimmed) {
    return routingVerdict("trivial", "empty input", 1, ["empty"], table);
  }
  if (ROUTING_RE_CODE.test(trimmed)) {
    return routingVerdict(
      "complex",
      "contains code or structure markers",
      0.95,
      ["code-markers"],
      table,
    );
  }
  if (ROUTING_RE_MEMORY_MUTATING.test(trimmed)) {
    return routingVerdict("complex", "memory-mutating language", 0.9, ["memory-mutating"], table);
  }
  if (ROUTING_RE_ENG_VERB.test(trimmed)) {
    return routingVerdict("complex", "engineering verb", 0.85, ["engineering-verb"], table);
  }
  const lineCount = trimmed.split(/\n/).length;
  const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 2).length;
  if (trimmed.length > 500 || lineCount > 4 || sentenceCount > 5) {
    return routingVerdict(
      "complex",
      "long or multi-sentence",
      0.8,
      [`length (${trimmed.length} chars, ${lineCount} lines, ${sentenceCount} sentences)`],
      table,
    );
  }
  if (ROUTING_RE_RECALL.test(trimmed)) {
    return routingVerdict(
      "contextual",
      "memory-recall question",
      0.9,
      ["memory-recall-question"],
      table,
    );
  }
  if (opts.lastAssistantEndedInQuestion && trimmed.split(/\s+/).length <= 8) {
    return routingVerdict(
      "contextual",
      "short reply continuing a question thread",
      0.7,
      ["short-reply-to-question"],
      table,
    );
  }
  if (ROUTING_RE_ACK.test(trimmed)) {
    return routingVerdict(
      "trivial",
      "greeting or acknowledgement",
      0.95,
      ["ack-or-greeting"],
      table,
    );
  }
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 4 && trimmed.endsWith("?")) {
    return routingVerdict(
      "trivial",
      "very short question",
      0.75,
      [`very-short-question (${wordCount} words)`],
      table,
    );
  }
  if (sentenceCount === 1 && trimmed.endsWith("?") && wordCount <= 20) {
    return routingVerdict(
      "contextual",
      "short factual question",
      0.7,
      [`short-question (${wordCount} words)`],
      table,
    );
  }
  return routingVerdict(
    "complex",
    "no clear heuristic match; defaulting to complex",
    0.5,
    ["heuristic-miss"],
    table,
  );
}

function openDb() {
  if (DB_PATH !== ":memory:") {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON;");
  if (DB_PATH !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  const currentVersion = row?.version ?? 0;
  // Stop at our declared SCHEMA_VERSION so an older binary never runs a
  // migration that belongs to a newer one.
  const target = Math.min(SCHEMA_VERSION, MIGRATIONS.length);
  for (let i = currentVersion; i < target; i += 1) {
    db.exec(MIGRATIONS[i]);
  }
  if (!row) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version < SCHEMA_VERSION) {
    // Monotonic: advance forward, never regress. If an older binary reopens
    // a future-schema DB it leaves this untouched.
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }
  if (DB_PATH !== ":memory:") {
    try {
      chmodSync(DB_PATH, 0o600);
    } catch {
      // best-effort
    }
  }
  return db;
}

// Singleton embedder. First call pulls ~90MB of model files into
// ~/.cache/openclaw-embeddings (auto-created); after that every query is
// local + instant. No API calls, ever.
let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const t = await import("@xenova/transformers");
      t.env.allowLocalModels = false;
      t.env.cacheDir = join(homedir(), ".cache", "openclaw-embeddings");
      return t.pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true });
    })();
  }
  return embedderPromise;
}

async function embedText(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return new Float32Array(EMBEDDING_DIM);
  }
  const embed = await getEmbedder();
  const out = await embed(trimmed, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

function cosine(a, b) {
  if (a.length !== b.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function deserializeEmbedding(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function nodeContentForEmbedding(summary, body) {
  return body ? `${summary}\n${body}` : summary;
}

function deterministicId(kind, summary) {
  const h = createHash("sha1")
    .update(`${SCOPE}:${SCOPE_ID}:${kind}:${summary.toLowerCase().trim()}`)
    .digest("hex");
  return `${kind}-${h.slice(0, 16)}`;
}

// Env-var default for origin_label. See src/sqlite-storage.ts for the canonical
// implementation; kept in sync here because mcp-server.mjs is the standalone
// path (Claude Code, Claude Desktop) that bypasses the TS storage layer.
function envOriginLabel() {
  const raw = process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rowToNode(row) {
  const hasAnySourceInfo =
    row.source_session_id || row.source_surface || row.source_entry_id || row.origin_label;
  const source = hasAnySourceInfo
    ? {
        sessionId: row.source_session_id ?? "",
        ...(row.source_session_key ? { sessionKey: row.source_session_key } : {}),
        ...(row.source_entry_id ? { entryId: row.source_entry_id } : {}),
        ...(row.source_surface ? { surface: row.source_surface } : {}),
        ...(row.origin_label ? { originLabel: row.origin_label } : {}),
      }
    : undefined;
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    ...(row.body ? { body: row.body } : {}),
    scope: row.scope,
    scopeId: row.scope_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(source ? { source } : {}),
  };
}

const db = openDb();

function recall({ kinds, limit } = {}) {
  const effectiveKinds = Array.isArray(kinds) && kinds.length > 0 ? kinds : INJECTION_KINDS;
  const placeholders = effectiveKinds.map(() => "?").join(",");
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = db
    .prepare(
      `SELECT * FROM nodes
         WHERE scope = ? AND scope_id = ?
           AND kind IN (${placeholders})
         ORDER BY updated_at DESC
         LIMIT ${effectiveLimit}`,
    )
    .all(SCOPE, SCOPE_ID, ...effectiveKinds);
  return rows.map(rowToNode);
}

function search({ query, kinds, limit } = {}) {
  const effectiveKinds = Array.isArray(kinds) && kinds.length > 0 ? kinds : [...NODE_KINDS];
  const placeholders = effectiveKinds.map(() => "?").join(",");
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    return [];
  }
  const like = `%${q}%`;
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  const rows = db
    .prepare(
      `SELECT * FROM nodes
         WHERE scope = ? AND scope_id = ?
           AND kind IN (${placeholders})
           AND (summary LIKE ? OR body LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ${effectiveLimit}`,
    )
    .all(SCOPE, SCOPE_ID, ...effectiveKinds, like, like);
  return rows.map(rowToNode);
}

function store({ summary, kind, body, confidence } = {}) {
  const trimmed = typeof summary === "string" ? summary.trim() : "";
  if (!trimmed) {
    throw new Error("summary is required and must be non-empty");
  }
  const normalizedKind = typeof kind === "string" && NODE_KINDS.includes(kind) ? kind : "fact";
  const normalizedConfidence =
    typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : 0.85;
  const id = deterministicId(normalizedKind, trimmed);
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  // Pull origin_label from OPENCLAW_MEMORY_ORIGIN_LABEL so smoke-test and
  // eval runs can tag every node they store without threading an extra
  // argument through the MCP surface. On upsert, COALESCE preserves an
  // already-stored label when none is supplied this call.
  const effectiveOriginLabel = envOriginLabel();
  if (existing) {
    db.prepare(
      `UPDATE nodes
          SET summary = ?, body = ?, confidence = ?, updated_at = ?,
              origin_label = COALESCE(?, origin_label)
        WHERE id = ?`,
    ).run(trimmed, body ?? null, normalizedConfidence, now, effectiveOriginLabel, id);
  } else {
    db.prepare(
      `INSERT INTO nodes
         (id, kind, summary, body, scope, scope_id, confidence,
          created_at, updated_at, origin_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      normalizedKind,
      trimmed,
      body ?? null,
      SCOPE,
      SCOPE_ID,
      normalizedConfidence,
      now,
      now,
      effectiveOriginLabel,
    );
  }
  return rowToNode(db.prepare("SELECT * FROM nodes WHERE id = ?").get(id));
}

function forget({ id } = {}) {
  if (typeof id !== "string" || !id) {
    throw new Error("id is required");
  }
  const result = db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  return { deleted: result.changes > 0 };
}

async function semanticSearch({ query, kinds, limit, backfillLimit } = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    return [];
  }
  const kindsList =
    Array.isArray(kinds) && kinds.length > 0
      ? kinds.filter((k) => NODE_KINDS.includes(k))
      : [...NODE_KINDS];
  if (kindsList.length === 0) {
    return [];
  }
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
  const effectiveBackfill =
    Number.isInteger(backfillLimit) && backfillLimit > 0 ? Math.min(backfillLimit, 500) : 200;

  // Backfill: any nodes without an embedding for the current model get one
  // now. Bounded so a huge graph doesn't cold-start the first query for
  // 30s; remaining rows are picked up on subsequent searches.
  const missing = db
    .prepare(
      `SELECT id, summary, body
         FROM nodes
        WHERE scope = ? AND scope_id = ?
          AND (embedding IS NULL OR embedding_model IS NOT ?)
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(SCOPE, SCOPE_ID, EMBEDDING_MODEL, effectiveBackfill);
  for (const row of missing) {
    const vec = await embedText(nodeContentForEmbedding(row.summary, row.body ?? ""));
    db.prepare("UPDATE nodes SET embedding = ?, embedding_model = ? WHERE id = ?").run(
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
      EMBEDDING_MODEL,
      row.id,
    );
  }

  const qv = await embedText(q);
  const placeholders = kindsList.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM nodes
         WHERE scope = ? AND scope_id = ?
           AND kind IN (${placeholders})
           AND embedding IS NOT NULL
           AND embedding_model = ?`,
    )
    .all(SCOPE, SCOPE_ID, ...kindsList, EMBEDDING_MODEL);
  const ranked = [];
  for (const row of rows) {
    const vec = deserializeEmbedding(row.embedding);
    const score = cosine(qv, vec);
    ranked.push({ node: rowToNode(row), score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked
    .slice(0, effectiveLimit)
    .map((r) => Object.assign({}, r.node, { similarity: Number(r.score.toFixed(4)) }));
}

// ---------- Persona read/write (SOUL, IDENTITY, USER, etc.) ----------

function resolvePersonaPath(file) {
  const name = PERSONA_FILES[file];
  if (!name) {
    throw new Error(
      `unknown persona file "${file}". valid: ${Object.keys(PERSONA_FILES).join(", ")}`,
    );
  }
  return join(WORKSPACE_DIR, name);
}

function getPersona({ files } = {}) {
  const requested =
    Array.isArray(files) && files.length > 0
      ? files.filter((f) => f in PERSONA_FILES)
      : DEFAULT_PERSONA_FILES;
  const out = { workspaceDir: WORKSPACE_DIR };
  for (const key of requested) {
    const path = resolvePersonaPath(key);
    if (existsSync(path)) {
      out[key] = {
        path,
        content: readFileSync(path, "utf8"),
        bytes: statSync(path).size,
      };
    } else {
      out[key] = { path, content: null, bytes: 0 };
    }
  }
  return out;
}

function setPersona({ file, content, backup = true } = {}) {
  if (!file || !(file in PERSONA_FILES)) {
    throw new Error(
      `file is required and must be one of: ${Object.keys(PERSONA_FILES).join(", ")}`,
    );
  }
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  const path = resolvePersonaPath(file);
  mkdirSync(dirname(path), { recursive: true });
  let backupPath;
  if (backup && existsSync(path)) {
    backupPath = `${path}.bak.${Date.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, content, "utf8");
  return {
    path,
    bytes: Buffer.byteLength(content, "utf8"),
    ...(backupPath ? { backupPath } : {}),
  };
}

// ---------- Self-edit (surgical block-level persona evolution) ----------
// Letta/MemGPT-style self-editing memory, scoped to Joseph's persona files.
// Three operations: append, replace (exact-match substring, must be unique),
// upsert_block (create-or-replace a markdown heading section). Every call
// requires a rationale (>= 8 chars) that lands in the audit bus event.
//
// Gating: this tool is in CRITICAL_TOOL_NAMES. For gateway-dispatched calls
// (Telegram / terminal), the before_tool_call hook honors executionMode.
// For Claude Code / Claude Desktop calls, the host's own permission UI is
// the approval surface. The MCP server itself always applies the edit if
// invoked — the caller is responsible for being permitted.

const SELF_EDIT_OPERATIONS = /** @type {const} */ (["append", "replace", "upsert_block"]);

function computeDiffSummary(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  return {
    before: { lines: beforeLines.length, bytes: Buffer.byteLength(before, "utf8") },
    after: { lines: afterLines.length, bytes: Buffer.byteLength(after, "utf8") },
    delta: {
      lines: afterLines.length - beforeLines.length,
      bytes: Buffer.byteLength(after, "utf8") - Buffer.byteLength(before, "utf8"),
    },
  };
}

function computeUnifiedDiff(before, after, contextLines = 3) {
  // Minimal hunk around the first divergence. Not a full LCS diff —
  // good enough for a single-block self-edit + Vanguard audit log.
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const aStart = Math.max(0, prefix - contextLines);
  const bStart = Math.max(0, prefix - contextLines);
  const aHunkEnd = Math.min(a.length, a.length - suffix + contextLines);
  const bHunkEnd = Math.min(b.length, b.length - suffix + contextLines);
  const out = [];
  out.push(`@@ -${aStart + 1},${aHunkEnd - aStart} +${bStart + 1},${bHunkEnd - bStart} @@`);
  for (let i = aStart; i < prefix; i += 1) {
    out.push(` ${a[i]}`);
  }
  for (let i = prefix; i < a.length - suffix; i += 1) {
    out.push(`-${a[i]}`);
  }
  for (let i = prefix; i < b.length - suffix; i += 1) {
    out.push(`+${b[i]}`);
  }
  for (let i = a.length - suffix; i < aHunkEnd; i += 1) {
    out.push(` ${a[i]}`);
  }
  return out.join("\n");
}

function applySelfEditOperation(current, params) {
  const { operation } = params;
  if (operation === "append") {
    const { content } = params;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("append: `content` must be a non-empty string");
    }
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    const tail = content.endsWith("\n") ? "" : "\n";
    return current + sep + content + tail;
  }
  if (operation === "replace") {
    const { old_content: oldContent, new_content: newContent } = params;
    if (typeof oldContent !== "string" || oldContent.length === 0) {
      throw new Error("replace: `old_content` must be a non-empty string");
    }
    if (typeof newContent !== "string") {
      throw new Error("replace: `new_content` must be a string");
    }
    const first = current.indexOf(oldContent);
    if (first < 0) {
      throw new Error(
        "replace: `old_content` not found — the edit is ambiguous or already applied",
      );
    }
    if (current.indexOf(oldContent, first + 1) >= 0) {
      throw new Error(
        "replace: `old_content` matches multiple locations — expand the context until it's unique",
      );
    }
    return current.slice(0, first) + newContent + current.slice(first + oldContent.length);
  }
  if (operation === "upsert_block") {
    const { block_heading: blockHeading, block_content: blockContent } = params;
    if (typeof blockHeading !== "string" || !/^#{1,6}\s+\S/.test(blockHeading.trim())) {
      throw new Error(
        'upsert_block: `block_heading` must be a markdown heading like "## Voice calibration"',
      );
    }
    if (typeof blockContent !== "string") {
      throw new Error("upsert_block: `block_content` must be a string");
    }
    const heading = blockHeading.trim();
    const levelMatch = heading.match(/^(#+)/);
    const headingLevel = levelMatch ? levelMatch[1].length : 1;
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRe = new RegExp(`^${escapedHeading}\\s*$`, "m");
    const newBlock = `${heading}\n\n${blockContent.trim()}\n`;
    const match = headingRe.exec(current);
    if (!match) {
      const sep =
        current.length === 0
          ? ""
          : current.endsWith("\n\n")
            ? ""
            : current.endsWith("\n")
              ? "\n"
              : "\n\n";
      return current + sep + newBlock;
    }
    // Find end of block: next heading of same-or-higher level (1..headingLevel).
    const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s+\\S`, "m");
    const afterHeading = current.slice(match.index + match[0].length);
    const next = nextHeadingRe.exec(afterHeading);
    const blockEnd = next ? match.index + match[0].length + next.index : current.length;
    const tail = current.slice(blockEnd).replace(/^\n+/, "");
    const tailSep = tail.length === 0 ? "" : "\n";
    return current.slice(0, match.index) + newBlock + tailSep + tail;
  }
  throw new Error(`unknown operation: ${operation} (valid: ${SELF_EDIT_OPERATIONS.join(", ")})`);
}

function emitSelfEditAuditEvent(payload) {
  mkdirSync(dirname(SELF_EDIT_AUDIT_PATH), { recursive: true });
  appendFileSync(
    SELF_EDIT_AUDIT_PATH,
    `${JSON.stringify({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      source: "memory-graph",
      type: "self-edit-applied",
      payload,
    })}\n`,
    "utf8",
  );
}

async function selfEditPersona(args = {}) {
  const { file, operation, rationale } = args;
  if (!file || !(file in PERSONA_FILES)) {
    throw new Error(
      `file is required and must be one of: ${Object.keys(PERSONA_FILES).join(", ")}`,
    );
  }
  if (!operation || !SELF_EDIT_OPERATIONS.includes(operation)) {
    throw new Error(`operation must be one of: ${SELF_EDIT_OPERATIONS.join(", ")}`);
  }
  if (typeof rationale !== "string" || rationale.trim().length < 8) {
    throw new Error(
      "rationale is required (>= 8 chars) — explain WHY this self-edit is being proposed",
    );
  }
  const path = resolvePersonaPath(file);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const after = applySelfEditOperation(before, args);
  if (after === before) {
    return {
      applied: false,
      reason: "no-op: operation produced identical content",
      path,
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  let backupPath = null;
  if (existsSync(path)) {
    backupPath = `${path}.bak.${Date.now()}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, after, "utf8");
  const summary = computeDiffSummary(before, after);
  const unifiedDiff = computeUnifiedDiff(before, after);
  try {
    emitSelfEditAuditEvent({
      file,
      operation,
      path,
      backup: backupPath,
      rationale: rationale.trim(),
      summary,
      // Truncate diff in the audit payload to keep JSONL line size bounded;
      // the full content is recoverable from the .bak.<ts> + current file.
      unifiedDiffPreview: unifiedDiff.slice(0, 2000),
    });
  } catch (err) {
    console.error(
      `[memory-graph:self-edit] audit emit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    applied: true,
    path,
    backupPath,
    rationale: rationale.trim(),
    summary,
    unifiedDiff,
  };
}

// ---------- Claude Code transcript ingestion ----------

function ensureIngestCursorTable() {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ingest_cursor (
       source TEXT NOT NULL,
       file_path TEXT NOT NULL,
       last_entry_id TEXT,
       last_seen_at INTEGER NOT NULL,
       PRIMARY KEY (source, file_path)
     );`,
  );
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function persistNode({ kind, summary, body, confidence, source, surface }) {
  const truncated = summary.slice(0, 200);
  const id = deterministicId(kind, truncated);
  const now = Date.now();
  const existing = db.prepare("SELECT id FROM nodes WHERE id = ?").get(id);
  const bodyStored = body ? body.slice(0, 4000) : null;
  const effectiveSurface = surface ?? source?.surface ?? null;
  // Caller-supplied label wins; env-var default is the fallback; an existing
  // stored label on upsert is preserved via COALESCE in the UPDATE path.
  const effectiveOriginLabel = source?.originLabel ?? envOriginLabel() ?? null;
  if (existing) {
    db.prepare(
      `UPDATE nodes SET body = ?, updated_at = ?,
          source_session_id = COALESCE(?, source_session_id),
          source_surface = COALESCE(?, source_surface),
          origin_label = COALESCE(?, origin_label),
          confidence = MAX(?, confidence)
        WHERE id = ?`,
    ).run(
      bodyStored,
      now,
      source?.sessionId ?? null,
      effectiveSurface,
      effectiveOriginLabel,
      Number.isFinite(confidence) ? confidence : 0,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO nodes
         (id, kind, summary, body, scope, scope_id, confidence,
          created_at, updated_at,
          source_session_id, source_session_key, source_entry_id,
          source_surface, origin_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      kind,
      truncated,
      bodyStored,
      SCOPE,
      SCOPE_ID,
      Number.isFinite(confidence) ? confidence : 1,
      now,
      now,
      source?.sessionId ?? null,
      null,
      source?.entryId ?? null,
      effectiveSurface,
      effectiveOriginLabel,
    );
  }
  return id;
}

// Historical bulk imports (memory_ingest_claude_code) write here so the
// daily summarizer's "thread" window stays clean. The only functional
// difference from a live "thread" row is the `kind` column — row shape is
// identical. Live capture flows through the plugin engine (src/pipeline.ts),
// not this server, so we only need the archive helper here.
function persistArchiveThreadNode(summary, body, source) {
  return persistNode({
    kind: "thread_archive",
    summary,
    body,
    confidence: 1,
    source,
    surface: source?.surface,
  });
}

function ingestClaudeCodeTranscripts({ maxFiles = 50, maxLinesPerFile = 5000 } = {}) {
  ensureIngestCursorTable();
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    return { scanned: 0, filesNew: 0, nodesAdded: 0, reason: "no claude projects dir" };
  }
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(CLAUDE_PROJECTS_DIR, d.name));
  const sessionFiles = [];
  for (const proj of projectDirs) {
    // Claude Code stores transcripts as *.jsonl directly inside the project
    // dir (e.g. ~/.claude/projects/-Users-josephmatsiko-Projects-openclaw/
    // <uuid>.jsonl). No "sessions/" subdir.
    let entries;
    try {
      entries = readdirSync(proj, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      sessionFiles.push(join(proj, entry.name));
    }
  }
  sessionFiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const limited = sessionFiles.slice(0, maxFiles);

  let nodesAdded = 0;
  let filesNew = 0;
  const getCursor = db.prepare(
    "SELECT last_entry_id FROM ingest_cursor WHERE source = 'claude-code' AND file_path = ?",
  );
  const upsertCursor = db.prepare(
    `INSERT INTO ingest_cursor (source, file_path, last_entry_id, last_seen_at)
       VALUES ('claude-code', ?, ?, ?)
       ON CONFLICT(source, file_path) DO UPDATE SET
         last_entry_id = excluded.last_entry_id,
         last_seen_at = excluded.last_seen_at`,
  );

  for (const filePath of limited) {
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n").slice(0, maxLinesPerFile);
    const cursorRow = getCursor.get(filePath);
    const lastId = cursorRow?.last_entry_id;
    let passedCursor = !lastId;
    let newestId = lastId;
    let filesProgressed = false;
    for (const rawLine of lines) {
      if (!rawLine.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(rawLine);
      } catch {
        continue;
      }
      const messageId =
        record.uuid || record.id || record.messageId || record.message?.id || record.message?.uuid;
      if (!passedCursor) {
        if (messageId && messageId === lastId) {
          passedCursor = true;
        }
        continue;
      }
      // Accept either top-level message shape or wrapped {message: {...}}
      const messageObj =
        record && typeof record === "object" && record.message && typeof record.message === "object"
          ? record.message
          : record;
      const role = messageObj?.role;
      if (role !== "user") {
        continue;
      }
      const text = extractTextContent(messageObj?.content);
      if (!text) {
        continue;
      }
      // Skip obvious system/tool echo messages
      if (text.startsWith("<") && text.includes("</")) {
        continue;
      }
      const source = {
        sessionId: filePath.replace(`${CLAUDE_PROJECTS_DIR}/`, "cc:"),
        entryId: messageId,
        surface: "claude-code",
      };
      // Bulk historical ingest → archive kind so the live "thread" window
      // (used by the Layer-2 daily summarizer) stays clean.
      persistArchiveThreadNode(text, undefined, source);
      nodesAdded += 1;
      // Mine the same user text for typed claims (facts, preferences,
      // constraints, open-loops). Upserts are safe because ids are
      // deterministic on (kind, summary). Cross-surface restates converge
      // rather than duplicate.
      for (const claim of extractClaims(text)) {
        persistNode({
          kind: claim.kind,
          summary: claim.summary,
          confidence: claim.confidence,
          source,
          surface: "claude-code",
        });
        nodesAdded += 1;
      }
      if (messageId) {
        newestId = messageId;
      }
      filesProgressed = true;
    }
    if (filesProgressed) {
      filesNew += 1;
      upsertCursor.run(filePath, newestId ?? "", Date.now());
    }
  }
  return { scanned: limited.length, filesNew, nodesAdded };
}

// ---------- Embedding backfill ----------

async function backfillEmbeddings({ limit } = {}) {
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 500;
  const missing = db
    .prepare(
      `SELECT id, summary, body FROM nodes
        WHERE scope = ? AND scope_id = ?
          AND (embedding IS NULL OR embedding_model IS NOT ?)
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(SCOPE, SCOPE_ID, EMBEDDING_MODEL, effectiveLimit);
  let embedded = 0;
  for (const row of missing) {
    const vec = await embedText(nodeContentForEmbedding(row.summary, row.body ?? ""));
    db.prepare("UPDATE nodes SET embedding = ?, embedding_model = ? WHERE id = ?").run(
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
      EMBEDDING_MODEL,
      row.id,
    );
    embedded += 1;
  }
  const remainingRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM nodes
        WHERE scope = ? AND scope_id = ?
          AND (embedding IS NULL OR embedding_model IS NOT ?)`,
    )
    .get(SCOPE, SCOPE_ID, EMBEDDING_MODEL);
  return {
    embedded,
    remaining: Number(remainingRow?.n ?? 0),
    model: EMBEDDING_MODEL,
  };
}

// ---------- Consolidation (merge near-duplicates) ----------

async function consolidateMemory({ threshold = 0.92, dryRun = false, maxMerges = 50, kinds } = {}) {
  // Need every candidate row to have an embedding; opportunistically
  // backfill. Dry-run callers still get a representative preview.
  await backfillEmbeddings({ limit: 2000 });
  const kindsList =
    Array.isArray(kinds) && kinds.length > 0
      ? kinds.filter((k) => NODE_KINDS.includes(k))
      : NODE_KINDS.filter((k) => k !== "thread"); // thread chatter doesn't merge meaningfully
  if (kindsList.length === 0) {
    return { merges: [], scanned: 0, remaining: 0 };
  }
  const placeholders = kindsList.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, kind, summary, confidence, updated_at, embedding
         FROM nodes
        WHERE scope = ? AND scope_id = ?
          AND kind IN (${placeholders})
          AND embedding IS NOT NULL
        ORDER BY updated_at DESC`,
    )
    .all(SCOPE, SCOPE_ID, ...kindsList);

  const prepared = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    summary: r.summary,
    confidence: r.confidence,
    updatedAt: r.updated_at,
    vec: deserializeEmbedding(r.embedding),
  }));

  // Pairwise cosine within the same kind; ids already deterministic per
  // (kind, summary) so true duplicates rarely happen — this catches
  // paraphrases ("my wife is Sarah" vs "wife is Sarah").
  const merges = [];
  const dropped = new Set();
  for (let i = 0; i < prepared.length; i += 1) {
    if (dropped.has(prepared[i].id)) {
      continue;
    }
    const a = prepared[i];
    for (let j = i + 1; j < prepared.length; j += 1) {
      if (merges.length >= maxMerges) {
        break;
      }
      const b = prepared[j];
      if (dropped.has(b.id)) {
        continue;
      }
      if (b.kind !== a.kind) {
        continue;
      }
      const sim = cosine(a.vec, b.vec);
      if (sim < threshold) {
        continue;
      }
      // Keep the higher-confidence / more-recent one. Merge in the other's
      // text into the kept node's body if it adds information.
      const [keep, drop] =
        a.confidence >= b.confidence && a.updatedAt >= b.updatedAt ? [a, b] : [b, a];
      merges.push({
        kept: { id: keep.id, summary: keep.summary, kind: keep.kind },
        dropped: { id: drop.id, summary: drop.summary, kind: drop.kind },
        similarity: Number(sim.toFixed(4)),
      });
      dropped.add(drop.id);
      if (!dryRun) {
        db.prepare("DELETE FROM nodes WHERE id = ?").run(drop.id);
      }
    }
    if (merges.length >= maxMerges) {
      break;
    }
  }
  return {
    merges,
    scanned: prepared.length,
    threshold,
    dryRun,
    remaining: prepared.length - dropped.size,
  };
}

function stats() {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS n
         FROM nodes
         WHERE scope = ? AND scope_id = ?
         GROUP BY kind`,
    )
    .all(SCOPE, SCOPE_ID);
  const counts = Object.fromEntries(NODE_KINDS.map((k) => [k, 0]));
  for (const row of rows) {
    counts[row.kind] = Number(row.n);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { dbPath: DB_PATH, scope: SCOPE, scopeId: SCOPE_ID, total, counts };
}

// ---------- MCP server wiring ----------

const server = new Server(
  { name: "memory-graph", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const toolDefs = [
  {
    name: "memory_recall",
    description:
      "Return the most recently updated memory-graph nodes for Joseph's personal context — facts, preferences, constraints, open-loops, entities. Call this at the start of a session or whenever you need background on the user before answering.",
    inputSchema: {
      type: "object",
      properties: {
        kinds: {
          type: "array",
          items: { type: "string", enum: [...NODE_KINDS] },
          description:
            "Optional filter. Default excludes raw conversation kinds (thread + thread_archive).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max rows. Default 50.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description:
      "Substring search across node summaries and bodies. Use when you suspect the user mentioned something earlier but need to confirm before acting on it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...NODE_KINDS] },
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_store",
    description:
      "Write a typed memory node (fact, preference, constraint, open-loop, entity). Use when the user explicitly says remember/note this, or when you learn something durable about them that regex extraction would miss. Deterministic id on (kind, summary) — restating upserts rather than duplicating.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description: "Short canonical phrasing of the claim.",
        },
        kind: {
          type: "string",
          enum: [...NODE_KINDS],
          description: "Node kind. Default 'fact'.",
        },
        body: { type: "string", description: "Optional longer-form body." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    description:
      "Delete a node by id. Use when the user asks to forget something specific; pair with memory_search first to confirm the right id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_stats",
    description:
      "Return total node count and per-kind counts. Useful for a quick orientation at the start of a session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_backfill_embeddings",
    description:
      "Force-compute sentence embeddings for nodes that don't have them yet (or were embedded with a different model). Semantic search lazy-backfills up to 200 on first call; use this tool to force a full pass — useful after a big ingest or a model swap. Zero API cost (local model).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Max nodes to embed this call. Default 500.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_consolidate",
    description:
      "Find near-duplicate nodes via cosine similarity over embeddings and merge them — keeps the highest-confidence / most-recent one, deletes the other. Collapses paraphrases like 'my wife is Sarah' vs 'wife is Sarah'. Skips thread nodes by default. Dry-run first is recommended.",
    inputSchema: {
      type: "object",
      properties: {
        threshold: {
          type: "number",
          minimum: 0.7,
          maximum: 0.999,
          description: "Cosine similarity threshold for merge. Default 0.92.",
        },
        dryRun: {
          type: "boolean",
          description: "When true, return proposed merges without deleting. Default false.",
        },
        maxMerges: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Cap on merges per call. Default 50.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...NODE_KINDS] },
          description: "Which kinds to consider. Default: all except thread.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_get_persona",
    description:
      "Read Joseph's persona + workspace-knowledge files (SOUL, IDENTITY, USER, AGENTS, MEMORY by default). Call FIRST THING in every new session to ground in who he is, his current work orbit, how he wants you to behave, what counts as critical, and the workspace's operating protocol. Also accepts TOOLS, HEARTBEAT, BOOTSTRAP.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "soul",
              "identity",
              "user",
              "agents",
              "memory",
              "tools",
              "heartbeat",
              "bootstrap",
            ],
          },
          description:
            "Which files to return. Default: ['soul','identity','user','agents','memory'] — the load-bearing persona + workspace knowledge.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_set_persona",
    description:
      "Write one of Joseph's persona/workspace files (SOUL, IDENTITY, USER, AGENTS, MEMORY, TOOLS, HEARTBEAT, BOOTSTRAP). Creates a timestamped .bak.<ts> backup automatically. This is a CRITICAL action per the SOUL boundaries — confirm intent with the user before calling it.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: ["soul", "identity", "user", "agents", "memory", "tools", "heartbeat", "bootstrap"],
        },
        content: { type: "string" },
        backup: {
          type: "boolean",
          description: "Make a .bak.<timestamp> copy of the prior file. Default true.",
        },
      },
      required: ["file", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_self_edit",
    description:
      "Surgically evolve one of Joseph's persona files (SOUL, IDENTITY, USER, AGENTS, MEMORY, TOOLS, HEARTBEAT, BOOTSTRAP) at the block level — Letta/MemGPT-style self-editing memory for the Apex. Three operations: `append` (add text to end), `replace` (swap an exact-match substring that occurs exactly once — will fail if it matches multiple locations, so include enough context to make it unique), `upsert_block` (create-or-replace a markdown-heading-delimited section). ALWAYS creates a timestamped .bak.<ts> backup. REQUIRES `rationale` (>= 8 chars) explaining why — this lands in the audit bus event for Vanguard review. CRITICAL per SOUL boundary: execution-mode gate applies on gateway-dispatched calls; Claude Code / Claude Desktop use their own permission surface. Prefer this over memory_set_persona when you want to evolve one section of your own operating instructions without rewriting a whole file. After the call returns applied:true, the next memory_get_persona reflects the change.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: ["soul", "identity", "user", "agents", "memory", "tools", "heartbeat", "bootstrap"],
          description: "Which persona file to edit.",
        },
        operation: {
          type: "string",
          enum: ["append", "replace", "upsert_block"],
          description:
            "`append` adds content at the end. `replace` swaps an exact substring (must occur exactly once). `upsert_block` creates-or-replaces a markdown-heading section.",
        },
        rationale: {
          type: "string",
          minLength: 8,
          description:
            "Why this self-edit is being made. Lands in the bus event + is visible to Joseph's nightly Vanguard. Not optional.",
        },
        content: {
          type: "string",
          description:
            "For `append`: the text to add at the end of the file. Required when operation=append.",
        },
        old_content: {
          type: "string",
          description:
            "For `replace`: the exact substring to find. Must match exactly once — include enough surrounding context to be unique. Required when operation=replace.",
        },
        new_content: {
          type: "string",
          description:
            "For `replace`: the text that will take old_content's place (may be empty to delete). Required when operation=replace.",
        },
        block_heading: {
          type: "string",
          description:
            "For `upsert_block`: the full markdown heading line (e.g., '## Voice calibration'). If present, the block from this heading to the next same-or-higher-level heading is replaced; if absent, the block is appended. Required when operation=upsert_block.",
        },
        block_content: {
          type: "string",
          description:
            "For `upsert_block`: the body text placed under block_heading. Required when operation=upsert_block.",
        },
      },
      required: ["file", "operation", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_ingest_claude_code",
    description:
      "Tail Joseph's Claude Code session transcripts (~/.claude/projects/*/sessions/*.jsonl) and ingest new user messages as thread nodes. Uses a per-file cursor so each message is ingested once. Makes conversations from Claude Code feed the same memory as Telegram, terminal, and Claude Desktop — no other memory system in the comp table does this. Safe to call repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        maxFiles: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Max session files to scan this call (newest first). Default 50.",
        },
        maxLinesPerFile: {
          type: "integer",
          minimum: 100,
          maximum: 100000,
          description: "Max lines per file. Default 5000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_semantic_search",
    description:
      "Semantic (vector-similarity) search across Joseph's memory-graph nodes. Use this instead of memory_search when you want conceptually related facts — 'what do you know about my health?' surfaces 'allergic to peanuts' even without the word 'health'. Embeddings are local (all-MiniLM-L6-v2, 384-d, zero API cost). First call warms the model (~3s) and backfills vectors for up to 200 un-embedded nodes; subsequent calls are instant.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...NODE_KINDS] },
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        backfillLimit: {
          type: "integer",
          minimum: 0,
          maximum: 500,
          description:
            "Max un-embedded nodes to embed on this call. Default 200; lower if first-call latency matters.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_classify_message",
    description:
      "Classify an incoming user message into a routing tier (trivial / contextual / complex) and suggest a concrete model (Gemini Flash / Gemini Pro / Claude Opus). Heuristic path is zero-latency / zero-cost. Pass useLlmFallback:true to send heuristic-miss turns to Gemini Flash for an accurate tier (~500ms, free tier) — this is where most real routing savings come from; the heuristic alone is conservative and tends to default to 'complex' on short non-question messages. Verdict always returns, never throws — on failure it falls back to 'complex' with a signal tag so quality never silently regresses.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "The user message to classify.",
        },
        lastAssistantEndedInQuestion: {
          type: "boolean",
          description:
            "Set true when the prior assistant turn ended with a question. Short replies in question-led threads tier up from trivial→contextual so they don't get dropped to Flash out of context.",
        },
        useLlmFallback: {
          type: "boolean",
          description:
            "When true, heuristic-miss turns are routed to Gemini Flash for a second-opinion classification. Default false (pure heuristic, zero latency).",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_route_and_answer",
    description:
      "End-to-end routing + single-turn answer. Classifies the message (heuristic + LLM fallback), and when the verdict is trivial or contextual, calls Gemini Flash or Pro to produce the answer inline — saving Opus quota. When the verdict is complex, returns answer=null + answeredBy='opus-absent' so the calling agent (which is already Opus) handles the turn itself. Any failure in the delegate call degrades to answer=null; the caller can always fall back to its own inference. Use this before committing Opus quota to a sub-question you suspect is trivial — e.g. 'what's 17*23?', 'summarize this sentence', 'reply with just OK'.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "The user message to route and (conditionally) answer.",
        },
        lastAssistantEndedInQuestion: {
          type: "boolean",
          description: "See memory_classify_message — same tier-up rule.",
        },
        systemPrompt: {
          type: "string",
          description:
            "Optional system instruction prepended to the delegate's answer call (not the classifier). Keep short — Gemini's output budget is shared with this.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result;
  switch (name) {
    case "memory_recall":
      result = recall(args);
      break;
    case "memory_search":
      result = search(args);
      break;
    case "memory_store":
      result = store(args);
      break;
    case "memory_forget":
      result = forget(args);
      break;
    case "memory_stats":
      result = stats();
      break;
    case "memory_semantic_search":
      result = await semanticSearch(args);
      break;
    case "memory_get_persona":
      result = getPersona(args);
      break;
    case "memory_set_persona":
      result = setPersona(args);
      break;
    case "memory_self_edit":
      result = await selfEditPersona(args);
      break;
    case "memory_ingest_claude_code":
      result = ingestClaudeCodeTranscripts(args);
      break;
    case "memory_backfill_embeddings":
      result = await backfillEmbeddings(args);
      break;
    case "memory_consolidate":
      result = await consolidateMemory(args);
      break;
    case "memory_classify_message": {
      const classifyOpts = {
        lastAssistantEndedInQuestion: args?.lastAssistantEndedInQuestion === true,
      };
      result =
        args?.useLlmFallback === true
          ? await classifyMessageWithLLMFallback(args?.text ?? "", classifyOpts)
          : classifyMessage(args?.text ?? "", classifyOpts);
      break;
    }
    case "memory_route_and_answer":
      result = await routeAndAnswerForMcp(args?.text ?? "", {
        lastAssistantEndedInQuestion: args?.lastAssistantEndedInQuestion === true,
        systemPrompt: typeof args?.systemPrompt === "string" ? args.systemPrompt : "",
      });
      break;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Keep the process alive; MCP SDK handles lifetime via the transport.
// Nothing else to do here — the server runs until stdin closes.
// Suppress an unused-var lint for randomUUID import (reserved for future).
void randomUUID;
