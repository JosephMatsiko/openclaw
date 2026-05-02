// runScan — primary entry point. Loads docket, builds per-category context,
// runs every detector, applies anti-flood cap, drops tasks. Updates
// last-scan.json with currently-open task ids per category.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SelfImprovementScannerConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { ALL_CATEGORIES, runAllDetectors } from "./detectors/index.js";
import { buildTask, writeTask } from "./task.js";
import type {
  DetectorContext,
  DocketTask,
  DropResult,
  GapCategory,
  ScanOptions,
  ScanSummary,
} from "./types.js";
import { ensureDir, existingFingerprints, loadDocket, SCANNER_KIND } from "./util.js";

export function lastScanPath(config: SelfImprovementScannerConfig): string {
  return join(config.selfImprovDir, "last-scan.json");
}

export async function runScan(
  options: ScanOptions = {},
  configIn?: SelfImprovementScannerConfig,
): Promise<ScanSummary> {
  const config = configIn ?? resolveConfig({});
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();

  ensureDir(config.selfImprovDir);
  const tasks = loadDocket(config);

  const ctxByCat = {} as Record<GapCategory, DetectorContext>;
  for (const c of ALL_CATEGORIES) {
    ctxByCat[c] = {
      tasks,
      openFps: existingFingerprints(tasks, c),
      config,
      now,
    };
  }

  const gaps = runAllDetectors(ctxByCat);
  const toEmit = gaps.slice(0, config.maxDropsPerScan);
  const skipped = gaps.length - toEmit.length;

  const dropped: DropResult[] = [];
  let nowMs = now;
  for (const gap of toEmit) {
    nowMs += 1; // bump unique ms to avoid task-id collisions
    const task = buildTask(gap, nowMs);
    if (dryRun) {
      dropped.push({
        id: task.id ?? "(noid)",
        category: gap.category,
        title: gap.title,
        dryRun: true,
      });
    } else {
      const path = writeTask(task, config);
      dropped.push({ id: task.id ?? "(noid)", category: gap.category, title: gap.title, path });
    }
  }

  if (!dryRun) {
    const refreshedTasks = loadDocket(config);
    const openByCat: Record<string, string[]> = {};
    for (const c of ALL_CATEGORIES) {
      openByCat[c] = refreshedTasks
        .filter(
          (t: DocketTask) =>
            t?.source?.kind === SCANNER_KIND &&
            t?.source?.category === c &&
            (t?.status === "pending" || t?.status === "running"),
        )
        .map((t: DocketTask) => t.id ?? "(noid)");
    }
    writeFileSync(
      lastScanPath(config),
      `${JSON.stringify(
        {
          lastScanAt: new Date(now).toISOString(),
          openTaskIdsByCategory: openByCat,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    dryRun,
    gapsFound: gaps.length,
    dropped,
    floodSkipped: skipped,
  };
}
