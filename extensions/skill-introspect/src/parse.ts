// Response parsing — handles <OBSERVATIONS> tags, ```json fences, and
// freeform JSON arrays/objects in claude-cli output.

import type { NormalizedObservation, RawObservation } from "./types.js";

export function tryParseObservations(raw: string | undefined | null): RawObservation[] {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim();

  // Strip <OBSERVATIONS>...</OBSERVATIONS> wrapper if present (focus mode).
  const obsTagMatch = text.match(/<OBSERVATIONS>([\s\S]*?)<\/OBSERVATIONS>/i);
  if (obsTagMatch) text = obsTagMatch[1].trim();

  // Strip markdown fences.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Try outright parse.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to find a JSON array substring.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
    if (parsed == null) {
      // Try a JSON object substring with .observations.
      const oStart = text.indexOf("{");
      const oEnd = text.lastIndexOf("}");
      if (oStart !== -1 && oEnd > oStart) {
        try {
          parsed = JSON.parse(text.slice(oStart, oEnd + 1));
        } catch {
          parsed = null;
        }
      }
    }
  }
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed as RawObservation[];
  if (Array.isArray((parsed as { observations?: unknown }).observations)) {
    return (parsed as { observations: RawObservation[] }).observations;
  }
  return [];
}

export function normalizeObservation(raw: RawObservation | null): NormalizedObservation | null {
  if (!raw || typeof raw !== "object") return null;
  const category = String(raw.category ?? "uncategorized").trim();
  const observation = String(raw.observation ?? "").trim();
  const recommendation = String(raw.recommendation ?? "").trim();
  if (!observation || !recommendation) return null;
  const riskClassRaw = String(raw.risk_class ?? raw.riskClass ?? "low").toLowerCase();
  const riskClass = (["low", "medium", "high"].includes(riskClassRaw) ? riskClassRaw : "low") as
    | "low"
    | "medium"
    | "high";
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence: Array<{ source: string; snippet: string }> = rawEvidence
    .filter((e): e is { source?: string; snippet?: string } => !!e && typeof e === "object")
    .map((e) => ({
      source: String(e.source ?? "").slice(0, 200),
      snippet: String(e.snippet ?? "").slice(0, 600),
    }));
  return {
    proposedId: String(raw.id ?? "").trim() || null,
    category,
    observation,
    whyNovel: String(raw.why_novel ?? raw.whyNovel ?? "").trim(),
    recommendation,
    riskClass,
    rationale: String(raw.rationale ?? "").trim(),
    evidence,
  };
}
