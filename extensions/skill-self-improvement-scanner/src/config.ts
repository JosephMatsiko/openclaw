// Config resolver for @openclaw/skill-self-improvement-scanner.

import { homedir } from "node:os";
import { join } from "node:path";

export interface SelfImprovementScannerConfig {
  enabled: boolean;
  scriptsDir: string;
  docketDir: string;
  selfImprovDir: string;
  eventsPath: string;
  launchAgentsDir: string;
  skillsDir: string;
  openclawConfigPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
  maxDropsPerScan: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: SelfImprovementScannerConfig = {
  enabled: true,
  scriptsDir: expandHome("~/Projects/openclaw/extensions/memory-graph/scripts"),
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  selfImprovDir: expandHome("~/.openclaw/workspace/state/chuck-v3/self-improvement"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  launchAgentsDir: expandHome("~/Library/LaunchAgents"),
  skillsDir: expandHome("~/.claude/skills"),
  openclawConfigPath: expandHome("~/.openclaw/openclaw.json"),
  codexConfigPath: expandHome("~/.codex/config.toml"),
  claudeConfigPath: expandHome("~/.claude.json"),
  maxDropsPerScan: 5,
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
): SelfImprovementScannerConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    scriptsDir: pickPath(r, "scriptsDir", DEFAULTS.scriptsDir),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    selfImprovDir: pickPath(r, "selfImprovDir", DEFAULTS.selfImprovDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    launchAgentsDir: pickPath(r, "launchAgentsDir", DEFAULTS.launchAgentsDir),
    skillsDir: pickPath(r, "skillsDir", DEFAULTS.skillsDir),
    openclawConfigPath: pickPath(r, "openclawConfigPath", DEFAULTS.openclawConfigPath),
    codexConfigPath: pickPath(r, "codexConfigPath", DEFAULTS.codexConfigPath),
    claudeConfigPath: pickPath(r, "claudeConfigPath", DEFAULTS.claudeConfigPath),
    maxDropsPerScan: pickInt(r, "maxDropsPerScan", DEFAULTS.maxDropsPerScan, {
      min: 1,
      max: 50,
    }),
  };
}
