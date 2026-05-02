// Config resolver for @openclaw/skill-cascade-watcher.

import { homedir } from "node:os";
import { join } from "node:path";

export interface CascadeWatcherConfig {
  enabled: boolean;
  eventsPath: string;
  watcherStateDir: string;
  docketDir: string;
  pollIntervalMs: number;
  seenBacklogLines: number;
  seenCacheMax: number;
  antifloodWindowMs: number;
  antifloodMaxFires: number;
  stateRecentLimit: number;
  promotedRecentLimit: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: CascadeWatcherConfig = {
  enabled: true,
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  watcherStateDir: expandHome("~/.openclaw/workspace/state/chuck-v3/cascade-watcher"),
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  pollIntervalMs: 500,
  seenBacklogLines: 200,
  seenCacheMax: 5000,
  antifloodWindowMs: 300_000,
  antifloodMaxFires: 3,
  stateRecentLimit: 50,
  promotedRecentLimit: 200,
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

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): CascadeWatcherConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    watcherStateDir: pickPath(r, "watcherStateDir", DEFAULTS.watcherStateDir),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    pollIntervalMs: pickInt(r, "pollIntervalMs", DEFAULTS.pollIntervalMs, {
      min: 100,
      max: 10_000,
    }),
    seenBacklogLines: pickInt(r, "seenBacklogLines", DEFAULTS.seenBacklogLines, {
      min: 0,
      max: 5000,
    }),
    seenCacheMax: pickInt(r, "seenCacheMax", DEFAULTS.seenCacheMax, { min: 100, max: 100_000 }),
    antifloodWindowMs: pickInt(r, "antifloodWindowMs", DEFAULTS.antifloodWindowMs, {
      min: 1000,
      max: 3_600_000,
    }),
    antifloodMaxFires: pickInt(r, "antifloodMaxFires", DEFAULTS.antifloodMaxFires, {
      min: 1,
      max: 100,
    }),
    stateRecentLimit: pickInt(r, "stateRecentLimit", DEFAULTS.stateRecentLimit, {
      min: 1,
      max: 1000,
    }),
    promotedRecentLimit: pickInt(r, "promotedRecentLimit", DEFAULTS.promotedRecentLimit, {
      min: 1,
      max: 10_000,
    }),
  };
}
