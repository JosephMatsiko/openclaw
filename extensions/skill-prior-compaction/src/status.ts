// buildStatus + summarizeDecision.

import type { ValidateFunction } from "ajv";
import type { PriorCompactionConfig } from "./config.js";
import { latestCompactionDecision } from "./cursor.js";
import { buildPreviewDecision } from "./decision.js";
import type {
  CompactionDecision,
  DecisionFile,
  DecisionSummary,
  StatusOptions,
  StatusResult,
} from "./types.js";
import { truncate } from "./util.js";
import { createDecisionValidator } from "./validators.js";

export function summarizeDecision(
  file: DecisionFile | null | { data: CompactionDecision; path: string | null },
): DecisionSummary | null {
  const decision = file?.data ?? null;
  if (!decision) return null;
  return {
    decisionId: decision.decisionId ?? null,
    status: decision.status ?? null,
    sourcePriorId: decision.sourcePriorId ?? null,
    createdAt: decision.createdAt ?? null,
    approvedAt: decision.approvedAt ?? null,
    appliedAt: decision.appliedAt ?? null,
    resultingPriorId: decision.resultingPriorId ?? null,
    includedDeltaCount: Array.isArray(decision.includedDeltaIds)
      ? decision.includedDeltaIds.length
      : 0,
    eligibleDeltaCount: Array.isArray(decision.eligibleDeltaIds)
      ? decision.eligibleDeltaIds.length
      : 0,
    deferredDeltaCount: Array.isArray(decision.deferredDeltaIds)
      ? decision.deferredDeltaIds.length
      : 0,
    promotedClaimCount: Array.isArray(decision.promotedClaims) ? decision.promotedClaims.length : 0,
    deferredClaimCount: Array.isArray(decision.deferredClaims) ? decision.deferredClaims.length : 0,
    openQuestionCount: Array.isArray(decision.openQuestions) ? decision.openQuestions.length : 0,
    recommendedNextActionCount: Array.isArray(decision.recommendedNextActions)
      ? decision.recommendedNextActions.length
      : 0,
    dissentRefCount: Array.isArray(decision.dissentRefs) ? decision.dissentRefs.length : 0,
    path: file?.path ?? null,
    promotedClaimPreview: Array.isArray(decision.promotedClaims)
      ? decision.promotedClaims.slice(0, 5).map((claim) => ({
          claimKey: claim.claimKey,
          text: truncate(claim.text, 220),
          families: claim.families,
          confidence: claim.confidence,
          authorityImpact: claim.authorityImpact,
        }))
      : [],
    deferredClaimPreview: Array.isArray(decision.deferredClaims)
      ? decision.deferredClaims.slice(0, 5).map((claim) => ({
          claimId: claim.claimId,
          text: truncate(claim.text, 180),
          reason: claim.reason,
        }))
      : [],
  };
}

export interface BuildStatusDeps {
  validateDecision?: ValidateFunction;
}

export function buildStatus(
  config: PriorCompactionConfig,
  options: StatusOptions = {},
  deps: BuildStatusDeps = {},
): StatusResult {
  const validateDecision = deps.validateDecision ?? createDecisionValidator(config);
  const limit = options.limit ?? config.defaultLimit;
  const latest = latestCompactionDecision(config);
  const latestApplied = latestCompactionDecision(config, ["applied"]);
  const latestDraft = latestCompactionDecision(config, ["draft"]);
  const preview = buildPreviewDecision(config, { validateDecision, limit });
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    compactionsPath: config.compactionsDir,
    latestDecision: summarizeDecision(latest),
    latestAppliedDecision: summarizeDecision(latestApplied),
    latestDraftDecision: summarizeDecision(latestDraft),
    unappliedDeltaCount: preview.includedDeltaIds.length,
    promotedClaimCount: preview.promotedClaims.length,
    deferredClaimCount: preview.deferredClaims.length,
    openQuestionCount: preview.openQuestions.length,
    recommendedNextActionCount: preview.recommendedNextActions.length,
    draftPreview: summarizeDecision({ data: preview, path: null }),
  };
}
