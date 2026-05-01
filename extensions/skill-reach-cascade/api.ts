// Public API barrel for @openclaw/skill-reach-cascade.
//
// Re-exports the SDK seams needed by the plugin entrypoint plus this plugin's
// own narrow surface. Other openclaw code that wants to drive the cascade
// programmatically (chuck-cascade-watcher, chuck-broadcast, etc.) should go
// through `notify()` here instead of reaching into `./src/*`.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { notify } from "./src/notify.js";
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
