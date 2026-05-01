// Public API barrel for @openclaw/skill-decision-engine.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { runScan } from "./src/scan.js";
export { summarizeStatus, applyDecision, rejectDecision } from "./src/status.js";
export { ALL_DETECTORS } from "./src/detectors/index.js";
export { detectFailedTaskCluster } from "./src/detectors/failed-task-cluster.js";
export { detectZombieCluster } from "./src/detectors/zombie-cluster.js";
export { detectChannelDrift } from "./src/detectors/channel-drift.js";
export { detectScannerTune } from "./src/detectors/scanner-tune.js";
export { detectOrphanMcp } from "./src/detectors/orphan-mcp.js";
export { detectStaleMacHeal } from "./src/detectors/stale-mac-heal.js";
export { shouldAutoApply } from "./src/policy.js";
export { loadDecisions, loadLastScan } from "./src/store.js";
export { resolveConfig, type DecisionEngineConfig } from "./src/config.js";
export type { ApplyResult, RejectResult, StatusSummary } from "./src/status.js";
export type {
  DecisionOption,
  DecisionStatus,
  Detector,
  DetectorCategory,
  DetectorContext,
  DetectorHit,
  Proposal,
  RiskClass,
  ScanOptions,
  ScanSummary,
  DocketTask,
  BusEvent,
} from "./src/types.js";
