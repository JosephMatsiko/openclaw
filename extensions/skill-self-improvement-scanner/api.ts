// Public API barrel for @openclaw/skill-self-improvement-scanner.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { runScan, lastScanPath } from "./src/scan.js";
export { summarizeStatus, type StatusSummary } from "./src/status.js";
export { ALL_CATEGORIES, runAllDetectors } from "./src/detectors/index.js";
export { detectDocketHealth } from "./src/detectors/dockethealth.js";
export { detectStuckPending } from "./src/detectors/stuckpending.js";
export { detectMcpGap } from "./src/detectors/mcpgap.js";
export { detectPlistGap } from "./src/detectors/plistgap.js";
export { detectSkillGap, EXECUTOR_COMMAND_KINDS } from "./src/detectors/skillgap.js";
export { detectBusDiversity } from "./src/detectors/busdiversity.js";
export { buildTask, writeTask } from "./src/task.js";
export { fingerprint, loadDocket, existingFingerprints, SCANNER_KIND } from "./src/util.js";
export { resolveConfig, type SelfImprovementScannerConfig } from "./src/config.js";
export type {
  DetectorContext,
  DocketTask,
  DropResult,
  Gap,
  GapCategory,
  ScanOptions,
  ScanSummary,
} from "./src/types.js";
