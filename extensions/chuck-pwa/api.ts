// Public API barrel for @openclaw/plugin-chuck-pwa.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type {
  AskRequestBody,
  AskResponse,
  VoiceCatalogEntry,
  VoiceFamily,
  VoiceSurface,
  VoicesResponse,
} from "./src/types.js";
export { findVoice, PWA_VOICES } from "./src/voices.js";
export { buildChuckPreamble } from "./src/persona.js";
export { resolveConfig, type ChuckPwaConfig } from "./src/config.js";
