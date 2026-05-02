// Public API barrel for @openclaw/skill-prior-compaction.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export {
  assessDelta,
  claimDeferralReason,
  deferredClaim,
  deferredClaimForDelta,
  docketTaskForDelta,
  receiptOnlyDeferralReason,
} from "./src/assess.js";
export { defaultRefreshPriorCapsule } from "./src/capsule.js";
export { resolveConfig, type PriorCompactionConfig } from "./src/config.js";
export {
  appliedCompactionCursor,
  compactionDecisionFiles,
  latestCompactionDecision,
} from "./src/cursor.js";
export { buildPreviewDecision, readLatestPrior, type BuildPreviewOptions } from "./src/decision.js";
export { previewDecision, writeDecision } from "./src/preview.js";
export { approveDecision } from "./src/approve.js";
export { buildStatus, summarizeDecision } from "./src/status.js";
export {
  collectDissentRefs,
  collectStrings,
  evidenceRefsFor,
  promoteClaim,
  strongerAuthorityImpact,
  strongerConfidence,
  strongerStatus,
} from "./src/promote.js";
export {
  appendEvent,
  cleanClaimText,
  compactTimestamp,
  compareIso,
  ensureDir,
  expandPath,
  fileSha,
  latestJsonFiles,
  makeEvent,
  normalizeText,
  pathExists,
  pushUnique,
  readJson,
  resolveDecisionPath,
  sha256,
  stableStringify,
  truncate,
  writeJsonAtomic,
} from "./src/util.js";
export { createDecisionValidator, validateOrThrow } from "./src/validators.js";
export type {
  AppliedCursor,
  ApproveOptions,
  ApproveReceipt,
  AuthorityImpact,
  ClaimStatus,
  CompactionDecision,
  Confidence,
  DecisionApproval,
  DecisionCursor,
  DecisionFile,
  DecisionStatus,
  DecisionSummary,
  DeferredClaim,
  DocketTask,
  PosteriorDeltaInput,
  PreviewOptions,
  PreviewReceipt,
  PriorCapsuleReceipt,
  PriorRecord,
  PromotedClaim,
  RunDeps,
  StatusOptions,
  StatusResult,
} from "./src/types.js";
