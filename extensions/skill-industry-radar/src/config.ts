// Config resolver for @openclaw/skill-industry-radar.

import { homedir } from "node:os";
import { join } from "node:path";

export interface IndustryRadarConfig {
  enabled: boolean;
  stateDir: string;
  eventsPath: string;
  ghCliPath: string;
  ghTimeoutMs: number;
  perRepoCap: number;
  ghPerPage: number;
  fallbackLookbackHours: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: IndustryRadarConfig = {
  enabled: true,
  stateDir: expandHome("~/.openclaw/workspace/state/chuck-v3/industry-radar"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  ghCliPath: "gh",
  ghTimeoutMs: 30_000,
  perRepoCap: 8,
  ghPerPage: 50,
  fallbackLookbackHours: 36,
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

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): IndustryRadarConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    stateDir: pickPath(r, "stateDir", DEFAULTS.stateDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    ghCliPath: pickString(r, "ghCliPath", DEFAULTS.ghCliPath),
    ghTimeoutMs: pickInt(r, "ghTimeoutMs", DEFAULTS.ghTimeoutMs, { min: 1000, max: 600_000 }),
    perRepoCap: pickInt(r, "perRepoCap", DEFAULTS.perRepoCap, { min: 1, max: 100 }),
    ghPerPage: pickInt(r, "ghPerPage", DEFAULTS.ghPerPage, { min: 1, max: 100 }),
    fallbackLookbackHours: pickInt(r, "fallbackLookbackHours", DEFAULTS.fallbackLookbackHours, {
      min: 1,
      max: 720,
    }),
  };
}
