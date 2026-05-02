// Introspection record store + last-scan state IO.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IntrospectConfig } from "./config.js";
import type { IntrospectionRecord, LastScanState } from "./types.js";
import { readJson, writeJson } from "./util.js";

export function findIntrospectionPath(id: string, config: IntrospectConfig): string {
  return join(config.introspectionsDir, `${id}.json`);
}

export function lastScanPath(config: IntrospectConfig): string {
  return join(config.introspectionsDir, "last-scan.json");
}

export function loadLastScan(config: IntrospectConfig): LastScanState {
  return readJson<LastScanState>(lastScanPath(config), { fingerprints: [], lastScanAt: undefined });
}

export function saveLastScan(state: LastScanState, config: IntrospectConfig): void {
  writeJson(lastScanPath(config), state);
}

export function loadAllIntrospections(config: IntrospectConfig): IntrospectionRecord[] {
  if (!existsSync(config.introspectionsDir)) return [];
  return readdirSync(config.introspectionsDir)
    .filter((n) => n.startsWith("introspect-") && n.endsWith(".json"))
    .map((n) => readJson<IntrospectionRecord | null>(join(config.introspectionsDir, n), null))
    .filter((r): r is IntrospectionRecord => r !== null);
}

export function writeIntrospection(record: IntrospectionRecord, config: IntrospectConfig): string {
  const path = findIntrospectionPath(record.id, config);
  writeJson(path, record);
  return path;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Block when fingerprint is in the last `fingerprintHistoryCap` entries OR
 * when an undismissed introspection from the last `dedupWindowDays` shares
 * the fingerprint.
 */
export function isFingerprintBlocked(
  fp: string,
  lastScan: LastScanState,
  allRecords: IntrospectionRecord[],
  config: IntrospectConfig,
  now: number = Date.now(),
): boolean {
  if (Array.isArray(lastScan.fingerprints) && lastScan.fingerprints.includes(fp)) return true;
  const cutoff = now - config.dedupWindowDays * 24 * HOUR_MS;
  for (const r of allRecords) {
    if (!r?.fingerprint || r.fingerprint !== fp) continue;
    if (r.dismissed) continue;
    const t = r.ts ? Date.parse(r.ts) : 0;
    if (t >= cutoff) return true;
  }
  return false;
}
