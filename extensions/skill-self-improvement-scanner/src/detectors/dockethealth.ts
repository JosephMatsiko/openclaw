// Detector: dockethealth — >5 failed tasks in 24h.

import type { DetectorContext, Gap } from "../types.js";
import { fingerprint } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

export function detectDocketHealth(ctx: DetectorContext): Gap | null {
  const cutoff = ctx.now - 24 * HOUR_MS;
  const recent = ctx.tasks.filter(
    (t) => t?.status === "failed" && t?.finishedAt && Date.parse(t.finishedAt) >= cutoff,
  );
  if (recent.length <= 5) return null;
  const list = recent
    .slice(0, 10)
    .map((t) => `${t.id} ('${t.title || "untitled"}'; exit=${t.exitCode ?? "?"})`);
  const fp = fingerprint(
    "dockethealth",
    recent
      .map((t) => t.id ?? "(noid)")
      .sort()
      .join(","),
  );
  if (ctx.openFps.has(fp)) return null;
  return {
    category: "dockethealth",
    fingerprint: fp,
    title: `Investigate cluster of ${recent.length} recent docket failures`,
    intent: `Investigate the cluster of ${recent.length} recent failures in the last 24h: ${list.join("; ")}. Pull rollouts/heartbeats, identify common failure mode (executor blocker, lane cap, builder bug, model quota, MCP outage), propose fix or quarantine.`,
  };
}
