// Scout-section parsing — CLAIMS / RISKS / MISSING_EVIDENCE / DEEPEN_NEEDED
// + freeform Recommendation extraction.

import type { ScoutSections } from "./types.js";
import { cleanBullet } from "./util.js";

const LABEL_RX = /^(?:#+\s*)?(CLAIMS|RISKS|MISSING[_ ]EVIDENCE|DEEPEN_NEEDED)\s*:?\s*(.*)$/i;
const SECTION_BREAK_RX =
  /^(?:#+\s*)?(Family-Specific Critique|Verdict|Strongest Insight|Protocol Failure|One Concrete Implementation Recommendation|Concrete Implementation Recommendation|Recommendation|Recommended Next Actions)\s*:?/i;
const RECOMMENDATION_HEADER_RX =
  /^(?:#+\s*)?(One Concrete Implementation Recommendation|Concrete Implementation Recommendation|Recommendation|Recommended Next Actions)\s*:?/i;
const RECOMMENDATION_BREAK_RX =
  /^(?:#+\s*)?(CLAIMS|RISKS|MISSING[_ ]EVIDENCE|DEEPEN_NEEDED|Verdict|Strongest Insight|Protocol Failure)\s*:?/i;

type SectionKey = "claims" | "risks" | "missingEvidence" | "deepenNeeded" | null;

function labelName(label: string): SectionKey {
  const normalized = label.toUpperCase().replace(/\s+/g, "_");
  if (normalized === "CLAIMS") return "claims";
  if (normalized === "RISKS") return "risks";
  if (normalized === "MISSING_EVIDENCE") return "missingEvidence";
  if (normalized === "DEEPEN_NEEDED") return "deepenNeeded";
  return null;
}

function addSectionLine(sections: ScoutSections, current: SectionKey, line: string): void {
  if (!current) return;
  const cleaned = cleanBullet(line);
  if (!cleaned) return;
  if (current === "deepenNeeded") {
    if (/\byes\b/i.test(cleaned)) sections.deepenNeeded = "yes";
    else if (/\bno\b/i.test(cleaned)) sections.deepenNeeded = "no";
    return;
  }
  sections[current].push(cleaned);
}

export function parseScoutSections(text: string | null | undefined): ScoutSections {
  const sections: ScoutSections = {
    claims: [],
    risks: [],
    missingEvidence: [],
    deepenNeeded: "unknown",
  };
  let current: SectionKey = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const label = line.match(LABEL_RX);
    if (label) {
      current = labelName(label[1] ?? "");
      if (label[2]) addSectionLine(sections, current, label[2]);
      continue;
    }
    if (SECTION_BREAK_RX.test(line)) {
      current = null;
    }
    addSectionLine(sections, current, line);
  }
  return sections;
}

export function extractRecommendations(
  text: string | null | undefined,
  sections: ScoutSections,
  cap = 8,
): string[] {
  const recommendations: string[] = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let collecting = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (collecting) break;
      continue;
    }
    if (RECOMMENDATION_HEADER_RX.test(line)) {
      collecting = true;
      const after = line.replace(RECOMMENDATION_HEADER_RX, "").replace(/^[:\s]+/, "");
      if (after) recommendations.push(cleanBullet(after));
      continue;
    }
    if (collecting && RECOMMENDATION_BREAK_RX.test(line)) {
      break;
    }
    if (collecting) recommendations.push(cleanBullet(line));
  }
  if (
    recommendations.length === 0 &&
    String(text ?? "").length < 500 &&
    sections.claims.length === 0
  ) {
    recommendations.push(cleanBullet(text ?? ""));
  }
  return recommendations.filter(Boolean).slice(0, cap);
}
