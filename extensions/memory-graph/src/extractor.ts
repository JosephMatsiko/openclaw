import type { GraphNodeKind } from "./types.js";

// Rule-based claim extraction.
//
// Extracts typed nodes from user text in a completed turn. Patterns are
// deliberately conservative: false positives add noise and drift the graph,
// false negatives just mean a claim isn't captured yet (a later turn can
// restate it, or a future LLM-backed extractor can catch it). Every pattern
// declares its own confidence so downstream retrieval can rank high-signal
// claims ahead of looser ones.

export type ExtractedClaim = {
  kind: GraphNodeKind;
  summary: string;
  body?: string;
  confidence: number;
};

type Pattern = {
  kind: GraphNodeKind;
  regex: RegExp;
  format: (match: RegExpMatchArray) => string;
  confidence: number;
};

const SUMMARY_MIN = 2;
const SUMMARY_MAX = 200;

const PATTERNS: readonly Pattern[] = [
  // Direct "remember" — the highest-signal instruction. "Please remember
  // that I'm allergic to peanuts" → fact "I'm allergic to peanuts".
  {
    kind: "fact",
    regex: /\b(?:please\s+)?remember\s+(?:that\s+)?(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => (m[1] ?? "").trim(),
    confidence: 0.98,
  },
  // Identity facts: "I'm allergic to X", "I'm from Y", etc.
  {
    kind: "fact",
    regex:
      /\bi(?:\s+am|'m)\s+(allergic\s+to|afraid\s+of|from|based\s+in|living\s+in|married\s+to|working\s+(?:at|for)|born\s+in|named)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `I'm ${(m[1] ?? "").trim()} ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.9,
  },
  // Possessive identity: "my name is X", "my wife is Sarah".
  {
    kind: "fact",
    regex:
      /\b(?:my|our)\s+(name|age|wife|husband|spouse|partner|son|daughter|kid|child|cat|dog|pet|address|phone|email|job|role|title|company|boss|manager|teammate|birthday|deadline)\s+(?:is|are)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `${(m[1] ?? "").trim()} is ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.9,
  },
  // Favorites → preference. "My favorite color is cobalt blue".
  {
    kind: "preference",
    regex: /\bmy\s+favorite\s+(\w+(?:\s+\w+)?)\s+(?:is|are)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `favorite ${(m[1] ?? "").trim()}: ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.9,
  },
  // Generic like/prefer. Lower confidence — easy to false-positive.
  {
    kind: "preference",
    regex: /\bi\s+(like|love|adore|enjoy|hate|dislike|prefer)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => `${(m[1] ?? "").trim()} ${(m[2] ?? "").trim()}`.trim(),
    confidence: 0.75,
  },
  // Open loops / TODOs.
  {
    kind: "open-loop",
    regex:
      /\b(?:remind\s+me\s+to|i\s+need\s+to|i\s+have\s+to|i\s+must|don'?t\s+let\s+me\s+forget\s+to|follow\s+up\s+(?:on|about)|todo:)\s+(.+?)(?:[.!?\n]|$)/gi,
    format: (m) => (m[1] ?? "").trim(),
    confidence: 0.9,
  },
  // Can't / won't. Conservative confidence because "I can't believe X" isn't
  // always a real constraint on future behavior.
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

function sanitizeSummary(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length < SUMMARY_MIN || trimmed.length > SUMMARY_MAX) {
    return null;
  }
  return trimmed;
}

export function extractClaims(text: string): ExtractedClaim[] {
  if (!text || typeof text !== "string") {
    return [];
  }
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const seen = new Set<string>();
  const claims: ExtractedClaim[] = [];
  for (const pattern of PATTERNS) {
    const matches = normalized.matchAll(pattern.regex);
    for (const match of matches) {
      const summary = sanitizeSummary(pattern.format(match));
      if (!summary) {
        continue;
      }
      const key = `${pattern.kind}:${summary.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      claims.push({
        kind: pattern.kind,
        summary,
        confidence: pattern.confidence,
      });
    }
  }
  return claims;
}
