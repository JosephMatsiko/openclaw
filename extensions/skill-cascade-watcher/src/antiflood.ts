// Anti-flood gate. Per (triggerType + source), more than `maxFires` inside
// `windowMs` suppresses further fires until the window resets.

import type { CascadeWatcherConfig } from "./config.js";
import type { WatcherState } from "./types.js";

export interface FloodCheck {
  suppressed: boolean;
  count: number;
  windowMs: number;
  key: string;
}

export function antifloodKey(triggerType: string, source: string | undefined): string {
  return `${triggerType}::${source ?? "unknown"}`;
}

export function pruneFloodCounters(state: WatcherState, nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs;
  for (const [key, entry] of Object.entries(state.floodCounters)) {
    entry.fires = (entry.fires ?? []).filter((ts) => ts >= cutoff);
    if (entry.fires.length === 0) delete state.floodCounters[key];
  }
}

export function checkAndRecordFlood(
  state: WatcherState,
  triggerType: string,
  source: string | undefined,
  nowMs: number,
  config: CascadeWatcherConfig,
): FloodCheck {
  pruneFloodCounters(state, nowMs, config.antifloodWindowMs);
  const key = antifloodKey(triggerType, source);
  const entry = state.floodCounters[key] ?? { fires: [] };
  if (entry.fires.length >= config.antifloodMaxFires) {
    return { suppressed: true, count: entry.fires.length, windowMs: config.antifloodWindowMs, key };
  }
  entry.fires.push(nowMs);
  state.floodCounters[key] = entry;
  return {
    suppressed: false,
    count: entry.fires.length,
    windowMs: config.antifloodWindowMs,
    key,
  };
}
