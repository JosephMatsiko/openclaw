// Config resolver for skill-panel-ask.
//
// Mirrors the patch-pattern from skill-workshop/src/config.ts: read the
// runtime plugin config object, apply manifest defaults, and surface a
// strongly-typed config to the rest of the plugin.

import type { PanelAskToolConfig } from "./tool.js";
import type { PanelAskMode } from "./types.js";

export interface SkillPanelAskConfig extends PanelAskToolConfig {
  enabled: boolean;
  defaultMode: PanelAskMode;
  defaultVoices: string[];
  perVoiceTimeoutMs: number;
  outputDir: string;
  scriptPath: string;
}

const DEFAULTS: SkillPanelAskConfig = {
  enabled: true,
  defaultMode: "synthesize",
  defaultVoices: [],
  perVoiceTimeoutMs: 300_000,
  outputDir: "~/Documents",
  scriptPath: "",
};

function pickString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  return typeof v === "string" ? v : fallback;
}

function pickInt(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function pickBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  return typeof v === "boolean" ? v : fallback;
}

function pickStringArray(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = raw[key];
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
    return v as string[];
  }
  return fallback;
}

function pickMode(raw: Record<string, unknown>, fallback: PanelAskMode): PanelAskMode {
  const v = raw.defaultMode;
  if (v === "raw" || v === "synthesize") return v;
  return fallback;
}

export function resolveConfig(
  raw: Record<string, unknown> | null | undefined,
): SkillPanelAskConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    defaultMode: pickMode(r, DEFAULTS.defaultMode),
    defaultVoices: pickStringArray(r, "defaultVoices", DEFAULTS.defaultVoices),
    perVoiceTimeoutMs: pickInt(r, "perVoiceTimeoutMs", DEFAULTS.perVoiceTimeoutMs),
    outputDir: pickString(r, "outputDir", DEFAULTS.outputDir),
    scriptPath: pickString(r, "scriptPath", DEFAULTS.scriptPath),
  };
}
