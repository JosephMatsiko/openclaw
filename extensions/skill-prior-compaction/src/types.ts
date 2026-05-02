// Public types for @openclaw/skill-prior-compaction.

import type { ValidateFunction } from "ajv";

export type DecisionStatus = "draft" | "approved" | "applied" | "rejected";

export type ClaimStatus =
  | "proposed"
  | "supported"
  | "contested"
  | "retracted"
  | "operator-resolved";

export type Confidence = "low" | "medium" | "high";

export type AuthorityImpact = "none" | "proposal" | "approval-required" | "blocked";

export interface DecisionCursor {
  previousDecisionId: string | null;
  previousResultingPriorId: string | null;
  appliedDeltaIds: string[];
}

export interface PromotedClaim {
  claimKey: string;
  text: string;
  status: ClaimStatus | string;
  confidence: Confidence;
  authorityImpact: AuthorityImpact;
  families: string[];
  surfaces: string[];
  sourceDeltaIds: string[];
  sourceClaimIds: string[];
  evidenceRefs: string[];
}

export interface DeferredClaim {
  claimId: string;
  text: string;
  sourceDeltaId: string;
  family: string | null;
  surface: string | null;
  confidence: Confidence;
  authorityImpact: AuthorityImpact;
  evidenceRefs: string[];
  reason: string;
}

export interface DecisionApproval {
  at: string;
  by: string;
  confirm: "APPROVE_PRIOR_COMPACTION";
  note: string;
}

export interface CompactionDecision {
  schemaVersion: "chuck.prior-compaction-decision.v1";
  decisionId: string;
  status: DecisionStatus;
  sourcePriorId: string;
  sourcePriorPath: string | null;
  sourcePriorHash: string | null;
  createdAt: string;
  cursor: DecisionCursor;
  includedDeltaIds: string[];
  eligibleDeltaIds: string[];
  deferredDeltaIds: string[];
  promotedClaims: PromotedClaim[];
  deferredClaims: DeferredClaim[];
  openQuestions: string[];
  recommendedNextActions: string[];
  dissentRefs: string[];
  counts: {
    posteriorDeltaCount: number;
    alreadyAppliedDeltaCount: number;
    includedDeltaCount: number;
    eligibleDeltaCount: number;
    deferredDeltaCount: number;
    promotedClaimCount: number;
    deferredClaimCount: number;
    openQuestionCount: number;
    recommendedNextActionCount: number;
    dissentRefCount: number;
  };
  approval: DecisionApproval | null;
  approvedAt: string | null;
  appliedAt: string | null;
  rejectedAt: string | null;
  rejection: unknown | null;
  resultingPriorId: string | null;
  result: {
    priorReceipt: PriorCapsuleReceipt;
    appliedBy: string;
    appliedAt: string;
  } | null;
}

export interface PriorCapsuleReceipt {
  priorId?: string | null;
  path?: string | null;
  latestPath?: string | null;
  [key: string]: unknown;
}

export interface PriorRecord {
  priorId: string;
  createdAt: string;
  sourceHash: string | null;
  path: string | null;
}

export interface PosteriorDeltaInput {
  schemaVersion?: string;
  deltaId?: string;
  taskId?: string;
  taskTitle?: string;
  title?: string;
  intent?: string;
  taskIntent?: string;
  createdAt?: string;
  producer?: { family?: string; surface?: string; voice?: string | null };
  authorityImpact?: AuthorityImpact;
  confidence?: Confidence;
  evidence?: Array<{ evidenceId?: string }>;
  claims?: Array<{
    claimId?: string;
    text?: string;
    status?: string;
    confidence?: Confidence;
    evidenceRefs?: string[];
    dissentRefs?: string[];
  }>;
  dissent?: Array<{ dissentId?: string }>;
  openQuestions?: string[];
  recommendedNextActions?: string[];
}

export interface DocketTask {
  title?: string;
  ledgerIntent?: string;
  intent?: string;
  [key: string]: unknown;
}

export interface AppliedCursor {
  latestDecisionId: string | null;
  latestResultingPriorId: string | null;
  appliedDeltaIds: string[];
}

export interface DecisionFile {
  name: string;
  path: string;
  mtimeMs: number;
  data: CompactionDecision;
}

export interface DecisionSummary {
  decisionId: string | null;
  status: DecisionStatus | null;
  sourcePriorId: string | null;
  createdAt: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  resultingPriorId: string | null;
  includedDeltaCount: number;
  eligibleDeltaCount: number;
  deferredDeltaCount: number;
  promotedClaimCount: number;
  deferredClaimCount: number;
  openQuestionCount: number;
  recommendedNextActionCount: number;
  dissentRefCount: number;
  path: string | null;
  promotedClaimPreview: Array<{
    claimKey: string;
    text: string;
    families: string[];
    confidence: Confidence;
    authorityImpact: AuthorityImpact;
  }>;
  deferredClaimPreview: Array<{
    claimId: string;
    text: string;
    reason: string;
  }>;
}

export interface StatusResult {
  available: true;
  generatedAt: string;
  compactionsPath: string;
  latestDecision: DecisionSummary | null;
  latestAppliedDecision: DecisionSummary | null;
  latestDraftDecision: DecisionSummary | null;
  unappliedDeltaCount: number;
  promotedClaimCount: number;
  deferredClaimCount: number;
  openQuestionCount: number;
  recommendedNextActionCount: number;
  draftPreview: DecisionSummary | null;
}

export interface PreviewReceipt {
  ok: true;
  command: "preview";
  writes: boolean;
  path: string | null;
  decision: CompactionDecision;
}

export interface ApproveReceipt {
  ok: true;
  command: "approve";
  alreadyApplied?: boolean;
  path: string;
  decisionId: string;
  resultingPriorId: string | null;
  priorReceipt?: PriorCapsuleReceipt;
  decision: CompactionDecision;
}

export interface RunDeps {
  /** Subprocess wrapper for chuck-prior-capsule (injectable for tests). */
  refreshPriorCapsule?: () => Promise<PriorCapsuleReceipt>;
  /** Inject a custom decision validator (e.g. precompiled in tests). */
  validateDecision?: ValidateFunction;
  /** Pin "now" / approvedAt timestamps for deterministic tests. */
  now?: () => string;
}

export interface ApproveOptions {
  decision: string;
  confirm: string;
  approvedBy?: string;
}

export interface PreviewOptions {
  write?: boolean;
  limit?: number;
}

export interface StatusOptions {
  limit?: number;
}
