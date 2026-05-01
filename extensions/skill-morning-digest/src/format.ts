// Format the digest data into markdown / banner / JSON. Pure functions.

import type { MorningDigestConfig } from "./config.js";
import type { DigestData, DigestSummary, DocketTaskRecord } from "./types.js";

function shortLine(task: DocketTaskRecord): string {
  const title = (task.title ?? "").replace(/\s+/g, " ").trim();
  return title.length > 90 ? `${title.slice(0, 87)}...` : title;
}

export function fmtMarkdown(d: DigestData, maxItems: number): string {
  const date = new Date(d.window.endMs).toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Chuck morning digest - ${date}`);
  lines.push("");
  lines.push(`Window: ${d.window.startIso} -> ${d.window.endIso}`);
  lines.push("");
  lines.push(`**Shipped (${d.shipped.length}):**`);
  if (d.shipped.length === 0) lines.push("  (none)");
  for (const t of d.shipped.slice(0, maxItems)) {
    lines.push(`  - ${shortLine(t)}`);
  }
  lines.push("");
  lines.push(`**Blockers / failed (${d.blockers.length}):**`);
  if (d.blockers.length === 0) lines.push("  (none)");
  for (const t of d.blockers.slice(0, maxItems)) {
    lines.push(`  - [${t.status}] ${shortLine(t)}`);
  }
  lines.push("");
  lines.push(`**Decisions auto-applied (${d.decisions.length}):**`);
  if (d.decisions.length === 0) lines.push("  (none)");
  for (const e of d.decisions.slice(0, maxItems)) {
    lines.push(`  - ${e.type}`);
  }
  lines.push("");
  lines.push(`**Awaiting Joseph (${d.awaiting.length}):**`);
  if (d.awaiting.length === 0) lines.push("  (none)");
  for (const t of d.awaiting.slice(0, maxItems)) {
    lines.push(`  - ${shortLine(t)}`);
  }
  return lines.join("\n");
}

export function fmtBanner(d: DigestData, maxChars: number): string {
  const banner = `Chuck digest: ${d.shipped.length} shipped, ${d.blockers.length} blocked, ${d.decisions.length} decisions, ${d.awaiting.length} awaiting Joseph`;
  return banner.length > maxChars ? `${banner.slice(0, maxChars - 3)}...` : banner;
}

export function fmtSummary(d: DigestData): DigestSummary {
  return {
    ts: new Date().toISOString(),
    window: { startIso: d.window.startIso, endIso: d.window.endIso },
    counts: {
      shipped: d.shipped.length,
      blockers: d.blockers.length,
      decisions: d.decisions.length,
      awaiting: d.awaiting.length,
    },
    shipped: d.shipped.map((t) => ({ id: t.id, title: shortLine(t) })),
    blockers: d.blockers.map((t) => ({ id: t.id, status: t.status, title: shortLine(t) })),
    decisions: d.decisions,
    awaiting: d.awaiting.map((t) => ({ id: t.id, title: shortLine(t) })),
  };
}

export function formatAll(
  d: DigestData,
  config: MorningDigestConfig,
): {
  markdown: string;
  banner: string;
  summary: DigestSummary;
} {
  return {
    markdown: fmtMarkdown(d, config.windowSectionMaxItems),
    banner: fmtBanner(d, config.bannerMaxChars),
    summary: fmtSummary(d),
  };
}
