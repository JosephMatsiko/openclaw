// Layer-5 Orchestrator (Bezalel Node) — routing brain.
//
// Classifies an incoming user message into a tier and maps it to a concrete
// model. Zero-cost heuristic first pass; an LLM fallback can slot in later
// without changing the shape. Default routing table lines up with the stack
// Joseph actually has:
//
//   trivial    → gemini-2.5-flash    (one-liners, acks, short factual Qs)
//   contextual → gemini-2.5-pro      (memory recall, structured Qs, tier-up)
//   complex    → claude-opus-4-7     (code, architecture, memory-mutating,
//                                     long-form, anything unclear)
//
// Intended consumers:
//   - MCP tool `memory_classify_message` (so any agent can ask "should I
//     hand this off to a smaller model?")
//   - CLI smoke (`scripts/orchestrator-route.mjs`) for manual tuning
//   - Future: a gateway pre-inference hook (Phase 3b) that routes Telegram
//     turns without an agent having to opt in.

export type OrchestratorTier = "trivial" | "contextual" | "complex";

// Concrete model ids we support today. Widen this as we add providers.
export type OrchestratorModel =
  | "gemini-2.5-flash"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash-lite"
  | "claude-opus-4-7"
  | "claude-sonnet-4-6";

export type RouteVerdict = {
  tier: OrchestratorTier;
  model: OrchestratorModel;
  rationale: string;
  // Rough 0-1 confidence from the matching rule; useful for telemetry but
  // not load-bearing. Heuristic defaults are conservative, not calibrated.
  confidence: number;
  // Every rule that contributed to the decision. Order mirrors the order
  // they fired; the first entry is usually the deciding one.
  signals: string[];
  // True when the verdict came from the heuristic path (no LLM call). Kept
  // on the type so the LLM-fallback variant below can set it false without
  // callers having to branch on presence.
  viaHeuristic: boolean;
};

export type ClassifyOptions = {
  // If the prior assistant turn ended with a question, a short user reply
  // ("yes", "the left one") belongs to a richer thread and should NOT be
  // dropped to Flash purely because it's 6 words. Off by default — only
  // callers that actually track turn context should set it.
  lastAssistantEndedInQuestion?: boolean;
  // Override the tier→model mapping. Useful for tests, A/B, or surfaces
  // where Opus isn't available.
  tierToModel?: Partial<Record<OrchestratorTier, OrchestratorModel>>;
};

export const DEFAULT_TIER_TO_MODEL: Record<OrchestratorTier, OrchestratorModel> = {
  trivial: "gemini-2.5-flash",
  contextual: "gemini-2.5-pro",
  complex: "claude-opus-4-7",
};

function resolveModel(tier: OrchestratorTier, opts: ClassifyOptions): OrchestratorModel {
  const override = opts.tierToModel?.[tier];
  return override ?? DEFAULT_TIER_TO_MODEL[tier];
}

function verdict(
  tier: OrchestratorTier,
  rationale: string,
  confidence: number,
  signals: string[],
  opts: ClassifyOptions,
): RouteVerdict {
  return {
    tier,
    model: resolveModel(tier, opts),
    rationale,
    confidence,
    signals,
    viaHeuristic: true,
  };
}

