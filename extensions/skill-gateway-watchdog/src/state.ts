// State IO + day-bucket helper. The watchdog state file lives at
// <watchdogStateDir>/state.json and persists restart counts + cooldown
// timestamps across daemon restarts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayWatchdogConfig } from "./config.js";
import type { WatchdogState } from "./types.js";

export function statePath(config: GatewayWatchdogConfig): string {
  return join(config.watchdogStateDir, "state.json");
}

export function ensureWatchdogDir(config: GatewayWatchdogConfig): void {
  if (!existsSync(config.watchdogStateDir)) {
    mkdirSync(config.watchdogStateDir, { recursive: true });
  }
}

function emptyState(): WatchdogState {
  return {
    startedAt: null,
    lastProbe: {
      ts: new Date().toISOString(),
      pid: null,
      cpu: null,
      eventLoopBlocks: { count: 0, maxBlockMs: 0, lastTs: null },
      healthy: false,
      reason: "no probe yet",
    },
    history: [],
    restartCount: 0,
    restartCountToday: 0,
    todayKey: new Date().toISOString().slice(0, 10),
    nextRestartAllowedMs: 0,
    consecutiveRestartFailures: 0,
  };
}

export function loadState(config: GatewayWatchdogConfig): WatchdogState {
  const path = statePath(config);
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WatchdogState>;
    return {
      ...emptyState(),
      ...raw,
      lastProbe: raw.lastProbe ?? emptyState().lastProbe,
      history: Array.isArray(raw.history) ? raw.history : [],
      todayKey: raw.todayKey ?? new Date().toISOString().slice(0, 10),
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state: WatchdogState, config: GatewayWatchdogConfig): void {
  ensureWatchdogDir(config);
  const trimmed: WatchdogState = {
    ...state,
    history: state.history.slice(-config.historyLimit),
  };
  writeFileSync(statePath(config), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
}

export function rollDayBucket(state: WatchdogState, now: Date = new Date()): void {
  const todayKey = now.toISOString().slice(0, 10);
  if (state.todayKey !== todayKey) {
    state.todayKey = todayKey;
    state.restartCountToday = 0;
  }
}
