// Public API barrel for @openclaw/skill-reach-cascade.
//
// Re-exports the SDK seams needed by the plugin entrypoint plus this plugin's
// own narrow surface. Other openclaw code that wants to drive the cascade
// programmatically (chuck-cascade-watcher, etc.) should go through `notify()`
// (first-success cascade) or `broadcast()` (parallel fan-out) here instead
// of reaching into `./src/*`.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { notify } from "./src/notify.js";
export { broadcast, type BroadcastOptions, type BroadcastResult } from "./src/broadcast.js";
export { listRecentLedger, findLedgerEntry, summarizeStatus, replay } from "./src/status.js";
export { resolveConfig, type ReachCascadeConfig } from "./src/config.js";
export { DEFAULT_CASCADE, resolveCascadeOrder } from "./src/cascade.js";
export type {
  AttemptResult,
  CascadeAttempt,
  ChannelName,
  LedgerEntry,
  NotifyOptions,
  NotifyOrigin,
  NotifyPayload,
  NotifyResult,
  Severity,
  Tier,
} from "./src/types.js";
