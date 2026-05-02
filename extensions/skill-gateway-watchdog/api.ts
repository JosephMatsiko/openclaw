// Public API barrel for @openclaw/skill-gateway-watchdog.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { probe } from "./src/probe.js";
export { findGatewayPid, readGatewayCpu, recentEventLoopBlocks } from "./src/probes.js";
export { restartGateway } from "./src/restart.js";
export { tick, type TickOptions } from "./src/tick.js";
export { summarizeStatus, type StatusSummary } from "./src/status.js";
export { ensureWatchdogDir, loadState, rollDayBucket, saveState, statePath } from "./src/state.js";
export { createEventEmitter } from "./src/events.js";
export { resolveConfig, type GatewayWatchdogConfig } from "./src/config.js";
export type {
  EventLoopBlocks,
  HistoryEntry,
  ProbeResult,
  RestartResult,
  TickAction,
  TickResult,
  WatchdogState,
} from "./src/types.js";
