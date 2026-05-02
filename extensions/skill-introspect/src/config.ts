// Config resolver for @openclaw/skill-introspect.

import { homedir } from "node:os";
import { join } from "node:path";

export interface IntrospectConfig {
  enabled: boolean;
  introspectionsDir: string;
  eventsPath: string;
  docketDir: string;
  decisionsDir: string;
  macHealReceiptsDir: string;
  notificationLedgerDir: string;
  selfImprovementLastScanPath: string;
  healthSnapshotPath: string;
  priorsLatestPath: string;
  dissentDir: string;
  claudeCliPath: string;
  claudeModel: string;
  claudeTimeoutMs: number;
  maxObservationsPerScan: number;
  fingerprintHistoryCap: number;
  dedupWindowDays: number;
  priorHeadChars: number;
  healthHeadChars: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: IntrospectConfig = {
  enabled: true,
  introspectionsDir: expandHome("~/.openclaw/workspace/state/chuck-v3/introspections"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  decisionsDir: expandHome("~/.openclaw/workspace/state/chuck-v3/decisions"),
  macHealReceiptsDir: expandHome("~/.openclaw/workspace/state/chuck-v3/mac-self-heal/receipts"),
  notificationLedgerDir: expandHome("~/.openclaw/workspace/state/chuck-v3/notification-ledger"),
  selfImprovementLastScanPath: expandHome(
    "~/.openclaw/workspace/state/chuck-v3/self-improvement/last-scan.json",
  ),
  healthSnapshotPath: expandHome("~/.openclaw/workspace/state/chuck-v3/health-snapshot.json"),
  priorsLatestPath: expandHome("~/.openclaw/workspace/state/chuck-v3/priors/latest.json"),
  dissentDir: expandHome("~/.openclaw/workspace/state/chuck-v3/dissent"),
  claudeCliPath: "claude",
  claudeModel: "opus",
  claudeTimeoutMs: 5 * 60_000,
  maxObservationsPerScan: 3,
  fingerprintHistoryCap: 50,
  dedupWindowDays: 7,
  priorHeadChars: 8000,
  healthHeadChars: 4000,
};

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const v = raw[key];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return fallback;
  if (bounds?.min != null && v < bounds.min) return fallback;
  if (bounds?.max != null && v > bounds.max) return fallback;
  return v;
}

function pickString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(raw: Record<string, unknown> | null | undefined): IntrospectConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    introspectionsDir: pickPath(r, "introspectionsDir", DEFAULTS.introspectionsDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    decisionsDir: pickPath(r, "decisionsDir", DEFAULTS.decisionsDir),
    macHealReceiptsDir: pickPath(r, "macHealReceiptsDir", DEFAULTS.macHealReceiptsDir),
    notificationLedgerDir: pickPath(r, "notificationLedgerDir", DEFAULTS.notificationLedgerDir),
    selfImprovementLastScanPath: pickPath(
      r,
      "selfImprovementLastScanPath",
      DEFAULTS.selfImprovementLastScanPath,
    ),
    healthSnapshotPath: pickPath(r, "healthSnapshotPath", DEFAULTS.healthSnapshotPath),
    priorsLatestPath: pickPath(r, "priorsLatestPath", DEFAULTS.priorsLatestPath),
    dissentDir: pickPath(r, "dissentDir", DEFAULTS.dissentDir),
    claudeCliPath: pickString(r, "claudeCliPath", DEFAULTS.claudeCliPath),
    claudeModel: pickString(r, "claudeModel", DEFAULTS.claudeModel),
    claudeTimeoutMs: pickInt(r, "claudeTimeoutMs", DEFAULTS.claudeTimeoutMs, {
      min: 30_000,
      max: 1_800_000,
    }),
    maxObservationsPerScan: pickInt(r, "maxObservationsPerScan", DEFAULTS.maxObservationsPerScan, {
      min: 1,
      max: 20,
    }),
    fingerprintHistoryCap: pickInt(r, "fingerprintHistoryCap", DEFAULTS.fingerprintHistoryCap, {
      min: 10,
      max: 1000,
    }),
    dedupWindowDays: pickInt(r, "dedupWindowDays", DEFAULTS.dedupWindowDays, {
      min: 1,
      max: 30,
    }),
    priorHeadChars: pickInt(r, "priorHeadChars", DEFAULTS.priorHeadChars, {
      min: 1000,
      max: 100_000,
    }),
    healthHeadChars: pickInt(r, "healthHeadChars", DEFAULTS.healthHeadChars, {
      min: 500,
      max: 50_000,
    }),
  };
}
