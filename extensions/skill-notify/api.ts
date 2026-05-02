// Public API barrel for @openclaw/skill-notify.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export {
  attemptAppleBridge,
  attemptTelegram,
  defaultHttpPoster,
  defaultOsascriptRunner,
} from "./src/channels.js";
export { resolveConfig, type NotifyConfig } from "./src/config.js";
export { dispatchNotification, type DispatchInput } from "./src/dispatch.js";
export {
  ackEntry,
  findLedgerPath,
  getEntry,
  ledgerPathFor,
  listEntries,
  makeNotifId,
  writeEntry,
  ymd,
} from "./src/ledger.js";
export { readTelegramBinding, type TelegramBinding } from "./src/openclaw-config.js";
export type {
  AckOptions,
  AckResult,
  ChannelDispatchResult,
  GetOptions,
  GetResult,
  HttpPoster,
  ListOptions,
  ListResult,
  NotifyEntry,
  OsascriptRunner,
  RunDeps,
  WriteOptions,
  WriteResult,
} from "./src/types.js";
export { NOTIFY_LEDGER_SCHEMA } from "./src/types.js";
