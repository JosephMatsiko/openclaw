// buildPreviewDecision orchestrator — mechanical compaction draft from current
// posterior deltas.

import type { ValidateFunction } from "ajv";
import {
  assessDelta,
  claimDeferralReason,
  deferredClaim,
  deferredClaimForDelta,
  receiptOnlyDeferralReason,
} from "./assess.js";
import type { PriorCompactionConfig } from "./config.js";
import { appliedCompactionCursor } from "./cursor.js";
import { collectDissentRefs, collectStrings, promoteClaim } from "./promote.js";
import type {
  CompactionDecision,
  DeferredClaim,
  PosteriorDeltaInput,
  PriorRecord,
  PromotedClaim,
} from "./types.js";
import {
  compactTimestamp,
  compareIso,
  fileSha,
  latestJsonFiles,
  pathExists,
  readJson,
  sha256,
  stableStringify,
} from "./util.js";
import { validateOrThrow } from "./validators.js";

export interface BuildPreviewOptions {
  validateDecision: ValidateFunction;
  limit?: number;
}

export function readLatestPrior(config: PriorCompactionConfig): PriorRecord {
  if (!pathExists(config.latestPriorPath)) {
    return {
      priorId: "prior-missing",
      createdAt: new Date().toISOString(),
      sourceHash: null,
      path: null,
    };
  }
  const prior = readJson<Record<string, unknown>>(config.latestPriorPath);
  return {
    priorId: String(prior.priorId ?? "prior-unknown"),
    createdAt: String(prior.createdAt ?? new Date().toISOString()),
    sourceHash: (prior.sourceHash as string | null) ?? fileSha(config.latestPriorPath),
    path: config.latestPriorPath,
  };
}

function deterministicDecisionTime(prior: PriorRecord, deltas: PosteriorDeltaInput[]): string {
  const times = [prior?.createdAt, ...deltas.map((delta) => delta?.createdAt)]
    .map((value) => Date.parse(value ?? ""))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return new Date().toISOString();
  return new Date(Math.max(...times)).toISOString();
}

export function buildPreviewDecision(
  config: PriorCompactionConfig,
  options: BuildPreviewOptions,
): CompactionDecision {
  const limit = options.limit ?? config.defaultLimit;
  const prior = readLatestPrior(config);
  const applied = appliedCompactionCursor(config);
  const appliedDeltaIds = new Set(applied.appliedDeltaIds);
  const allDeltas = latestJsonFiles<PosteriorDeltaInput>(config.deltasDir, limit)
    .map((file) => ({ file, data: file.data }))
    .filter((entry) => entry.data)
    .sort(
      (a, b) =>
        compareIso(a.data.createdAt, b.data.createdAt) || a.file.name.localeCompare(b.file.name),
    );
  const candidates = allDeltas.filter((entry) => {
    const id = entry.data?.deltaId ?? entry.file.name.replace(/\.json$/, "");
    return !appliedDeltaIds.has(id);
  });

  const promotedByKey = new Map<string, PromotedClaim>();
  const deferredClaims: DeferredClaim[] = [];
  const eligibleDeltaIds: string[] = [];
  const deferredDeltaIds = new Set<string>();
  const openQuestions = new Set<string>();
  const recommendedNextActions = new Set<string>();
  const dissentRefs = new Set<string>();

  for (const { data: delta } of candidates) {
    const deltaId = delta.deltaId ?? "";
    const assessment = assessDelta(delta);
    const receiptOnlyReason = receiptOnlyDeferralReason(delta, config);
    if (assessment.eligible) {
      eligibleDeltaIds.push(deltaId);
    } else {
      deferredDeltaIds.add(deltaId);
    }
    if (!receiptOnlyReason) {
      collectStrings(delta.openQuestions ?? [], openQuestions);
      collectStrings(delta.recommendedNextActions ?? [], recommendedNextActions);
    }
    collectDissentRefs(delta, dissentRefs);
    const claims = Array.isArray(delta.claims) ? delta.claims : [];
    if (!claims.length) {
      deferredClaims.push(
        deferredClaimForDelta(
          delta,
          receiptOnlyReason || assessment.reasons.join("; ") || "delta has no claims",
        ),
      );
      if (receiptOnlyReason) deferredDeltaIds.add(deltaId);
      continue;
    }
    for (const claim of claims) {
      const reason = receiptOnlyReason || claimDeferralReason(delta, claim, assessment.reasons);
      if (reason) {
        deferredDeltaIds.add(deltaId);
        deferredClaims.push(deferredClaim(delta, claim, reason));
        continue;
      }
      promoteClaim(promotedByKey, delta, claim);
    }
  }

  const includedDeltaIds = candidates.map(({ data }) => data.deltaId ?? "");
  const createdAt = deterministicDecisionTime(
    prior,
    candidates.map(({ data }) => data),
  );
  const decisionSeed = stableStringify({
    sourcePriorId: prior.priorId,
    includedDeltaIds,
    promotedClaimKeys: [...promotedByKey.keys()].sort(),
    deferredClaimIds: deferredClaims.map((claim) => claim.claimId).sort(),
  });
  const decisionId = `compaction-${compactTimestamp(createdAt)}-${sha256(decisionSeed).slice(0, 12)}`;
  const promotedClaims = [...promotedByKey.values()].map((claim) => ({
    ...claim,
    families: [...claim.families].sort(),
    surfaces: [...claim.surfaces].sort(),
    sourceDeltaIds: [...claim.sourceDeltaIds].sort(),
    sourceClaimIds: [...claim.sourceClaimIds].sort(),
    evidenceRefs: [...claim.evidenceRefs].sort(),
  }));
  const decision: CompactionDecision = {
    schemaVersion: "chuck.prior-compaction-decision.v1",
    decisionId,
    status: "draft",
    sourcePriorId: prior.priorId,
    sourcePriorPath: prior.path,
    sourcePriorHash: prior.sourceHash,
    createdAt,
    cursor: {
      previousDecisionId: applied.latestDecisionId,
      previousResultingPriorId: applied.latestResultingPriorId,
      appliedDeltaIds: [...appliedDeltaIds].sort(),
    },
    includedDeltaIds,
    eligibleDeltaIds: [...eligibleDeltaIds].sort(),
    deferredDeltaIds: [...deferredDeltaIds].sort(),
    promotedClaims,
    deferredClaims: deferredClaims.sort((a, b) => a.claimId.localeCompare(b.claimId)),
    openQuestions: [...openQuestions].sort(),
    recommendedNextActions: [...recommendedNextActions].sort(),
    dissentRefs: [...dissentRefs].sort(),
    counts: {
      posteriorDeltaCount: allDeltas.length,
      alreadyAppliedDeltaCount: appliedDeltaIds.size,
      includedDeltaCount: includedDeltaIds.length,
      eligibleDeltaCount: eligibleDeltaIds.length,
      deferredDeltaCount: deferredDeltaIds.size,
      promotedClaimCount: promotedClaims.length,
      deferredClaimCount: deferredClaims.length,
      openQuestionCount: openQuestions.size,
      recommendedNextActionCount: recommendedNextActions.size,
      dissentRefCount: dissentRefs.size,
    },
    approval: null,
    approvedAt: null,
    appliedAt: null,
    rejectedAt: null,
    rejection: null,
    resultingPriorId: null,
    result: null,
  };
  validateOrThrow(options.validateDecision, decision, "prior compaction decision preview");
  return decision;
}
