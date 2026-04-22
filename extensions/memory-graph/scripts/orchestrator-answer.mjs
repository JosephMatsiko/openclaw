#!/usr/bin/env node
// Layer-5 route-and-answer CLI.
//
// Reads a message from argv or stdin, classifies it, and:
//   - trivial → answers via Gemini 2.5 Flash
//   - contextual → answers via Gemini 2.5 Pro
//   - complex → either pipes to `claude -p` (if --use-claude), prints the
//     marker "[[COMPLEX → OPUS]]" otherwise (so the caller can decide)
//
// Usage:
//   echo "what time is it in Chicago?" | node orchestrator-answer.mjs
//   node orchestrator-answer.mjs "reply with just OK"
//   node orchestrator-answer.mjs --use-claude "refactor the engine"
//   node orchestrator-answer.mjs --json "hi"
//   node orchestrator-answer.mjs --system "You are terse." "say hi"
//
// Flags:
//   --use-claude      Spawn `claude -p` for complex-tier answers.
//                     Requires the `claude` binary on PATH and an active
//                     Max-plan keychain entry.
//   --system <text>   System prompt for the Gemini answer call (not the
//                     classifier). Ignored on complex / --use-claude path.
//   --last-q          Prior assistant turn ended with a question.
//   --json            JSON output (verdict + answer + metadata).
//   -h, --help        Print this help.

// ---- classifier (same rules as orchestrator.ts / mcp-server / route CLI) ----

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
  return null; // caller decides how to handle heuristic-miss
}

// ---- Gemini classifier fallback + answer call ----

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

// Route Layer-5 classifier + answer-router through Claude Max (Sonnet
// primary, Opus fallback on overload). Joseph's Google prepayment is
// depleted so Gemini 2.5 Flash 429s; Max covers sonnet+opus unlimited.
// The classifier path prepends buildClassifierPrompt; the answer path
// uses the user text (optionally with a system prompt prefix since
// claude CLI doesn't take a separate system instruction via -p).
async function callClaudeCli(text, { system = "", isClassifier = false } = {}) {
  const { spawn } = await import("node:child_process");
  const prompt = isClassifier
    ? buildClassifierPrompt(text)
    : system && system.trim()
      ? `${system.trim()}\n\n${text.trim()}`
      : text.trim();
  return new Promise((resolve) => {
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
        resolve({ text: null, error: `claude-cli-exit-${code}-${stderr.slice(0, 60)}` });
        return;
      }
      const out = stdout.trim();
      if (!out) {
        resolve({ text: null, error: "claude-cli-empty" });
        return;
      }
      resolve({ text: out });
    });
    child.on("error", (err) => {
      resolve({ text: null, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function classifyByLLM(text) {
  const r = await callClaudeCli(text, { isClassifier: true });
  if (r.text === null) {
    return verdict("complex", `LLM fallback failed (${r.error})`, 0.5, [
      "llm-fallback-failed",
      r.error,
    ]);
  }
  const tier = normalizeTierLLM(r.text);
  if (!tier) {
    return verdict("complex", "LLM gave unrecognized tier", 0.5, [
      "llm-fallback-failed",
      `unrecognized:${r.text.slice(0, 24)}`,
    ]);
  }
  const v = verdict(tier, `LLM classifier returned "${tier}"`, 0.85, ["llm-classifier"]);
  v.viaHeuristic = false;
  return v;
}

// ---- claude -p delegate for complex tier ----

async function callClaude(text, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", text], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

// ---- args ----

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--use-claude") {
      out.flags.useClaude = true;
    } else if (t === "--last-q" || t === "--last-question") {
      out.flags.lastQ = true;
    } else if (t === "--json") {
      out.flags.json = true;
    } else if (t === "-h" || t === "--help") {
      out.flags.help = true;
    } else if (t === "--system") {
      out.flags.system = argv[i + 1] ?? "";
      i += 1;
    } else {
      out.positional.push(t);
    }
  }
  return out;
}

function printHelp() {
  console.log(`orchestrator-answer.mjs — classify, then answer via the right model

USAGE
  orchestrator-answer.mjs [--last-q] [--use-claude] [--json] [--system <text>] <text>
  echo "<text>" | orchestrator-answer.mjs [flags]

FLAGS
  --use-claude     Hand complex-tier turns off to \`claude -p\`. Default: print marker.
  --system TEXT    System prompt for Gemini answer calls.
  --last-q         Prior assistant turn ended with a question.
  --json           Emit JSON instead of bare text.
  -h, --help       Print this help.

OUTPUT (default)
  Bare answer text to stdout. Tier + model logged to stderr.
  On complex without --use-claude, stdout is "[[COMPLEX → OPUS]]".
  On any failure, exit code 1 and stderr describes why.
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

  const classifyOpts = { lastAssistantEndedInQuestion: flags.lastQ === true };
  let v = classify(text, classifyOpts);
  if (!v) {
    v = await classifyByLLM(text);
  }

  const started = Date.now();

  if (v.tier === "trivial" || v.tier === "contextual") {
    // Both tiers through Claude Max now. Sonnet primary, Opus fallback —
    // Joseph's preference: Sonnet + Opus only, no Haiku. claude CLI
    // handles the fallback internally on overload.
    const r = await callClaudeCli(text, { system: flags.system ?? "" });
    const latencyMs = Date.now() - started;
    if (r.text === null) {
      process.stderr.write(`[orchestrator-answer] answer call failed: ${r.error}\n`);
      process.exitCode = 1;
      return;
    }
    const model = "claude-cli/sonnet";
    process.stderr.write(
      `[orchestrator-answer] ${v.tier.toUpperCase()} via ${model} (${latencyMs}ms)\n`,
    );
    if (flags.json) {
      console.log(JSON.stringify({ verdict: v, answer: r.text, answerModel: model, latencyMs }));
    } else {
      console.log(r.text);
    }
    return;
  }

  // tier=complex
  if (!flags.useClaude) {
    process.stderr.write(
      `[orchestrator-answer] COMPLEX — not handling (pass --use-claude to spawn \`claude -p\`)\n`,
    );
    if (flags.json) {
      console.log(JSON.stringify({ verdict: v, answer: null, answeredBy: "opus-absent" }));
    } else {
      console.log("[[COMPLEX → OPUS]]");
    }
    return;
  }
  try {
    const answer = await callClaude(text);
    const latencyMs = Date.now() - started;
    process.stderr.write(`[orchestrator-answer] COMPLEX via claude -p (${latencyMs}ms)\n`);
    if (flags.json) {
      console.log(
        JSON.stringify({ verdict: v, answer, answerModel: "claude-opus-4-7", latencyMs }),
      );
    } else {
      console.log(answer);
    }
  } catch (err) {
    process.stderr.write(`[orchestrator-answer] claude -p failed: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[orchestrator-answer] fatal: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
