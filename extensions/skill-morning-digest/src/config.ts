// Config resolver for @openclaw/skill-morning-digest.

import { homedir } from "node:os";
import { join } from "node:path";

export interface MorningDigestConfig {
  enabled: boolean;
  telegramChatId: string;
  docketDir: string;
  eventsPath: string;
  digestDir: string;
  anchorHour: number;
  anchorMinute: number;
  windowSectionMaxItems: number;
  bannerMaxChars: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: MorningDigestConfig = {
  enabled: true,
  telegramChatId: "8630163522",
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  digestDir: expandHome("~/.openclaw/workspace/state/chuck-v3/morning-digest"),
  anchorHour: 8,
  anchorMinute: 5,
  windowSectionMaxItems: 8,
  bannerMaxChars: 180,
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
  return typeof v === "string" ? v : fallback;
}

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): MorningDigestConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    telegramChatId: pickString(r, "telegramChatId", DEFAULTS.telegramChatId),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    digestDir: pickPath(r, "digestDir", DEFAULTS.digestDir),
    anchorHour: pickInt(r, "anchorHour", DEFAULTS.anchorHour, { min: 0, max: 23 }),
    anchorMinute: pickInt(r, "anchorMinute", DEFAULTS.anchorMinute, { min: 0, max: 59 }),
    windowSectionMaxItems: pickInt(r, "windowSectionMaxItems", DEFAULTS.windowSectionMaxItems, {
      min: 1,
      max: 100,
    }),
    bannerMaxChars: pickInt(r, "bannerMaxChars", DEFAULTS.bannerMaxChars, { min: 60, max: 500 }),
  };
}
