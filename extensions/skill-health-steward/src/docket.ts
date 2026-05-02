// Docket roll-up — counts by status + stale-running detection (>2h).

import { join } from "node:path";
import type { HealthStewardConfig } from "./config.js";
import type { DocketSummary } from "./types.js";
import { readJsonSafe, safeReaddir } from "./util.js";

const STALE_RUNNING_WINDOW_MS = 2 * 60 * 60 * 1000;

interface DocketTask {
  taskId?: string;
  status?: string;
  startedAt?: string;
}

export function summarizeDocket(
  config: HealthStewardConfig,
  now: number = Date.now(),
): DocketSummary {
  const rows = safeReaddir(config.docketDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonSafe<DocketTask | null>(join(config.docketDir, name), null))
    .filter((task): task is DocketTask => task != null);
  const counts: Record<string, number> = {};
  for (const task of rows) {
    const status = String(task.status ?? "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const staleRunning = rows.filter((task) => {
    if (task.status !== "running" || !task.startedAt) return false;
    return now - Date.parse(task.startedAt) > STALE_RUNNING_WINDOW_MS;
  });
  return {
    total: rows.length,
    counts,
    pending: counts.pending ?? 0,
    running: counts.running ?? 0,
    staleRunning: staleRunning.length,
    staleRunningTaskIds: staleRunning.slice(0, 8).map((task) => String(task.taskId ?? "")),
  };
}
