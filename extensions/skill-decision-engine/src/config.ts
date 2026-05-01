// Config resolver for @openclaw/skill-decision-engine.

import { homedir } from "node:os";
import { join } from "node:path";

export interface DecisionEngineConfig {
  enabled: boolean;
  telegramChatId: string;
  scriptsDir: string;
  docketDir: string;
  decisionsDir: string;
  eventsPath: string;
  macHealLatestPath: string;
  openclawConfigPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
  maxProposalsPerScan: number;
  fingerprintDedupHours: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: DecisionEngineConfig = {
  enabled: true,
  telegramChatId: "8630163522",
  scriptsDir: expandHome("~/Projects/openclaw/extensions/memory-graph/scripts"),
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  decisionsDir: expandHome("~/.openclaw/workspace/state/chuck-v3/decisions"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  macHealLatestPath: expandHome("~/.openclaw/workspace/state/chuck-v3/mac-self-heal/latest.json"),
  openclawConfigPath: expandHome("~/.openclaw/openclaw.json"),
  codexConfigPath: expandHome("~/.codex/config.toml"),
  claudeConfigPath: expandHome("~/.claude.json"),
  maxProposalsPerScan: 3,
  fingerprintDedupHours: 12,
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
): DecisionEngineConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    telegramChatId: pickString(r, "telegramChatId", DEFAULTS.telegramChatId),
    scriptsDir: pickPath(r, "scriptsDir", DEFAULTS.scriptsDir),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    decisionsDir: pickPath(r, "decisionsDir", DEFAULTS.decisionsDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    macHealLatestPath: pickPath(r, "macHealLatestPath", DEFAULTS.macHealLatestPath),
    openclawConfigPath: pickPath(r, "openclawConfigPath", DEFAULTS.openclawConfigPath),
    codexConfigPath: pickPath(r, "codexConfigPath", DEFAULTS.codexConfigPath),
    claudeConfigPath: pickPath(r, "claudeConfigPath", DEFAULTS.claudeConfigPath),
    maxProposalsPerScan: pickInt(r, "maxProposalsPerScan", DEFAULTS.maxProposalsPerScan, {
      min: 1,
      max: 50,
    }),
    fingerprintDedupHours: pickInt(r, "fingerprintDedupHours", DEFAULTS.fingerprintDedupHours, {
      min: 1,
      max: 168,
    }),
  };
}