// Regexes, split out so they can be unit-tested independently if the rules
// grow complex enough that a bug surface matters.
const RE_CODE_MARKERS =
  /```|\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=|\bdef\s+\w+\s*\(|\bclass\s+\w+\s*[({]/i;

const RE_MEMORY_MUTATING =
  /\b(remember\s+(that|this)|please\s+(note|remember)|don'?t\s+let\s+me\s+forget|i\s+just\s+realized|actually,?\s+i)\b/i;

const RE_ENGINEERING_VERB =
  /\b(implement|refactor|debug|architect|migrate|benchmark|profile|deploy|optimize|design|review|build\s+me|write\s+a|fix|diagnose|ship|land|wire|hook|integrate)\b/i;

const RE_ACK_OR_GREETING =
  /^(hi+|hey+|hello|yo|sup|thanks|thank\s+you|ty|ok+|okay|sure|cool|nice|alright|got\s+it|noted|perfect|great|awesome|yes|no|yep|nope|yeah)[\s\W]*$/i;

const RE_MEMORY_RECALL =
  /\b(what\s+(did|do)\s+(i|we)\s+(talk|say|mention|discuss|cover|decide)|remind\s+me\s+(what|who|when|where|why)|summar(ize|y|ise)|what'?s\s+in\s+my\s+(memory|graph|notes))\b/i;

// First-match-wins classifier. Returns null on genuine ambiguity so a caller
// that wants to try an LLM classifier next can do so without re-parsing.
// Callers that just want a verdict should use `classify()` below.
export function classifyByHeuristic(text: string, opts: ClassifyOptions = {}): RouteVerdict | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return verdict("trivial", "empty input", 1, ["empty"], opts);
  }

  const signals: string[] = [];

  // 1. Code / structure markers anywhere in the text → Opus. Even one line
  //    of code is usually a request for real reasoning.
  if (RE_CODE_MARKERS.test(trimmed)) {
    signals.push("code-markers");
    return verdict("complex", "contains code or structure markers", 0.95, signals, opts);
  }

  // 2. Memory-mutating language. These turns should land in the graph as
  //    claims, and the extractor runs in the Opus path today — keep the
  //    reply on Opus so the write side of the stack behaves consistently.
  if (RE_MEMORY_MUTATING.test(trimmed)) {
    signals.push("memory-mutating");
    return verdict("complex", "memory-mutating language", 0.9, signals, opts);
  }

  // 3. Engineering verbs → Opus. Refactor/debug/ship/wire usually map to
  //    multi-step tasks and Flash will chew through context without the
  //    quality needed to land real code.
  if (RE_ENGINEERING_VERB.test(trimmed)) {
    signals.push("engineering-verb");
    return verdict("complex", "engineering verb", 0.85, signals, opts);
  }

  // 4. Length / structure. A long paragraph or a multi-sentence ask is
  //    almost never a Flash-tier turn.
  const lineCount = trimmed.split(/\n/).length;
  const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 2).length;
  if (trimmed.length > 500 || lineCount > 4 || sentenceCount > 5) {
    signals.push(
      `length (${trimmed.length} chars, ${lineCount} lines, ${sentenceCount} sentences)`,
    );
    return verdict("complex", "long or multi-sentence", 0.8, signals, opts);
  }

  // 5. Memory-recall style questions need graph context but not deep
  //    reasoning → Pro is the right middle tier.
  if (RE_MEMORY_RECALL.test(trimmed)) {
    signals.push("memory-recall-question");
    return verdict("contextual", "memory-recall question", 0.9, signals, opts);
  }

  // 6. Context tier-up: a short reply that's continuing a question-led
  //    thread should not drop to Flash, because the real load is in the
  //    rest of the conversation.
  if (opts.lastAssistantEndedInQuestion && trimmed.split(/\s+/).length <= 8) {
    signals.push("short-reply-to-question");
    return verdict("contextual", "short reply continuing a question thread", 0.7, signals, opts);
  }

  // 7. Pure acknowledgements / greetings → Flash. We only reach this after
  //    the context tier-up check, so "yes" in a thread escalates to Pro
  //    instead of hitting Flash.
  if (RE_ACK_OR_GREETING.test(trimmed)) {
    signals.push("ack-or-greeting");
    return verdict("trivial", "greeting or acknowledgement", 0.95, signals, opts);
  }

  // 8. Very short questions (≤ 4 words + ?) → Flash. "What time is it?"
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 4 && trimmed.endsWith("?")) {
    signals.push(`very-short-question (${wordCount} words)`);
    return verdict("trivial", "very short question", 0.75, signals, opts);
  }

  // 9. Single-sentence medium question → Pro. Enough substance that Flash
  //    might stumble, not enough to warrant Opus.
  if (sentenceCount === 1 && trimmed.endsWith("?") && wordCount <= 20) {
    signals.push(`short-question (${wordCount} words)`);
    return verdict("contextual", "short factual question", 0.7, signals, opts);
  }

  // No clear signal. Return null so callers can decide whether to add an
  // LLM fallback or just default.
  return null;
}

// Sync main entry. Applies the heuristic; on a miss, defaults to complex so
// we never silently drop quality. Use `classifyWithLLMFallback` when you
// can afford a ~500ms async round-trip to Gemini Flash for the ambiguous
// bucket — the heuristic's `heuristic-miss` rate on real data is high
// enough that the LLM fallback is where most of the Flash/Pro routing
// savings actually come from.
export function classify(text: string, opts: ClassifyOptions = {}): RouteVerdict {
  const h = classifyByHeuristic(text, opts);
  if (h) {
    return h;
  }
  return heuristicMissDefault(opts);
}

function heuristicMissDefault(opts: ClassifyOptions): RouteVerdict {
  return {
    tier: "complex",
    model: resolveModel("complex", opts),
    rationale: "no clear heuristic match; defaulting to complex",
    confidence: 0.5,
    signals: ["heuristic-miss"],
    viaHeuristic: true,
  };
}

// ---- LLM fallback (Gemini Flash, ~500ms, free-tier friendly) ----

export type LLMClassifyOptions = {
  // Gemini API key. Separate arg keeps the classifier pure + testable —
  // the key lifecycle belongs to the caller (MCP handler, CLI, etc.).
  apiKey: string;
  // Override the classifier model. Default: gemini-2.5-flash.
  model?: string;
  // Hard budget on the classifier call. Should stay well under the caller's
  // own timeout — classifier failure must never block the turn.
  timeoutMs?: number;
  // Pluggable fetch for tests. Defaults to globalThis.fetch.
  fetchImpl?: typeof fetch;
};

function isGemini25(model: string): boolean {
  return /^gemini-2\.5/i.test(model);
}

function normalizeTier(raw: string): OrchestratorTier | null {
  const lower = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?"'`]/g, "");
  // Check more specific first so "contextual" doesn't hit "complex" via a
  // substring collision (it doesn't, but be defensive if the list grows).
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

