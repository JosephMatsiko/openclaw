// Public API barrel for @openclaw/skill-cascade-watcher.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { handleEvent, runTest, summarizeStatus } from "./src/run.js";
export { CASCADE_TRIGGERS, findTrigger, isOwnEcho, SOURCE } from "./src/triggers.js";
export { ensureWatcherDir, loadState, saveState } from "./src/state.js";
export {
  antifloodKey,
  checkAndRecordFlood,
  pruneFloodCounters,
  type FloodCheck,
} from "./src/antiflood.js";
export {
  alreadyPromoted,
  promoteObservationToDocket,
  shouldPromoteToDocket,
  type PromoteResult,
} from "./src/promote.js";
export { fireCascade, type FireOptions } from "./src/notify.js";
export { resolveConfig, type CascadeWatcherConfig } from "./src/config.js";
export type {
  BusEvent,
  FireRecord,
  FloodCounters,
  MatchRecord,
  PromotionRecord,
  SuppressionRecord,
  Trigger,
  WatcherState,
} from "./src/types.js";
