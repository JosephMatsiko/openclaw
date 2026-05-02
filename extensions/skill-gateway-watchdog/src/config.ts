// Config resolver for @openclaw/skill-gateway-watchdog.

import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayWatchdogConfig {
  enabled: boolean;
  watchdogStateDir: string;
  eventsPath: string;
  gatewayErrLogPath: string;
  gatewayLaunchdTarget: string;
  gatewayPgrepPattern: string;
  pollIntervalMs: number;
  pinDetectionWindowMs: number;
  longBlockThresholdMs: number;
  highCpuThresholdPercent: number;
  cooldownAfterRestartMs: number;
  restartBackoffBaseMs: number;
  restartBackoffMaxMs: number;
  maxRestartsPerDay: number;
  historyLimit: number;
}

const HOME = homedir();

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

const DEFAULTS: GatewayWatchdogConfig = {
  enabled: true,
  watchdogStateDir: expandHome("~/.openclaw/workspace/state/chuck-v3/gateway-watchdog"),
  eventsPath: expandHome("~/.openclaw/workspace/state/apex-events.jsonl"),
  gatewayErrLogPath: expandHome("~/.openclaw/logs/gateway.err.log"),
  gatewayLaunchdTarget: "gui/501/ai.openclaw.gateway",
  gatewayPgrepPattern: "openclaw.*dist/index.js gateway",
  pollIntervalMs: 60_000,
  pinDetectionWindowMs: 4 * 60_000,
  longBlockThresholdMs: 60_000,
  highCpuThresholdPercent: 80,
  cooldownAfterRestartMs: 5 * 60_000,
  restartBackoffBaseMs: 2 * 60_000,
  restartBackoffMaxMs: 60 * 60_000,
  maxRestartsPerDay: 12,
  historyLimit: 200,
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
): GatewayWatchdogConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: pickBoolean(r, "enabled", DEFAULTS.enabled),
    watchdogStateDir: pickPath(r, "watchdogStateDir", DEFAULTS.watchdogStateDir),
    eventsPath: pickPath(r, "eventsPath", DEFAULTS.eventsPath),
    gatewayErrLogPath: pickPath(r, "gatewayErrLogPath", DEFAULTS.gatewayErrLogPath),
    gatewayLaunchdTarget: pickString(r, "gatewayLaunchdTarget", DEFAULTS.gatewayLaunchdTarget),
    gatewayPgrepPattern: pickString(r, "gatewayPgrepPattern", DEFAULTS.gatewayPgrepPattern),
    pollIntervalMs: pickInt(r, "pollIntervalMs", DEFAULTS.pollIntervalMs, {
      min: 1000,
      max: 600_000,
    }),
    pinDetectionWindowMs: pickInt(r, "pinDetectionWindowMs", DEFAULTS.pinDetectionWindowMs, {
      min: 60_000,
      max: 3_600_000,
    }),
    longBlockThresholdMs: pickInt(r, "longBlockThresholdMs", DEFAULTS.longBlockThresholdMs, {
      min: 5_000,
      max: 600_000,
    }),
    highCpuThresholdPercent: pickInt(
      r,
      "highCpuThresholdPercent",
      DEFAULTS.highCpuThresholdPercent,
      { min: 50, max: 100 },
    ),
    cooldownAfterRestartMs: pickInt(r, "cooldownAfterRestartMs", DEFAULTS.cooldownAfterRestartMs, {
      min: 60_000,
      max: 3_600_000,
    }),
    restartBackoffBaseMs: pickInt(r, "restartBackoffBaseMs", DEFAULTS.restartBackoffBaseMs, {
      min: 30_000,
      max: 1_800_000,
    }),
    restartBackoffMaxMs: pickInt(r, "restartBackoffMaxMs", DEFAULTS.restartBackoffMaxMs, {
      min: 300_000,
      max: 86_400_000,
    }),
    maxRestartsPerDay: pickInt(r, "maxRestartsPerDay", DEFAULTS.maxRestartsPerDay, {
      min: 1,
      max: 100,
    }),
    historyLimit: pickInt(r, "historyLimit", DEFAULTS.historyLimit, { min: 10, max: 10_000 }),
  };
}
