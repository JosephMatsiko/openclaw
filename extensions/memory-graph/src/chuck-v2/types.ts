export type ChuckFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "perplexity"
  | "sovereign-local"
  | "xai"
  | "unknown";

export type CapabilityProfile =
  | "frontier-reasoning"
  | "code-grounded"
  | "live-research"
  | "sovereign-local"
  | "meta-router"
  | "unknown";

export type EvidenceClass =
  | "deterministic-verifier"
  | "runtime-trace"
  | "primary-doc"
  | "live-source"
  | "repo-fact"
  | "model-reasoning"
  | "vault-doctrine"
  | "unsourced";

export type StakeClass = "trivial" | "medium" | "high-readonly" | "high-mutating" | "destructive";

export type TaskClass =
  | "factual"
  | "formatting"
  | "summary"
  | "code-review"
  | "code-mutation"
  | "architecture"
  | "vault-doctrine"
  | "skill-install"
  | "destructive-action"
  | "unknown";

export type Protocol =
  | "UNANIMOUS"
  | "OUTLIER"
  | "DEEP_FRACTURE"
  | "INTRA_FAMILY_FRACTURE"
  | "SCHISM"
  | "FRAGMENT"
  | "IMPERSONATION_DETECTED"
  | "INCOMPLETE";

export type FinalAction =
  | "single-model-response"
  | "emit-task-capsule"
  | "red-team-outlier"
  | "fork-to-verifier"
  | "operator-halt"
  | "operator-approval-required"
  | "refuse";

export type ConfidenceLabel = "none" | "low" | "medium" | "high-evidence-bounded" | "degraded";

export type ChuckFleetEntry = {
  family: ChuckFamily;
  voice: string;
  surface: string;
  rationale: string;
  capabilityProfile: CapabilityProfile;
  commercialPolicy: "subscription-only" | "local-only" | "operator-approved-exception";
  quotaPolicy: "unknown" | "scarce" | "normal" | "local";
  weightPolicy: "full-vote" | "partial-vote" | "flag-not-vote";
};

export type ChuckThresholds = {
  minimumFamilies: number;
  highRiskMinimumFamilies: number;
  unanimousCorrectnessGate: number;
  disagreementGate: number;
  minorityFractureCount: number;
};

export type ChuckConfig = {
  version: 1;
  fleet: ChuckFleetEntry[];
  thresholds: ChuckThresholds;
  stakePolicy: {
    destructiveRequiresApproval: true;
    vaultWritesRequireOperatorApproval: true;
  };
  evidencePolicy: {
    precedence: EvidenceClass[];
    vaultMayOverruleExternalTruth: false;
  };
  budgets: {
    defaultTimeoutMs: number;
    highRiskTimeoutMs: number;
    maxFleetCallsPerRun: number;
    maxConcurrentFleetRuns: number;
    lowFreeMemoryMb: number;
  };
  intercept: {
    enabled: boolean;
    bypassTargetMs: number;
  };
  sandbox: {
    skillNetworkDefault: "deny";
    skillFilesystemDefault: "ephemeral";
  };
  vaultPolicy: {
    writes: "operator-approved-proposals";
    scope: "doctrine-not-external-truth";
  };
  sovereigntyPolicy: {
    legitimateSurfaceDominanceRequired: true;
    unauthorizedBypassAllowed: false;
    stealthEvasionAllowed: false;
    internalReceiptsRequired: true;
    externalTraceMinimizationRequired: true;
    captureResistanceRequired: true;
  };
};

export type WorkerHealthRow = {
  worker: string;
  healthy: boolean;
  latencyMs?: number;
  details?: string;
};

export type WorkerHealthSnapshot = {
  updatedAt?: string;
  workers: Record<string, WorkerHealthRow>;
};

export type MemoryPressure = "normal" | "warning" | "critical";

export type MachineResourceSnapshot = {
  capturedAt?: string;
  memoryPressure: MemoryPressure;
  freeMemoryMb?: number;
  swapUsedMb?: number;
  appMemoryMb?: number;
  notes?: string[];
};

export type RunnerReceipt = {
  declaredVoice: string;
  requestedFamily: ChuckFamily;
  actualRunner: string;
  actualFamily: ChuckFamily;
  surface: string;
  layerUsed: string;
  modelClaimed: string;
  modelVerified: boolean;
  authProfileId?: string;
  transcriptPath?: string;
  transcriptSha256: string;
  startedAt: string;
  endedAt: string;
  runnerSignature: string;
};

export type SourceSpan = {
  source: string;
  startLine?: number;
  endLine?: number;
  quote?: string;
  documentRecordId?: string;
  unitId?: string;
  spanId?: string;
};

