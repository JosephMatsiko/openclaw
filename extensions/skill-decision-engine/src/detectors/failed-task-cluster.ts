// Detector: failed-task-cluster — >=3 failed tasks in 6h sharing commandKind.

import type { Detector, DetectorHit } from "../types.js";
import { fingerprint } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

export const detectFailedTaskCluster: Detector = ({ tasks, now }): DetectorHit | null => {
  const cutoff = now.getTime() - 6 * HOUR_MS;
  const recent = tasks.filter((t) => {
    if (t?.status !== "failed") return false;
    if (typeof t.commandKind !== "string" || !t.updatedAt) return false;
    return Date.parse(t.updatedAt) >= cutoff;
  });
  if (recent.length < 3) return null;

  const byKind = new Map<string, number>();
  for (const t of recent) {
    const kind = t.commandKind as string;
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  let bestKind: string | null = null;
  let bestCount = 0;
  for (const [k, c] of byKind) {
    if (c > bestCount) {
      bestKind = k;
      bestCount = c;
    }
  }
  if (bestKind == null || bestCount < 3) return null;

  const ids = recent
    .filter((t) => t.commandKind === bestKind)
    .map((t) => t.id ?? t.taskId ?? "(unknown)")
    .slice(0, 8);

  return {
    category: "failed-task-cluster",
    fingerprint: fingerprint("failed-task-cluster", `${bestKind}:${bestCount}`),
    situation: `Lane '${bestKind}' shows ${bestCount} failed tasks in last 6h`,
    options: [
      {
        label: "investigate",
        action: "Read task heartbeats + executor logs to identify root cause",
      },
      {
        label: "quarantine",
        action: `Add commandKind '${bestKind}' to executor pause list until cause identified`,
      },
    ],
    recommendation: "investigate",
    rationale: `${bestCount} failures clustered on same commandKind in 6h suggests a systemic issue (builder bug, model quota, MCP outage). Investigation surfaces the root cause; quarantine masks it.`,
    riskClass: "medium",
    evidence: { commandKind: bestKind, count: bestCount, taskIds: ids, windowHours: 6 },
    rollback: `If quarantine is chosen, remove '${bestKind}' from executor pause list to resume promotion.`,
  };
};
