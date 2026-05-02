// Shared helpers: fingerprint, readJson, ensureDir, docket loading.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SelfImprovementScannerConfig } from "./config.js";
import type { DocketTask, GapCategory } from "./types.js";

export const SCANNER_KIND = "chuck-self-improvement-scanner";

export function fingerprint(category: GapCategory | string, payload: string): string {
  return createHash("sha1").update(`${category}::${payload}`).digest("hex").slice(0, 12);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function loadDocket(config: SelfImprovementScannerConfig): DocketTask[] {
  if (!existsSync(config.docketDir)) return [];
  const out: DocketTask[] = [];
  for (const name of readdirSync(config.docketDir)) {
    if (!name.endsWith(".json")) continue;
    const t = readJson<DocketTask | null>(join(config.docketDir, name), null);
    if (t) out.push(t);
  }
  return out;
}

/** Open task fingerprints for a category (status pending|running). */
export function existingFingerprints(tasks: DocketTask[], category: GapCategory): Set<string> {
  const set = new Set<string>();
  for (const t of tasks) {
    if (t?.source?.kind !== SCANNER_KIND) continue;
    if (t?.source?.category !== category) continue;
    if (t?.status !== "pending" && t?.status !== "running") continue;
    if (t?.source?.fingerprint) set.add(t.source.fingerprint);
  }
  return set;
}
