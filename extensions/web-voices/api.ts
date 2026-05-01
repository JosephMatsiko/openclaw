// Public API barrel for @openclaw/plugin-web-voices.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type {
  SelectorProfile,
  SelectorRegistry,
  WebVoiceAskInput,
  WebVoiceAskResult,
  WebVoiceCapabilityMatrix,
  WebVoiceCatalogEntry,
  WebVoiceSurface,
  WebVoiceVendor,
} from "./src/types.js";
export { findWebVoice, listWebVoices, voicesSupporting } from "./src/voices.js";
export {
  acquireWithRetry,
  inspect as inspectLease,
  type AcquireOptions,
  type LeaseRecord,
  release as releaseLease,
  tryAcquire as tryAcquireLease,
} from "./src/lease.js";
export {
  getSelectorProfile,
  inspectRegistry as inspectSelectorRegistry,
  upsertSelectorProfile,
} from "./src/selector-registry.js";
export { resolveConfig, type WebVoicesConfig } from "./src/config.js";
