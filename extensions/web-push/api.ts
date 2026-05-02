// Public API barrel for @openclaw/plugin-web-push.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { sendWebPush } from "./src/send.js";
export {
  listSubscriptions,
  removeSubscription,
  saveSubscription,
  sanitizeEndpoint,
} from "./src/store.js";
export { loadVapidKeys, loadVapidPublic } from "./src/vapid.js";
export { resolveConfig, type WebPushConfig } from "./src/config.js";
export type {
  PushSubscriptionRecord,
  RemoveSubscriptionResult,
  SaveSubscriptionResult,
  SendWebPushParams,
  SendWebPushPayload,
  SendWebPushResult,
  VapidKeys,
} from "./src/types.js";