export type Claim = {
  id: string;
  text: string;
  category: "factual" | "technical" | "doctrine" | "preference" | "risk" | "unknown";
  evidenceClass: EvidenceClass;
  sourceSpans: SourceSpan[];
  vaultNodes: string[];
  confidence: number;
  producedBy: string[];
};

export type AlignmentMatrix = {
  clusters: Array<{
    id: string;
    familyVotes: ChuckFamily[];
    claimIds: string[];
    summary: string;
  }>;
  contradictions: string[];
};

export type SurfaceReceipt = {
  family: ChuckFamily;
  surface: string;
  voices: string[];
  receiptIds: string[];
  validForFamilyCount: boolean;
};

export type IntraFamilyFracture = {
  family: ChuckFamily;
  surfaces: string[];
  kind: "opposing-verdict" | "opposing-action" | "framing-divergence";
  operatorActionRequired: boolean;
  summary: string;
};

export type OperatorAttentionCost = {
  approvalCount: number;
  estimatedMinutes: number;
  interruptionRisk: "low" | "medium" | "high";
};

export type DecisionRecord = {
  runId: string;
  stakeClass: StakeClass;
  taskClass: TaskClass;
  configuredFleetSize: number;
  validVoiceCount: number;
  validFamilyCount: number;
  degradedMode: "FULL" | `DEGRADED-${number}` | "INCOMPLETE";
  adjudicatorFamily: ChuckFamily;
  receipts: RunnerReceipt[];
  surfaceReceipts: SurfaceReceipt[];
  intraFamilyFractures: IntraFamilyFracture[];
  claims: Claim[];
  alignmentMatrix: AlignmentMatrix;
  protocol: Protocol;
  evidenceCited: EvidenceClass[];
  vaultDoctrineCited: string[];
  authorityDiffId?: string;
  resourceSnapshot?: MachineResourceSnapshot;
  operatorAttentionCost?: OperatorAttentionCost;
  efficiencyDecisionId?: string;
  operatorActionRequired: boolean;
  finalAction: FinalAction;
  confidenceLabel: ConfidenceLabel;
};

export type DocketStatus =
  | "waiting-fleet"
  | "waiting-resolution"
  | "needs-setup"
  | "needs-approval"
  | "active-session"
  | "halted"
  | "ready";

export type DocketItem = {
  docketId: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: DocketStatus;
  title: string;
  stakeClass: StakeClass;
  taskClass: TaskClass;
  protocol?: Protocol;
  finalAction: string;
  operatorActionRequired: boolean;
  decisionRecordId?: string;
  reasons: string[];
};

export type ProtectedPathVerdict = "clear" | "touches-tier0" | "unknown";

export type SandboxPolicy = {
  runtime: "none" | "host" | "ephemeral-worktree" | "deno" | "container";
  filesystem: "none" | "workspace" | "ephemeral" | "allowlisted";
  network: "deny" | "allowlisted" | "inherit";
  denyRun: boolean;
};

export type TaskCapsule = {
  capsuleId: string;
  decisionRecordId: string;
  actionPlan: string[];
  allowedTools: string[];
  filesystemScope: "none" | "workspace" | "ephemeral-worktree";
  networkScope: "deny" | "allowlisted" | "inherit";
  externalFootprintId?: string;
  leashId?: string;
  sandboxPolicy: SandboxPolicy;
  protectedPathVerdict: ProtectedPathVerdict;
  verifier?: string;
  rollbackPlan?: string[];
  expiresAt: string;
  signature: string;
};

export type ExternalDestinationKind =
  | "none"
  | "vendor-model"
  | "subscribed-app"
  | "public-web"
  | "connector"
  | "operator-provided-endpoint"
  | "unknown";

export type ExternalDataClass =
  | "none"
  | "prompt"
  | "repo-snippet"
  | "local-file-content"
  | "document-span"
  | "browser-context"
  | "account-metadata"
  | "credential"
  | "full-local-archive"
  | "operator-private";

export type ExternalFootprintVerdict =
  | "local-only"
  | "allowed-minimized"
  | "route-local-first"
  | "needs-approval"
  | "blocked";

export type ExternalFootprintAssessment = {
  footprintId: string;
  generatedAt: string;
  destinationKind: ExternalDestinationKind;
  destination: string;
  dataClasses: ExternalDataClass[];
  verdict: ExternalFootprintVerdict;
  networkScope: TaskCapsule["networkScope"];
  operatorApprovalRequired: boolean;
  receiptRequired: boolean;
  externalTraceMinimizationRequired: boolean;
  reasons: string[];
  requiredMitigations: string[];
};

