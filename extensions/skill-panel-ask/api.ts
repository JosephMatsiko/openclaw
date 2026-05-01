// Public API barrel for @openclaw/skill-panel-ask.
//
// Re-exports the SDK seams needed by the plugin entrypoint plus this plugin's
// own narrow surface. Other openclaw code that wants to call panel_ask
// programmatically should go through `runPanelAsk()` here instead of reaching
// into `./src/*`.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type {
  PanelAskInput,
  PanelAskMode,
  PanelAskOutput,
  SynthesisResult,
  VoiceCatalogEntry,
  VoiceFamily,
  VoiceResult,
  VoiceSurface,
} from "./src/types.js";
export { runPanelAsk } from "./src/dispatch.js";
export { findVoice, listVoices, selectSynthesizer } from "./src/voices.js";
export {
  synthesizePanel,
  type SynthesisDispatchResult,
  type SynthesizeOptions,
} from "./src/synthesis.js";
