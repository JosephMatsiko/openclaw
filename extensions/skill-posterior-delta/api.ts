// Public API barrel for @openclaw/skill-posterior-delta.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { resolveConfig, type PosteriorDeltaConfig } from "./src/config.js";
export {
  buildClaims,
  buildDelta,
  buildEvidence,
  confidenceForExecution,
  type BuildDeltaInput,
} from "./src/delta.js";
export { buildReadMarker } from "./src/readmarker.js";
export {
  runFromExecution,
  writeDelta,
  writeReadMarker,
  type RunFromExecutionDeps,
  type WrittenDelta,
  type WrittenReadMarker,
} from "./src/runner.js";
export { extractRecommendations, parseScoutSections } from "./src/sections.js";
export {
  cleanBullet,
  compactTimestamp,
  expandPath,
  ensureDir,
  fileSha,
  normalizeSha,
  pathExists,
  readJson,
  sha256,
  stableStringify,
  writeJsonAtomic,
} from "./src/util.js";
export { createValidators, validateOrThrow, type PosteriorValidators } from "./src/validators.js";
export type {
  AuthorityImpact,
  Claim,
  ClaimStatus,
  Confidence,
  EvidenceRef,
  MergePolicy,
  PosteriorDelta,
  PriorRecord,
  Producer,
  ReadMarker,
  ReadMarkerResult,
  ReadMarkerScope,
  RunnerCalibration,
  RunnerExecution,
  RunnerExecutionItem,
  RunnerReceipt,
  RunFromExecutionOptions,
  RunReceipt,
  RunReceiptDeltaSummary,
  RunReceiptReadMarkerSummary,
  RunRecord,
  ScoutSections,
  TaskRecord,
} from "./src/types.js";
