// Public API barrel for @openclaw/skill-health-steward.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { applyAction } from "./src/apply.js";
export { latestVerifiedLocalArchiveCandidate } from "./src/archive.js";
export {
  buildApprovalActions,
  buildAutomaticActions,
  buildHandoffActions,
  writeApprovalCapsules,
} from "./src/actions.js";
export { resolveConfig, type HealthStewardConfig } from "./src/config.js";
export { summarizeDocket } from "./src/docket.js";
export { readExecutorControl, writeExecutorControl } from "./src/executor.js";
export { buildHealthSnapshot } from "./src/health.js";
export {
  defaultProbes,
  mergeProbes,
  readDiskStatus,
  readLoadAverage,
  readMemoryPressure,
  readProcessGroups,
  readSwapStatus,
} from "./src/probes.js";
export {
  defaultSelfHealRunner,
  planResultOrFallback,
  statusResultOrFallback,
} from "./src/selfheal.js";
export { stabilize } from "./src/stabilize.js";
export { buildStatus, summarizeStatus } from "./src/status.js";
export {
  appendEvent,
  defaultReceiptId,
  ensureDir,
  ENGINE_KIND,
  formatBytes,
  GIB,
  latestJsonFiles,
  makeEvent,
  pathExists,
  pathInside,
  readJsonSafe,
  safeReaddir,
  statSafe,
  writeJsonAtomic,
} from "./src/util.js";
export type {
  ApplyOptions,
  ApplyResult,
  ApprovalAction,
  ApprovalCapsule,
  AutomaticAction,
  DiskStatus,
  DocketSummary,
  ExecutorControl,
  HandoffAction,
  HealthSnapshot,
  HealthThresholds,
  LoadStatus,
  LocalArchiveCandidate,
  MemoryPressure,
  MemoryStatus,
  ProcessGroup,
  RunDeps,
  SelfHealPlan,
  SelfHealRunFailure,
  SelfHealRunResult,
  SelfHealRunner,
  SelfHealStatusResult,
  StabilizeOptions,
  StabilizeReceipt,
  StabilizeResult,
  StatusOptions,
  StatusResult,
  StatusSummary,
  SwapStatus,
  SystemProbes,
} from "./src/types.js";
