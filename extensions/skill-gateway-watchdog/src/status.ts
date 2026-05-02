// summarizeStatus — fast read-only snapshot for the cockpit / introspect /
// the cascade-watcher. Probes once + reads persisted state.

import type { GatewayWatchdogConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { probe } from "./probe.js";
import { loadState, rollDayBucket } from "./state.js";
import type { HistoryEntry, ProbeResult, WatchdogState } from "./types.js";

export interface StatusSummary {
  daemonStartedAt: string | null;
  lastProbe: WatchdogState["lastProbe"];
  currentProbe: ProbeResult;
  restartCount: number;
  restartCountToday: number;
  consecutiveRestartFailures: number;
  nextRestartAllowedAt: string | null;
  historyTail: HistoryEntry[];
  config: {
    pollIntervalMs: number;
    pinDetectionWindowMs: number;
    longBlockThresholdMs: number;
    highCpuThresholdPercent: number;
    cooldownAfterRestartMs: number;
    maxRestartsPerDay: number;
  };
}

export function summarizeStatus(configIn?: GatewayWatchdogConfig): StatusSummary {
  const config = configIn ?? resolveConfig({});
  const state = loadState(config);
  rollDayBucket(state);
  const p = probe(config);
  return {
    daemonStartedAt: state.startedAt,
    lastProbe: state.lastProbe,
    currentProbe: p,
    restartCount: state.restartCount,
    restartCountToday: state.restartCountToday,
    consecutiveRestartFailures: state.consecutiveRestartFailures,
    nextRestartAllowedAt: state.nextRestartAllowedMs
      ? new Date(state.nextRestartAllowedMs).toISOString()
      : null,
    historyTail: state.history.slice(-10).reverse(),
    config: {
      pollIntervalMs: config.pollIntervalMs,
      pinDetectionWindowMs: config.pinDetectionWindowMs,
      longBlockThresholdMs: config.longBlockThresholdMs,
      highCpuThresholdPercent: config.highCpuThresholdPercent,
      cooldownAfterRestartMs: config.cooldownAfterRestartMs,
      maxRestartsPerDay: config.maxRestartsPerDay,
    },
  };
}
