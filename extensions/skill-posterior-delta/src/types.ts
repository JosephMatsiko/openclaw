// Public types for @openclaw/skill-posterior-delta.

export type Confidence = "low" | "medium" | "high";

export type ClaimStatus =
  | "proposed"
  | "supported"
  | "contested"
  | "retracted"
  | "operator-resolved";

export type AuthorityImpact = "none" | "proposal" | "blocked";

export type ReadMarkerScope = "full" | "summary" | "targeted";

export type ReadMarkerResult = "accepted" | "disputed" | "needs-more-context";

export interface Producer {
  family: string;
  surface: string;
  voice: string | null;
  modelClaimed: string | null;
  modelVerified: boolean | null;
}

export interface EvidenceRef {
  evidenceId: string;
  kind: "transcript" | "run" | "file";
  ref: string;
  sha256: string | null;
  observedAt: string | null;
}

export interface Claim {
  claimId: string;
  text: string;
  status: ClaimStatus;
  confidence: Confidence;
  evidenceRefs: string[];
  dissentRefs: string[];
}

export interface MergePolicy {
  mode: "append-only";
  mayMutatePriorBody: false;
  requiresCompactionGate: true;
  notes: string;
}

export interface PosteriorDelta {
  schemaVersion: "chuck.posterior-delta.v1";
  deltaId: string;
  priorId: string;
  producer: Producer;
  taskId: string;
  createdAt: string;
  claims: Claim[];
  changedFiles: string[];
  evidence: EvidenceRef[];
  dissent: unknown[];
  openQuestions: string[];
  recommendedNextActions: string[];
  confidence: Confidence;
  authorityImpact: AuthorityImpact;
  mergePolicy: MergePolicy;
}

export interface ReadMarker {
  schemaVersion: "chuck.read-marker.v1";
  markerId: string;
  reader: { family: string; surface: string; voice: string | null };
  priorId: string;
  deltaIds: string[];
  seenAt: string;
  scope: ReadMarkerScope;
  result: ReadMarkerResult;
  notes: string | null;
}

export interface RunnerCalibration {
  verdict?: "usable" | "weak" | "rejected" | string;
}

export interface RunnerReceipt {
  startedAt?: string | null;
  endedAt?: string | null;
  transcriptPath?: string | null;
  transcriptSha256?: string | null;
  declaredVoice?: string | null;
  modelClaimed?: string | null;
  modelVerified?: boolean | null;
  actualFamily?: string | null;
  surface?: string | null;
}

export interface RunnerExecutionItem {
  surface?: string;
  family?: string;
  voice?: string;
  status?: "completed" | "failed" | string;
  text?: string;
  reason?: string;
  countingEligible?: boolean;
  receipt?: RunnerReceipt;
  calibration?: RunnerCalibration;
}

export interface RunnerExecution {
  runId?: string;
  dispatchId?: string;
  executions?: RunnerExecutionItem[];
  _path?: string;
}

export interface RunRecord {
  runId?: string;
  createdAt?: string;
  docketItem?: { docketId?: string };
  _path?: string;
}

export interface TaskRecord {
  id?: string;
  taskId?: string;
  priorCapsuleBefore?: {
    priorId?: string;
    injectedIntoPrompt?: boolean;
    scope?: ReadMarkerScope;
  };
  updatedAt?: string;
  createdAt?: string;
  _path?: string;
}

export interface PriorRecord {
  priorId?: string;
  createdAt?: string;
  _path?: string;
}

export interface ScoutSections {
  claims: string[];
  risks: string[];
  missingEvidence: string[];
  deepenNeeded: "yes" | "no" | "unknown";
}

export interface BuildOptions {
  maxClaimsPerDelta: number;
  maxOpenQuestions: number;
  maxRecommendations: number;
}

export interface RunFromExecutionOptions {
  /** Path to the runner execution receipt JSON. Required. */
  executionPath: string;
  /** Optional run JSON (auto-discovered if omitted). */
  runPath?: string;
  /** Optional task JSON. */
  taskPath?: string;
  /** Path to the prior capsule (`"latest"` resolves to priorsDir/latest.json). */
  priorPath?: string;
  /** When true, persist deltas + read markers under configured dirs. */
  write?: boolean;
  /** When false, skip non-counting / degraded execution items. */
  includeNonCounting?: boolean;
  /** When false, do not write read markers even if a prior was injected. */
  writeReadMarkers?: boolean;
}

export interface RunReceiptDeltaSummary {
  deltaId: string;
  path: string | null;
  family: string;
  surface: string;
  confidence: Confidence;
  authorityImpact: AuthorityImpact;
  claimCount: number;
  openQuestionCount: number;
  recommendedNextActionCount: number;
}

export interface RunReceiptReadMarkerSummary {
  markerId: string;
  path: string | null;
  family: string;
  surface: string;
  result: ReadMarkerResult;
}

export interface RunReceipt {
  ok: true;
  executionPath: string;
  runId: string | null;
  priorId: string;
  deltaCount: number;
  readMarkerCount: number;
  deltas: RunReceiptDeltaSummary[];
  readMarkers: RunReceiptReadMarkerSummary[];
}
