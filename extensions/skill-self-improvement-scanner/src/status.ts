// summarizeStatus — read-only snapshot: open task ids per category +
// last-scan timestamp.

import type { SelfImprovementScannerConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { ALL_CATEGORIES } from "./detectors/index.js";
import { lastScanPath } from "./scan.js";
import type { DocketTask, GapCategory } from "./types.js";
import { loadDocket, readJson, SCANNER_KIND } from "./util.js";

export interface StatusSummary {
  lastScanAt: string | null;
  openTaskIdsByCategory: Record<string, Array<{ id: string; status: string; title: string }>>;
  counts: Record<string, number>;
}

export function summarizeStatus(configIn?: SelfImprovementScannerConfig): StatusSummary {
  const config = configIn ?? resolveConfig({});
  const last = readJson<{ lastScanAt?: string } | null>(lastScanPath(config), null);
  const tasks = loadDocket(config);
  const openByCat: StatusSummary["openTaskIdsByCategory"] = {};
  for (const c of ALL_CATEGORIES as GapCategory[]) {
    openByCat[c] = tasks
      .filter(
        (t: DocketTask) =>
          t?.source?.kind === SCANNER_KIND &&
          t?.source?.category === c &&
          (t?.status === "pending" || t?.status === "running"),
      )
      .map((t: DocketTask) => ({
        id: t.id ?? "(noid)",
        status: t.status ?? "",
        title: t.title ?? "",
      }));
  }
  return {
    lastScanAt: last?.lastScanAt ?? null,
    openTaskIdsByCategory: openByCat,
    counts: Object.fromEntries(Object.entries(openByCat).map(([k, v]) => [k, v.length])),
  };
}
