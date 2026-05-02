// Watcher state IO — JSON file at watcherStateDir/state.json.
// Trim arrays on save so the file stays bounded across long-running daemons.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CascadeWatcherConfig } from "./config.js";
import type { WatcherState } from "./types.js";

export function statePath(config: CascadeWatcherConfig): string {
  return join(config.watcherStateDir, "state.json");
}

export function ensureWatcherDir(config: CascadeWatcherConfig): void {
  if (!existsSync(config.watcherStateDir)) mkdirSync(config.watcherStateDir, { recursive: true });
  if (!existsSync(config.docketDir)) mkdirSync(config.docketDir, { recursive: true });
}

export function loadState(config: CascadeWatcherConfig): WatcherState {
  const path = statePath(config);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  return {
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    pid: typeof raw.pid === "number" ? raw.pid : null,
    matches: Array.isArray(raw.matches) ? (raw.matches as WatcherState["matches"]) : [],
    fires: Array.isArray(raw.fires) ? (raw.fires as WatcherState["fires"]) : [],
    suppressions: Array.isArray(raw.suppressions)
      ? (raw.suppressions as WatcherState["suppressions"])
      : [],
    promotions: Array.isArray(raw.promotions) ? (raw.promotions as WatcherState["promotions"]) : [],
    floodCounters:
      raw.floodCounters && typeof raw.floodCounters === "object"
        ? (raw.floodCounters as WatcherState["floodCounters"])
        : {},
  };
}

export function saveState(state: WatcherState, config: CascadeWatcherConfig): void {
  // Trim recent arrays. Promotions get a larger budget because they're cheap
  // and we use them for cross-restart idempotency.
  const trimmed: WatcherState = {
    ...state,
    matches: state.matches.slice(-config.stateRecentLimit),
    fires: state.fires.slice(-config.stateRecentLimit),
    suppressions: state.suppressions.slice(-config.stateRecentLimit),
    promotions: state.promotions.slice(-config.promotedRecentLimit),
  };
  writeFileSync(statePath(config), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
}
