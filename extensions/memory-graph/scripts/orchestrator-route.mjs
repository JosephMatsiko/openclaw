#!/usr/bin/env node
// Layer-5 Orchestrator — CLI smoke.
//
// Reads a message from argv or stdin, runs the heuristic classifier, and
// prints the routing verdict. Useful for tuning the rules by hand without
// having to spin up the MCP server.
//
// Usage:
//   node extensions/memory-graph/scripts/orchestrator-route.mjs "hi there"
//   node extensions/memory-graph/scripts/orchestrator-route.mjs --json "refactor the engine"
//   echo "what did we discuss yesterday?" | node extensions/memory-graph/scripts/orchestrator-route.mjs
//   node extensions/memory-graph/scripts/orchestrator-route.mjs --last-q yes
//   node extensions/memory-graph/scripts/orchestrator-route.mjs --llm-fallback "reply with just FLASH"

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function verdict(tier, rationale, confidence, signals) {
  return {
    tier,
    model: ROUTING_TIER_TO_MODEL[tier],
    rationale,
    confidence,
    signals,
    viaHeuristic: true,
  };
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

function llmFail(reason) {
  return {
    tier: "complex",
    model: ROUTING_TIER_TO_MODEL.complex,
    rationale: `LLM fallback failed (${reason}); defaulting to complex`,
    confidence: 0.5,
    signals: ["llm-fallback-failed", reason],
    viaHeuristic: false,
  };
}

async function classifyByLLM(text, apiKey, { model = "gemini-2.5-flash", timeoutMs = 4000 } = {}) {
  if (!apiKey) {
    return llmFail("no-api-key");
  }
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
      return llmFail(`http-${res.status}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const raw = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (!raw) {
      return llmFail("empty-response");
    }
    const tier = normalizeTierLLM(raw);
    if (!tier) {
      return llmFail(`unrecognized:${raw.slice(0, 24)}`);
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
    return llmFail(name);
  } finally {
    clearTimeout(timer);
  }
}

function classify(text, opts = {}) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return verdict("trivial", "empty input", 1, ["empty"]);
  }
  if (ROUTING_RE_CODE.test(trimmed)) {
    return verdict("complex", "contains code or structure markers", 0.95, ["code-markers"]);
  }
  if (ROUTING_RE_MEMORY_MUTATING.test(trimmed)) {
    return verdict("complex", "memory-mutating language", 0.9, ["memory-mutating"]);
  }
  if (ROUTING_RE_ENG_VERB.test(trimmed)) {
    return verdict("complex", "engineering verb", 0.85, ["engineering-verb"]);
  }
  const lineCount = trimmed.split(/\n/).length;
  const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 2).length;
  if (trimmed.length > 500 || lineCount > 4 || sentenceCount > 5) {
    return verdict("complex", "long or multi-sentence", 0.8, [
      `length (${trimmed.length} chars, ${lineCount} lines, ${sentenceCount} sentences)`,
    ]);
  }
  if (ROUTING_RE_RECALL.test(trimmed)) {
    return verdict("contextual", "memory-recall question", 0.9, ["memory-recall-question"]);
  }
  if (opts.lastAssistantEndedInQuestion && trimmed.split(/\s+/).length <= 8) {
    return verdict("contextual", "short reply continuing a question thread", 0.7, [
      "short-reply-to-question",
    ]);
  }
  if (ROUTING_RE_ACK.test(trimmed)) {
    return verdict("trivial", "greeting or acknowledgement", 0.95, ["ack-or-greeting"]);
  }
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 4 && trimmed.endsWith("?")) {
    return verdict("trivial", "very short question", 0.75, [
      `very-short-question (${wordCount} words)`,
    ]);
  }
  if (sentenceCount === 1 && trimmed.endsWith("?") && wordCount <= 20) {
    return verdict("contextual", "short factual question", 0.7, [
      `short-question (${wordCount} words)`,
    ]);
  }
  return verdict("complex", "no clear heuristic match; defaulting to complex", 0.5, [
    "heuristic-miss",
  ]);
}

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--json") {
      out.flags.json = true;
    } else if (t === "--last-q" || t === "--last-question") {
      out.flags.lastQ = true;
    } else if (t === "--llm-fallback" || t === "--llm") {
      out.flags.llm = true;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    } else {
      out.positional.push(t);
    }
  }
  return out;
}

function printHelp() {
  console.log(`orchestrator-route.mjs — classify a message into a routing tier

USAGE
  orchestrator-route.mjs [--last-q] [--json] <text>
  echo "<text>" | orchestrator-route.mjs [--last-q] [--json]

FLAGS
  --last-q         Prior assistant turn ended with a question (tier-up rule).
  --llm-fallback   On heuristic-miss, call Gemini 2.5 Flash for a tier (~500ms).
                   Requires an API key in ~/.openclaw/agents/main/agent/auth-profiles.json.
  --json           Emit JSON instead of a human-readable summary.
  -h, --help       Print this help.

OUTPUT (default)
  TIER       model                  confidence  rationale
  [signals]
  > input text (first 120 chars)
`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }
  let text = positional.join(" ").trim();
  if (!text) {
    try {
      text = readFileSync(0, "utf8").trim();
    } catch {
      text = "";
    }
  }
  if (!text) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  let v = classify(text, { lastAssistantEndedInQuestion: flags.lastQ === true });
  // Only hit the LLM when the heuristic genuinely gave up. Hits + tier-ups
  // short-circuit cleanly and add zero latency.
  if (flags.llm && v.signals.includes("heuristic-miss")) {
    const apiKey = loadGeminiKey();
    v = await classifyByLLM(text, apiKey);
  }
  if (flags.json) {
    console.log(JSON.stringify({ ...v, input: text }, null, 2));
    return;
  }
  const tierPad = v.tier.toUpperCase().padEnd(10);
  const modelPad = v.model.padEnd(22);
  const conf = v.confidence.toFixed(2);
  console.log(`${tierPad} ${modelPad} ${conf}  ${v.rationale}`);
  console.log(`[${v.signals.join(", ")}]`);
  const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
  console.log(`> ${preview.replace(/\n/g, "\\n")}`);
}

main().catch((err) => {
  console.error(`[orchestrator-route] ${err?.stack ?? err}`);
  process.exitCode = 1;
});