export type AuthorityCapabilityId =
  | "shell.run"
  | "network.fetch"
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.delete"
  | "credentials.read"
  | "credentials.write"
  | "browser.drive"
  | "code.eval"
  | "sandbox.policy"
  | "kernel.policy"
  | "stake.policy"
  | "vault.write"
  | "threshold.modify"
  | "unknown";

export type AuthorityRiskClass = "none" | "low" | "medium" | "high" | "destructive";

export type AuthorityDiff = {
  diffId: string;
  generatedAt: string;
  targetPaths: string[];
  protectedPathVerdict: ProtectedPathVerdict;
  addedCapabilities: AuthorityCapabilityId[];
  removedCapabilities: AuthorityCapabilityId[];
  riskClass: AuthorityRiskClass;
  operatorApprovalRequired: boolean;
  reasons: string[];
};

export type KernelDisposition =
  | "route-single-model"
  | "route-fleet"
  | "execute"
  | "continue-resolution"
  | "operator-approval-required"
  | "halt"
  | "refuse";

export type ChuckEventType =
  | "prompt.received"
  | "stake.classified"
  | "preflight.evaluated"
  | "runner.receipt"
  | "efficiency.planned"
  | "fleet.dispatch.planned"
  | "fleet.scout.resolve"
  | "fleet.deepen.resolve"
  | "fleet.trace.recorded"
  | "perplexity.lease"
  | "protocol.classified"
  | "decision.recorded"
  | "model.doctor"
  | "taskcapsule.created"
  | "operator.approval"
  | "vault.proposal"
  | "skill.quarantine"
  | "self-improvement.proposed";

export type ChuckEvent<TPayload = unknown> = {
  eventId: string;
  type: ChuckEventType;
  occurredAt: string;
  runId?: string;
  parentEventId?: string;
  previousEventHash?: string;
  payload: TPayload;
  eventHash: string;
};

export type FleetReviewRole = "independent-review" | "originating-family-self-review";

export type FleetReviewRatification = {
  configuredFamilies: ChuckFamily[];
  reviewerFamilies: ChuckFamily[];
  originatingFamily?: ChuckFamily;
  independentFamilies: ChuckFamily[];
  selfReviewFamilies: ChuckFamily[];
  missingFamilies: ChuckFamily[];
  configuredReviewComplete: boolean;
  canIndependentlyRatify: boolean;
  notes: string[];
};

export type OperatorSurfaceKind =
  | "gmail"
  | "apple-id"
  | "whatsapp"
  | "telegram"
  | "macos"
  | "browser"
  | "other";

export type OperatorSurfaceProfile = {
  profileId: string;
  kind: OperatorSurfaceKind;
  label: string;
  identifierHint?: string;
  secretRef?: string;
  verified: boolean;
  notes?: string[];
};

export type DocumentSourceKind =
  | "pdf"
  | "repo-file"
  | "local-file"
  | "web-page"
  | "transcript"
  | "screenshot"
  | "connector-export"
  | "generated-artifact";

export type DocumentSourceCoordinate = {
  page?: number;
  startLine?: number;
  endLine?: number;
  url?: string;
  timestampMs?: number;
  artifactPath?: string;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type DocumentEvidenceSpan = {
  spanId: string;
  text: string;
  startOffset?: number;
  endOffset?: number;
  coordinate?: DocumentSourceCoordinate;
};

export type DocumentEvidenceUnit = {
  unitId: string;
  text: string;
  coordinate?: DocumentSourceCoordinate;
  spans: DocumentEvidenceSpan[];
  tables?: Array<{
    tableId: string;
    text: string;
    coordinate?: DocumentSourceCoordinate;
  }>;
  figures?: Array<{
    figureId: string;
    caption?: string;
    coordinate?: DocumentSourceCoordinate;
  }>;
};

export type DocumentContradiction = {
  claimA: {
    unitId: string;
    spanId: string;
  };
  claimB: {
    unitId: string;
    spanId: string;
  };
  reason: string;
};

export type DocumentCitation = {
  documentRecordId: string;
  sourceHash?: string;
  unitId: string;
  spanId: string;
  quote?: string;
};

export type DocumentCitationLogEntry = DocumentCitation & {
  decisionRecordId: string;
  voice: string;
  verifiedExists: boolean;
};

export type DocumentEvidenceRecord = {
  recordId: string;
  sourceHash: string;
  sourceKind: DocumentSourceKind;
  sourcePathOrUrl: string;
  ingestedAt: string;
  units: DocumentEvidenceUnit[];
  contradictions: DocumentContradiction[];
  citationLog: DocumentCitationLogEntry[];
};
