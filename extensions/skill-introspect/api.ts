// Public API barrel for @openclaw/skill-introspect.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { runScan } from "./src/scan.js";
export { runFocus } from "./src/focus.js";
export {
  applyIntrospection,
  dismissIntrospection,
  summarizeStatus,
  type ApplyResult,
  type DismissResult,
  type StatusSummary,
} from "./src/status.js";
export { bundleState, renderStateForPrompt } from "./src/bundle.js";
export { buildFocusPrompt, buildScanPrompt } from "./src/prompt.js";
export { dispatchClaudeCli } from "./src/dispatch.js";
export { normalizeObservation, tryParseObservations } from "./src/parse.js";
export {
  findIntrospectionPath,
  isFingerprintBlocked,
  lastScanPath,
  loadAllIntrospections,
  loadLastScan,
  saveLastScan,
  writeIntrospection,
} from "./src/store.js";
export {
  buildExecutorEnv,
  createEventEmitter,
  ensureDir,
  ENGINE_KIND,
  fingerprint,
  introspectId,
  readJson,
  slugify,
  writeJson,
} from "./src/util.js";
export { resolveConfig, type IntrospectConfig } from "./src/config.js";
export type {
  ClaudeDispatchResult,
  FocusOptions,
  FocusResult,
  IntrospectionRecord,
  LastScanState,
  NormalizedObservation,
  RawObservation,
  RiskClass,
  ScanOptions,
  ScanResult,
  StateBundle,
} from "./src/types.js";
