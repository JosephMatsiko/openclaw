// Detector: stuckpending — pending task older than 6h.

import type { DetectorContext, Gap } from "../types.js";
import { fingerprint } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

export function detectStuckPending(ctx: DetectorContext): Gap[] {
  const cutoff = ctx.now - 6 * HOUR_MS;
  const out: Gap[] = [];
  for (const t of ctx.tasks) {
    if (t?.status !== "pending") continue;
    const created = t?.createdAt ? Date.parse(t.createdAt) : ctx.now;
    if (created > cutoff) continue;
    const id = t.id ?? "(unknown)";
    const fp = fingerprint("stuckpending", id);
    if (ctx.openFps.has(fp)) continue;
    out.push({
      category: "stuckpending",
      fingerprint: fp,
      title: `Diagnose stuck pending task: ${id}`,
      intent: `Diagnose why pending task ${id} ('${t.title || "untitled"}') hasn't been claimed in 6h+; check whether commandKind '${t.commandKind || "?"}' has a builder in chuck-docket-executor.mjs COMMANDS map, lane caps for surface '${t.surface || "?"}', executor-control pause state, or eligibility filters (risk, MAC_GATE).`,
    });
  }
  return out;
}
