// Public API barrel for @openclaw/plugin-reach-ledger.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type {
  ChannelRecord,
  GlobalRecord,
  Ledger,
  RankOptions,
  RecordSuccessDetail,
} from "./src/types.js";
export {
  getStatus,
  recordFailure,
  recordSuccess,
  resetLedger,
  type StoreOptions,
} from "./src/store.js";
export { rankChannels } from "./src/ranking.js";
export { resolveConfig, type ReachLedgerConfig } from "./src/config.js";