function llmFailVerdict(opts: ClassifyOptions, reason: string): RouteVerdict {
  return {
    tier: "complex",
    model: resolveModel("complex", opts),
    rationale: `LLM fallback failed (${reason}); defaulting to complex`,
    confidence: 0.5,
    signals: ["llm-fallback-failed", reason],
    viaHeuristic: false,
  };
}

function buildClassifierPrompt(text: string): string {
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

// Async LLM classifier. Returns a verdict from the Gemini response, or a
// safe `complex` fallback if anything went wrong. Never throws — a
// classification call must not break the caller's turn.
export async function classifyByLLM(
  text: string,
  llm: LLMClassifyOptions,
  opts: ClassifyOptions = {},
): Promise<RouteVerdict> {
  const model = llm.model ?? "gemini-2.5-flash";
  const timeoutMs = llm.timeoutMs ?? 4000;
  const doFetch = llm.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return llmFailVerdict(opts, "no-fetch-available");
  }

  const prompt = buildClassifierPrompt(text);
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(llm.apiKey);
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 32,
      // Gemini 2.5 bills reasoning tokens against maxOutputTokens; we want
      // the budget for the single-word answer, not hidden thinking.
      ...(isGemini25(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return llmFailVerdict(opts, `http-${res.status}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const rawText = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (!rawText) {
      return llmFailVerdict(opts, "empty-response");
    }
    const tier = normalizeTier(rawText);
    if (!tier) {
      return llmFailVerdict(opts, `unrecognized:${rawText.slice(0, 24)}`);
    }
    return {
      tier,
      model: resolveModel(tier, opts),
      rationale: `LLM classifier (${model}) returned "${tier}"`,
      confidence: 0.85,
      signals: ["llm-classifier", `llm-model:${model}`],
      viaHeuristic: false,
    };
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : (err.message.split("\n")[0] ?? "fetch-error").slice(0, 48)
        : "fetch-error";
    return llmFailVerdict(opts, reason);
  } finally {
    clearTimeout(timer);
  }
}

// Async entry: heuristic first, LLM fallback for genuine ambiguity. Caller
// must provide `llm` (with an API key) to opt into the LLM path.
export async function classifyWithLLMFallback(
  text: string,
  opts: ClassifyOptions & { llm: LLMClassifyOptions },
): Promise<RouteVerdict> {
  const h = classifyByHeuristic(text, opts);
  if (h) {
    return h;
  }
  return classifyByLLM(text, opts.llm, opts);
}

// ---- Route-and-answer (single-turn delegate) ----
//
// End-to-end primitive: classify → if trivial/contextual, call Gemini
// directly to produce an answer; if complex, either hand off to an Opus
// caller the caller supplied, or return null so the caller does it itself.
//
// Use cases:
//   1. MCP tool `memory_route_and_answer` — an LLM agent can call this
//      before committing its own quota to answer a sub-question.
//   2. CLI `orchestrator-answer.mjs` — a shell primitive for offloading
//      trivial/contextual ad-hoc questions to Gemini instead of Max.
//   3. Phase 3c gateway hook (future) — the Telegram path can call this
//      before invoking the Opus-backed agent runner.

export type RouteAndAnswerOptions = ClassifyOptions & {
  // Classifier LLM options (same shape used by classifyByLLM). The
  // answer-side calls also read `apiKey` from here.
  llm: LLMClassifyOptions;
  // Optional Opus delegate invoked for `complex` verdicts. Caller decides
  // how to reach Opus (shell to `claude -p`, SDK call, stub for tests).
  // Omit to return a null answer; the caller then does the Opus call.
  callOpus?: (text: string) => Promise<string>;
  // Optional system prompt prepended to Gemini answer calls (not the
  // classifier). Keep small — every token counts against maxOutputTokens.
  systemPrompt?: string;
  // Budget for the answer call itself. Classifier has its own timeout.
  answerTimeoutMs?: number;
  // Cap the answer-side model output (Gemini). Default 1024; raise for
  // genuinely longer answers.
  answerMaxTokens?: number;
};

export type AnsweredBy = "flash" | "pro" | "opus-delegate" | "opus-absent" | "error";

export type RouteAndAnswerResult = {
  verdict: RouteVerdict;
  // Populated when a delegate model produced an answer, OR when the opus
  // path was taken with callOpus provided. Null when the caller must handle
  // the Opus call itself (tier=complex, no callOpus).
  answer: string | null;
  answeredBy: AnsweredBy;
  // Total wall time of the whole operation (classify + answer).
  latencyMs: number;
  // Model that produced the answer, if any. Undefined for opus-absent.
  answerModel?: string;
};

async function callGeminiForAnswer(
  text: string,
  model: string,
  opts: RouteAndAnswerOptions,
): Promise<{ answer: string | null; error?: string }> {
  const apiKey = opts.llm.apiKey;
  const timeoutMs = opts.answerTimeoutMs ?? 15000;
  const maxOutputTokens = opts.answerMaxTokens ?? 1024;
  const doFetch = opts.llm.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { answer: null, error: "no-fetch-available" };
  }
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  // System prompt lives in systemInstruction on Gemini; user turn is the
  // actual question. Keep the shape minimal — this is a single-turn delegate.
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: text.trim() }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens,
      ...(isGemini25(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  if (opts.systemPrompt && opts.systemPrompt.trim()) {
    body.systemInstruction = { parts: [{ text: opts.systemPrompt.trim() }] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { answer: null, error: `http-${res.status}` };
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
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
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : (err.message.split("\n")[0] ?? "fetch-error").slice(0, 48)
        : "fetch-error";
    return { answer: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function routeAndAnswer(
  text: string,
  opts: RouteAndAnswerOptions,
): Promise<RouteAndAnswerResult> {
  const started = Date.now();
  const verdict = await classifyWithLLMFallback(text, opts);

  if (verdict.tier === "trivial" || verdict.tier === "contextual") {
    const model = verdict.tier === "trivial" ? "gemini-2.5-flash" : "gemini-2.5-pro";
    const { answer, error } = await callGeminiForAnswer(text, model, opts);
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

  // Complex: hand off to Opus if the caller wired a delegate; otherwise
  // return null so the caller can handle it their own way.
  if (opts.callOpus) {
    try {
      const answer = await opts.callOpus(text);
      return {
        verdict,
        answer,
        answeredBy: "opus-delegate",
        latencyMs: Date.now() - started,
        answerModel: "claude-opus-4-7",
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 48) : "opus-delegate-error";
      return {
        verdict: { ...verdict, signals: [...verdict.signals, `opus-delegate-error:${reason}`] },
        answer: null,
        answeredBy: "error",
        latencyMs: Date.now() - started,
      };
    }
  }

  return {
    verdict,
    answer: null,
    answeredBy: "opus-absent",
    latencyMs: Date.now() - started,
  };
}
