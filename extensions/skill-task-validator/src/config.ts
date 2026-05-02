// Config resolver for @openclaw/skill-task-validator.

import { homedir } from "node:os";
import { join } from "node:path";

export interface TaskValidatorConfig {
  enabled: boolean;
  repoRoot: string;
  docketDir: string;
  macHealLatestPath: string;
  macHealReceiptsDir: string;
  scoutsDir: string;
  priorsLatestPath: string;
  openclawConfigPath: string;
  codexConfigPath: string;
  claudeConfigPath: string;
  skipLlmLayer: boolean;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: TaskValidatorConfig = {
  enabled: true,
  repoRoot: expandHome("~/Projects/openclaw"),
  docketDir: expandHome("~/.openclaw/workspace/state/chuck-v3/docket"),
  macHealLatestPath: expandHome("~/.openclaw/workspace/state/chuck-v3/mac-self-heal/latest.json"),
  macHealReceiptsDir: expandHome("~/.openclaw/workspace/state/chuck-v3/mac-self-heal/receipts"),
  scoutsDir: expandHome("~/.openclaw/workspace/state/chuck-v3/scouts"),
  priorsLatestPath: expandHome("~/.openclaw/workspace/state/chuck-v3/priors/latest.json"),
  openclawConfigPath: expandHome("~/.openclaw/openclaw.json"),
  codexConfigPath: expandHome("~/.codex/config.toml"),
  claudeConfigPath: expandHome("~/.claude.json"),
  // v0.1 ships heuristic-only by default. The chuck-task-validator.mjs LLM
  // layer (claude-cli budget + anti-recursion + confidence floor) is queued
  // for v0.2 with proper test isolation.
  skipLlmLayer: true,
};

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) return fallback;
  return expandHome(v);
}

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): TaskValidatorConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    repoRoot: pickPath(r, "repoRoot", DEFAULTS.repoRoot),
    docketDir: pickPath(r, "docketDir", DEFAULTS.docketDir),
    macHealLatestPath: pickPath(r, "macHealLatestPath", DEFAULTS.macHealLatestPath),
    macHealReceiptsDir: pickPath(r, "macHealReceiptsDir", DEFAULTS.macHealReceiptsDir),
    scoutsDir: pickPath(r, "scoutsDir", DEFAULTS.scoutsDir),
    priorsLatestPath: pickPath(r, "priorsLatestPath", DEFAULTS.priorsLatestPath),
    openclawConfigPath: pickPath(r, "openclawConfigPath", DEFAULTS.openclawConfigPath),
    codexConfigPath: pickPath(r, "codexConfigPath", DEFAULTS.codexConfigPath),
    claudeConfigPath: pickPath(r, "claudeConfigPath", DEFAULTS.claudeConfigPath),
    skipLlmLayer: pickBoolean(r, "skipLlmLayer", DEFAULTS.skipLlmLayer),
  };
}
