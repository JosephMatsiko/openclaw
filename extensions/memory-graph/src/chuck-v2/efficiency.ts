import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_CHUCK_CONFIG } from "./config.js";
import type {
  AlignmentMatrix,
  ChuckConfig,
  ChuckFamily,
  ChuckFleetEntry,
  Claim,
  MachineResourceSnapshot,
  StakeClass,
  TaskClass,
  WorkerHealthSnapshot,
} from "./types.js";

export type EfficiencyStage = "scout" | "deepen" | "resolve";
export type FleetSchedulingMode = "parallel" | "staggered" | "blocked-trivial-only";
export type EfficiencyVisibility = "receipts-only" | "operator-visible";
export type EfficiencyOptionKind =
  | "fleet-scout"
  | "fleet-deepen"
  | "fleet-resolve"
  | "single-surface"
  | "docket";

export type CalibrationTaskKind =
  | "code"
  | "current-facts"
  | "repo-reasoning"
  | "source-heavy-research"
  | "ui-browser-work"
  | "local-private-work"
  | "general";

export type SurfaceReliabilityProfile = {
  family: ChuckFamily;
  surface: string;
  taskKind: CalibrationTaskKind;
  reliability: number;
  sampleCount: number;
  observedAt?: string;
  halfLifeDays?: number;
  stability?: number;
};

export type ReliabilityActivation = {
  activeForRouting: boolean;
  decayedReliability: number;
  reason: string;
};

export type EfficiencyScoreVector = {
  invariantSafety: number;
  expectedQuality: number;
  reliability: number;
  latency: number;
  memory: number;
  quota: number;
  operatorAttention: number;
  externalFootprint: number;
  recovery: number;
};

export type EfficiencyOption = {
  optionId: string;
  kind: EfficiencyOptionKind;
  stage: EfficiencyStage;
  families: ChuckFamily[];
  surfaces: string[];
  schedulingMode: FleetSchedulingMode;
  promptBudgetChars: number;
  timeoutMs: number;
  dropOnTimeout: boolean;
  scoreVector: EfficiencyScoreVector;
  reasons: string[];
};

export type RejectedEfficiencyOption = EfficiencyOption & {
  rejectedBecause: string;
};

export type FleetEfficiencyPlan = {
  protocol: "scout-deepen-resolve";
  defaultStage: EfficiencyStage;
  schedulingMode: FleetSchedulingMode;
  scoutTimeoutMs: number;
  deepenTimeoutMs: number;
  lateScoutPolicy: "drop-from-round";
  sealedFirstRound: true;
  identityBlindSecondRound: true;
  randomizedAdjudicationOrder: true;
  persuasiveMajorityMayOverrideEvidence: false;
  healthyFamilies: ChuckFamily[];
  healthySurfaces: string[];
  scoutPromptBudgetChars: number;
  deepenPromptBudgetChars: number;
};

export type EfficiencyDecision = {
  decisionId: string;
  runId: string;
  action: string;
  stage: EfficiencyStage;
  fleetPlan: FleetEfficiencyPlan;
  candidateOptions: EfficiencyOption[];
  rejectedOptions: RejectedEfficiencyOption[];
  chosenOption: EfficiencyOption;
  reason: string;
  visibleToOperator: EfficiencyVisibility;
};

export type ScoutRoundPrompt = {
  sealed: true;
  includesPeerOutputs: false;
  maxChars: number;
  timeoutMs: number;
  dropOnTimeout: true;
  prompt: string;
};

export type NormalizedAdjudicationClaim = {
  id: string;
  text: string;
  evidenceClass: Claim["evidenceClass"];
  category: Claim["category"];
  confidence: number;
};

export type BlindedAdjudicationPacket = {
  identityBlind: true;
  randomizedOrder: true;
  persuasiveMajorityMayOverrideEvidence: false;
  claims: NormalizedAdjudicationClaim[];
  hiddenProvenance: Array<{
    claimId: string;
    producedBy: string[];
    sourceSpanCount: number;
  }>;
};

export type DeepenTrigger =
  | "stake-high"
  | "claim-cluster-conflict"
  | "large-minority"
  | "low-claim-similarity"
  | "uncertainty-threshold"
  | "source-heavy"
  | "missing-citation"
  | "verifier-failed"
  | "code-diff-risk";

export type DeepenDecision = {
  shouldDeepen: boolean;
  triggers: DeepenTrigger[];
  reasons: string[];
};

export type VerifierStatus = "not-run" | "passed" | "failed";

export type ContrarianDeepenPrompt = {
  identityBlind: true;
  bindingPremise: false;
  prompt: string;
};

export type GroundTruthAnchorKind =
  | "deterministic-verifier"
  | "repo-source-spans"
  | "citation-span-integrity"
  | "runtime-receipts-and-approval"
  | "structural-judgment-only";

export type GroundTruthAnchor = {
  kind: GroundTruthAnchorKind;
  factualAuthority: "strong" | "bounded" | "structural-only";
  requiredSignals: string[];
};

export type TraceGradeInput = {
  correctness?: number;
  evidenceQuality?: number;
  latencyMs?: number;
  memoryMb?: number;
  quotaCalls?: number;
  operatorAttentionMinutes?: number;
  refusalQuality?: number;
  failures?: number;
};

export type TraceGrade = {
  grade: "pass" | "watch" | "fail";
  score: number;
  regressionSignals: string[];
};

const VOICE_TO_HEALTH_KEY: Record<string, string> = {
  "claude-cli": "claude",
  "claude-ai": "claude-ai",
  "claude-mac": "claude-mac",
  "chatgpt-web": "chatgpt",
  "chatgpt-mac": "chatgpt-mac",
  codex: "codex",
  "codex-review": "codex-review",
  "gemini-cli": "gemini",
  "gemini-web": "gemini-web",
  "gemini-studio": "aistudio",
  "perplexity-mac": "perplexity",
  "perplexity-web": "perplexity",
  grok: "grok",
  "ollama-local": "ollama",
};

export function planFleetEfficiency({
  runId,
  requestText,
  stakeClass,
  taskClass,
  config = DEFAULT_CHUCK_CONFIG,
  health,
  resources,
  reliabilityProfiles = [],
}: {
  runId: string;
  requestText: string;
  stakeClass: StakeClass;
  taskClass: TaskClass;
  config?: ChuckConfig;
  health?: WorkerHealthSnapshot;
  resources?: MachineResourceSnapshot;
  reliabilityProfiles?: SurfaceReliabilityProfile[];
}): EfficiencyDecision {
  const healthyEntries = entriesHealthyForEfficiency(config.fleet, health);
  const healthyFamilies = uniqueFamilies(healthyEntries.map((entry) => entry.family));
  const healthySurfaces = healthyEntries.map((entry) => entry.surface);
  const schedulingMode = schedulingModeFor({ resources, stakeClass });
  const taskKind = calibrationTaskKindFor({ taskClass, requestText });
  const rankedEntries = rankFleetEntriesByReliability({
    entries: healthyEntries,
    taskKind,
    reliabilityProfiles,
  });
  const fleetPlan: FleetEfficiencyPlan = {
    protocol: "scout-deepen-resolve",
    defaultStage: "scout",
    schedulingMode,
    scoutTimeoutMs: scoutTimeoutMsFor({ config, stakeClass, schedulingMode }),
    deepenTimeoutMs: config.budgets.highRiskTimeoutMs,
    lateScoutPolicy: "drop-from-round",
    sealedFirstRound: true,
    identityBlindSecondRound: true,
    randomizedAdjudicationOrder: true,
    persuasiveMajorityMayOverrideEvidence: false,
    healthyFamilies,
    healthySurfaces,
    scoutPromptBudgetChars: 3_500,
    deepenPromptBudgetChars: 12_000,
  };
  const fleetScout = option({
    kind: "fleet-scout",
    stage: "scout",
    entries: rankedEntries,
    schedulingMode,
    promptBudgetChars: fleetPlan.scoutPromptBudgetChars,
    timeoutMs: fleetPlan.scoutTimeoutMs,
    dropOnTimeout: true,
    scoreVector: scoreVectorFor({
      kind: "fleet-scout",
      stakeClass,
      schedulingMode,
      healthyFamilyCount: healthyFamilies.length,
    }),
    reasons: [
      "Fleet-default: every healthy family gets a sealed short first pass",
      "Scout pass preserves adversarial coverage without full-context blast",
    ],
  });
  const singleSurface = option({
    kind: "single-surface",
    stage: "scout",
    entries: singleSurfaceEntriesFor({ entries: rankedEntries, stakeClass }),
    schedulingMode,
    promptBudgetChars: 1_800,
    timeoutMs: Math.min(config.budgets.defaultTimeoutMs, 30_000),
    dropOnTimeout: true,
    scoreVector: scoreVectorFor({
      kind: "single-surface",
      stakeClass,
      schedulingMode,
      healthyFamilyCount: healthyFamilies.length,
    }),
    reasons: ["single surface reserved for genuinely trivial or constrained work"],
  });
  const docket = option({
    kind: "docket",
    stage: "scout",
    entries: [],
    schedulingMode,
    promptBudgetChars: 0,
    timeoutMs: 0,
    dropOnTimeout: false,
    scoreVector: scoreVectorFor({
      kind: "docket",
      stakeClass,
      schedulingMode,
      healthyFamilyCount: healthyFamilies.length,
    }),
    reasons: ["resource pressure prevents non-trivial Fleet work"],
  });
  const candidateOptions = [fleetScout, singleSurface, docket];
  const rejectedOptions: RejectedEfficiencyOption[] = [];
  let chosenOption = fleetScout;
  let reason = "non-trivial work defaults to Fleet scout";

  if (schedulingMode === "blocked-trivial-only" && stakeClass !== "trivial") {
    chosenOption = docket;
    reason = "critical memory admits only trivial work";
    rejectedOptions.push(reject(fleetScout, "critical memory pressure"));
    rejectedOptions.push(
      reject(singleSurface, "non-trivial work cannot route around critical memory"),
    );
  } else if (stakeClass === "trivial") {
    chosenOption = singleSurface;
    reason = "trivial work can use the least-action single-surface path";
    rejectedOptions.push(reject(fleetScout, "adversarial Fleet would not add meaningful value"));
    rejectedOptions.push(reject(docket, "resources allow trivial execution"));
  } else {
    rejectedOptions.push(
      reject(singleSurface, "would discard the Fleet advantage for non-trivial work"),
    );
    rejectedOptions.push(reject(docket, "Fleet work is admitted"));
  }

  return {
    decisionId: `eff-${randomUUID()}`,
    runId,
    action: "fleet-route",
    stage: chosenOption.stage,
    fleetPlan,
    candidateOptions,
    rejectedOptions,
    chosenOption,
    reason,
    visibleToOperator: visibilityFor({ chosenOption, schedulingMode, stakeClass }),
  };
}

export function buildScoutRoundPrompt({
  requestText,
  maxChars = 3_500,
  timeoutMs = 45_000,
}: {
  requestText: string;
  maxChars?: number;
  timeoutMs?: number;
}): ScoutRoundPrompt {
  const clipped =
    requestText.length > maxChars
      ? `${requestText.slice(0, maxChars - 32)}\n[clipped for scout pass]`
      : requestText;
  return {
    sealed: true,
    includesPeerOutputs: false,
    maxChars,
    timeoutMs,
    dropOnTimeout: true,
    prompt: [
      "You are one independent Fleet scout. Do not infer or reference other model outputs.",
      "Return concise claims, risks, missing evidence, and whether deeper review is needed.",
      "",
      clipped,
    ].join("\n"),
  };
}

export function shouldDeepenFleetScout({
  stakeClass,
  taskClass,
  requestText = "",
  alignmentMatrix,
  claims = [],
  uncertaintyScore = 0,
  verifierStatus = "not-run",
  generatedDiffText = "",
}: {
  stakeClass: StakeClass;
  taskClass: TaskClass;
  requestText?: string;
  alignmentMatrix?: AlignmentMatrix;
  claims?: Claim[];
  uncertaintyScore?: number;
  verifierStatus?: VerifierStatus;
  generatedDiffText?: string;
}): DeepenDecision {
  const triggers = computeDeepenTriggers({
    stakeClass,
    taskClass,
    requestText,
    alignmentMatrix,
    claims,
    uncertaintyScore,
    verifierStatus,
    generatedDiffText,
  });
  const reasons: string[] = [];
  if (
    stakeClass === "high-readonly" ||
    stakeClass === "high-mutating" ||
    stakeClass === "destructive"
  ) {
    reasons.push(`stake ${stakeClass} requires deeper review`);
  }
  if (
    (alignmentMatrix?.contradictions.length ?? 0) > 0 ||
    (alignmentMatrix?.clusters.length ?? 0) > 1
  ) {
    reasons.push("scout pass found conflict or multiple claim clusters");
  }
  if (uncertaintyScore >= 0.25) {
    reasons.push(`uncertainty ${uncertaintyScore.toFixed(2)} exceeds deepen threshold`);
  }
  if (taskClass === "factual" && sourceHeavyRequest(requestText)) {
    reasons.push("source-heavy factual task needs evidence deepening");
  }
  if (triggers.includes("large-minority")) {
    reasons.push("minority block is large enough to preserve for deeper resolution");
  }
  if (triggers.includes("low-claim-similarity")) {
    reasons.push("claim clusters are lexically distant enough to require normalization");
  }
  if (triggers.includes("missing-citation")) {
    reasons.push("source-grounded task is missing citation spans");
  }
  if (triggers.includes("verifier-failed")) {
    reasons.push("deterministic verifier failed");
  }
  if (triggers.includes("code-diff-risk")) {
    reasons.push("generated code or diff changes authority-sensitive surface");
  }
  return {
    shouldDeepen: triggers.length > 0,
    triggers,
    reasons,
  };
}

export function computeDeepenTriggers({
  stakeClass,
  taskClass,
  requestText = "",
  alignmentMatrix,
  claims = [],
  uncertaintyScore = 0,
  verifierStatus = "not-run",
  generatedDiffText = "",
}: {
  stakeClass: StakeClass;
  taskClass: TaskClass;
  requestText?: string;
  alignmentMatrix?: AlignmentMatrix;
  claims?: Claim[];
  uncertaintyScore?: number;
  verifierStatus?: VerifierStatus;
  generatedDiffText?: string;
}): DeepenTrigger[] {
  const triggers = new Set<DeepenTrigger>();
  if (
    stakeClass === "high-readonly" ||
    stakeClass === "high-mutating" ||
    stakeClass === "destructive"
  ) {
    triggers.add("stake-high");
  }
  if (
    (alignmentMatrix?.contradictions.length ?? 0) > 0 ||
    (alignmentMatrix?.clusters.length ?? 0) > 1
  ) {
    triggers.add("claim-cluster-conflict");
  }
  const clusterSizes =
    alignmentMatrix?.clusters
      .map((cluster) => new Set(cluster.familyVotes).size)
      .toSorted((a, b) => b - a) ?? [];
  if ((clusterSizes[1] ?? 0) >= 2) {
    triggers.add("large-minority");
  }
  if (clusterSizes.length > 1 && lowestClusterSimilarity(alignmentMatrix) < 0.25) {
    triggers.add("low-claim-similarity");
  }
  if (uncertaintyScore >= 0.25) {
    triggers.add("uncertainty-threshold");
  }
  if (taskClass === "factual" && sourceHeavyRequest(requestText)) {
    triggers.add("source-heavy");
  }
  if (
    requiresCitationSpan({ taskClass, requestText }) &&
    claims.length > 0 &&
    claims.every((claim) => claim.sourceSpans.length === 0)
  ) {
    triggers.add("missing-citation");
  }
  if (verifierStatus === "failed") {
    triggers.add("verifier-failed");
  }
  if (taskClass === "code-mutation" && authoritySensitiveDiff(generatedDiffText)) {
    triggers.add("code-diff-risk");
  }
  return [...triggers];
}

export function createBlindedAdjudicationPacket({
  claims,
  seed = "chuck-v2-adjudication",
}: {
  claims: Claim[];
  seed?: string;
}): BlindedAdjudicationPacket {
  return {
    identityBlind: true,
    randomizedOrder: true,
    persuasiveMajorityMayOverrideEvidence: false,
    claims: claims
      .map((claim) => ({
        id: claim.id,
        text: normalizeClaimText(claim.text),
        evidenceClass: claim.evidenceClass,
        category: claim.category,
        confidence: claim.confidence,
      }))
      .toSorted((a, b) => seededOrder(`${seed}:${a.id}`) - seededOrder(`${seed}:${b.id}`)),
    hiddenProvenance: claims.map((claim) => ({
      claimId: claim.id,
      producedBy: claim.producedBy,
      sourceSpanCount: claim.sourceSpans.length,
    })),
  };
}

export function normalizeClaimText(text: string): string {
  return text
    .replace(
      /\b(Claude|ChatGPT|Codex|Gemini|Perplexity|Grok|Llama)\s+(says|said|argues|believes|claims)\s+that\s+/gi,
      "",
    )
    .replace(
      /\b(as an AI language model|I apologize,? but|sorry,? but|I believe|I think|in my opinion)\b[:,]?\s*/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function buildContrarianDeepenPrompt({
  requestText,
  normalizedClaim,
  maxChars = 6_000,
}: {
  requestText: string;
  normalizedClaim: NormalizedAdjudicationClaim;
  maxChars?: number;
}): ContrarianDeepenPrompt {
  const clippedRequest = clipText(requestText, Math.floor(maxChars * 0.5), "request clipped");
  const clippedClaim = clipText(normalizedClaim.text, Math.floor(maxChars * 0.35), "claim clipped");
  return {
    identityBlind: true,
    bindingPremise: false,
    prompt: [
      "Run an adversarial deepen pass on the task below.",
      "Treat the candidate objection as a hypothesis to test, not as a binding fact.",
      "Validate the premise against evidence, tests, receipts, or source spans before changing the final action.",
      "",
      "Task:",
      clippedRequest,
      "",
      "Candidate objection:",
      clippedClaim,
    ].join("\n"),
  };
}

export function rankFleetEntriesByReliability({
  entries,
  taskKind,
  reliabilityProfiles = [],
  now = new Date(),
}: {
  entries: ChuckFleetEntry[];
  taskKind: CalibrationTaskKind;
  reliabilityProfiles?: SurfaceReliabilityProfile[];
  now?: Date;
}): ChuckFleetEntry[] {
  return [...entries].toSorted((a, b) => {
    const bScore = calibratedReliability({ entry: b, taskKind, reliabilityProfiles, now });
    const aScore = calibratedReliability({ entry: a, taskKind, reliabilityProfiles, now });
    if (bScore !== aScore) {
      return bScore - aScore;
    }
    return surfacePriority(a.surface) - surfacePriority(b.surface);
  });
}

export function reliabilityActivationForProfile({
  profile,
  now = new Date(),
  minimumSamples = 12,
}: {
  profile: SurfaceReliabilityProfile;
  now?: Date;
  minimumSamples?: number;
}): ReliabilityActivation {
  const decayedReliability = decayedReliabilityForProfile({ profile, now });
  if (profile.sampleCount < minimumSamples) {
    return {
      activeForRouting: false,
      decayedReliability,
      reason: `cold start: ${profile.sampleCount}/${minimumSamples} samples`,
    };
  }
  if ((profile.stability ?? 1) < 0.6) {
    return {
      activeForRouting: false,
      decayedReliability,
      reason: "calibration instability below routing floor",
    };
  }
  return {
    activeForRouting: true,
    decayedReliability,
    reason: "profile active for routing",
  };
}

export function decayedReliabilityForProfile({
  profile,
  now = new Date(),
}: {
  profile: SurfaceReliabilityProfile;
  now?: Date;
}): number {
  const reliability = clamp01(profile.reliability);
  if (!profile.observedAt) {
    return reliability;
  }
  const observedMs = Date.parse(profile.observedAt);
  if (!Number.isFinite(observedMs)) {
    return reliability;
  }
  const ageDays = Math.max(0, (now.getTime() - observedMs) / 86_400_000);
  const halfLifeDays = Math.max(1, profile.halfLifeDays ?? 21);
  const decay = 0.5 ** (ageDays / halfLifeDays);
  return clamp01(0.5 + (reliability - 0.5) * decay);
}

export function groundTruthAnchorForTask({
  stakeClass,
  taskClass,
  requestText = "",
}: {
  stakeClass: StakeClass;
  taskClass: TaskClass;
  requestText?: string;
}): GroundTruthAnchor {
  if (taskClass === "code-mutation" || taskClass === "code-review") {
    return {
      kind: "deterministic-verifier",
      factualAuthority: "strong",
      requiredSignals: ["build/test/lint result", "diff scope", "runtime receipt"],
    };
  }
  if (sourceHeavyRequest(requestText) || taskClass === "factual") {
    return {
      kind: "citation-span-integrity",
      factualAuthority: "bounded",
      requiredSignals: ["source exists", "span supports claim", "retrieval timestamp"],
    };
  }
  if (taskClass === "architecture" || taskClass === "vault-doctrine") {
    return {
      kind: "structural-judgment-only",
      factualAuthority: "structural-only",
      requiredSignals: ["internal consistency", "evidence-to-claim ratio", "dissent retained"],
    };
  }
  if (
    stakeClass === "destructive" ||
    taskClass === "destructive-action" ||
    taskClass === "skill-install"
  ) {
    return {
      kind: "runtime-receipts-and-approval",
      factualAuthority: "bounded",
      requiredSignals: ["receipt match", "operator approval", "rollback state"],
    };
  }
  return {
    kind: "repo-source-spans",
    factualAuthority: "bounded",
    requiredSignals: ["local fact span", "receipt", "claim provenance"],
  };
}

export function gradeEfficiencyTrace(input: TraceGradeInput): TraceGrade {
  const regressionSignals: string[] = [];
  const correctness = normalizedMetric(input.correctness, 0.5);
  const evidenceQuality = normalizedMetric(input.evidenceQuality, 0.5);
  const refusalQuality = normalizedMetric(input.refusalQuality, 0.75);
  const latencyPenalty =
    input.latencyMs === undefined ? 0 : Math.min(0.2, input.latencyMs / 3_600_000);
  const memoryPenalty = input.memoryMb === undefined ? 0 : Math.min(0.2, input.memoryMb / 32_000);
  const quotaPenalty = input.quotaCalls === undefined ? 0 : Math.min(0.15, input.quotaCalls / 40);
  const attentionPenalty =
    input.operatorAttentionMinutes === undefined
      ? 0
      : Math.min(0.2, input.operatorAttentionMinutes / 60);
  const failurePenalty = input.failures === undefined ? 0 : Math.min(0.3, input.failures * 0.1);
  const score = clamp01(
    0.35 * correctness +
      0.25 * evidenceQuality +
      0.15 * refusalQuality +
      0.25 -
      latencyPenalty -
      memoryPenalty -
      quotaPenalty -
      attentionPenalty -
      failurePenalty,
  );

  if (correctness < 0.7) {
    regressionSignals.push("correctness below route-change floor");
  }
  if (evidenceQuality < 0.65) {
    regressionSignals.push("evidence quality below route-change floor");
  }
  if ((input.failures ?? 0) > 0) {
    regressionSignals.push("run had tool/surface failures");
  }
  if ((input.operatorAttentionMinutes ?? 0) > 10) {
    regressionSignals.push("operator attention cost too high");
  }

  return {
    grade:
      score >= 0.75 && regressionSignals.length === 0 ? "pass" : score >= 0.55 ? "watch" : "fail",
    score: Number(score.toFixed(4)),
    regressionSignals,
  };
}

function entriesHealthyForEfficiency(
  fleet: ChuckFleetEntry[],
  health?: WorkerHealthSnapshot,
): ChuckFleetEntry[] {
  return fleet.filter((entry) => {
    const key = VOICE_TO_HEALTH_KEY[entry.voice] ?? entry.voice;
    const row = health?.workers[key];
    return row?.healthy !== false;
  });
}

function singleSurfaceEntriesFor({
  entries,
  stakeClass,
}: {
  entries: ChuckFleetEntry[];
  stakeClass: StakeClass;
}): ChuckFleetEntry[] {
  if (stakeClass === "trivial") {
    const local = entries.find((entry) => entry.family === "sovereign-local");
    if (local) {
      return [local];
    }
  }
  return entries.slice(0, 1);
}

function schedulingModeFor({
  resources,
  stakeClass,
}: {
  resources?: MachineResourceSnapshot;
  stakeClass: StakeClass;
}): FleetSchedulingMode {
  if (resources?.memoryPressure === "critical" && stakeClass !== "trivial") {
    return "blocked-trivial-only";
  }
  if (resources?.memoryPressure === "warning") {
    return "staggered";
  }
  return "parallel";
}

function option({
  kind,
  stage,
  entries,
  schedulingMode,
  promptBudgetChars,
  timeoutMs,
  dropOnTimeout,
  scoreVector,
  reasons,
}: {
  kind: EfficiencyOptionKind;
  stage: EfficiencyStage;
  entries: ChuckFleetEntry[];
  schedulingMode: FleetSchedulingMode;
  promptBudgetChars: number;
  timeoutMs: number;
  dropOnTimeout: boolean;
  scoreVector: EfficiencyScoreVector;
  reasons: string[];
}): EfficiencyOption {
  return {
    optionId: `${kind}-${stage}`,
    kind,
    stage,
    families: uniqueFamilies(entries.map((entry) => entry.family)),
    surfaces: entries.map((entry) => entry.surface),
    schedulingMode,
    promptBudgetChars,
    timeoutMs,
    dropOnTimeout,
    scoreVector,
    reasons,
  };
}

function reject(
  optionToReject: EfficiencyOption,
  rejectedBecause: string,
): RejectedEfficiencyOption {
  return {
    ...optionToReject,
    rejectedBecause,
  };
}

function scoreVectorFor({
  kind,
  stakeClass,
  schedulingMode,
  healthyFamilyCount,
}: {
  kind: EfficiencyOptionKind;
  stakeClass: StakeClass;
  schedulingMode: FleetSchedulingMode;
  healthyFamilyCount: number;
}): EfficiencyScoreVector {
  const fleetCoverage = Math.min(1, healthyFamilyCount / 5);
  const highStake =
    stakeClass === "high-readonly" ||
    stakeClass === "high-mutating" ||
    stakeClass === "destructive";
  if (kind === "single-surface") {
    return {
      invariantSafety: highStake ? 0.45 : 0.9,
      expectedQuality: highStake ? 0.45 : 0.72,
      reliability: 0.65,
      latency: 0.95,
      memory: 0.9,
      quota: 0.95,
      operatorAttention: 0.9,
      externalFootprint: 0.82,
      recovery: 0.7,
    };
  }
  if (kind === "docket") {
    return {
      invariantSafety: 1,
      expectedQuality: 0,
      reliability: 1,
      latency: 0.3,
      memory: 1,
      quota: 1,
      operatorAttention: 0.55,
      externalFootprint: 1,
      recovery: 0.95,
    };
  }
  return {
    invariantSafety: 0.98,
    expectedQuality: Math.max(0.72, fleetCoverage),
    reliability: fleetCoverage,
    latency: schedulingMode === "parallel" ? 0.7 : 0.45,
    memory: schedulingMode === "staggered" ? 0.75 : 0.55,
    quota: 0.5,
    operatorAttention: 0.72,
    externalFootprint: 0.68,
    recovery: 0.82,
  };
}

function visibilityFor({
  chosenOption,
  schedulingMode,
  stakeClass,
}: {
  chosenOption: EfficiencyOption;
  schedulingMode: FleetSchedulingMode;
  stakeClass: StakeClass;
}): EfficiencyVisibility {
  if (
    chosenOption.kind === "docket" ||
    schedulingMode !== "parallel" ||
    stakeClass === "high-mutating" ||
    stakeClass === "destructive"
  ) {
    return "operator-visible";
  }
  return "receipts-only";
}

function calibrationTaskKindFor({
  taskClass,
  requestText,
}: {
  taskClass: TaskClass;
  requestText: string;
}): CalibrationTaskKind {
  const text = requestText.toLowerCase();
  if (taskClass === "code-mutation" || taskClass === "code-review") {
    return text.includes("repo") || text.includes("codebase") ? "repo-reasoning" : "code";
  }
  if (taskClass === "factual" && sourceHeavyRequest(requestText)) {
    return "source-heavy-research";
  }
  if (taskClass === "factual") {
    return "current-facts";
  }
  if (
    text.includes("browser") ||
    text.includes("app") ||
    text.includes("screen") ||
    text.includes("ui")
  ) {
    return "ui-browser-work";
  }
  if (text.includes("private") || text.includes("local") || text.includes("vault")) {
    return "local-private-work";
  }
  return "general";
}

function sourceHeavyRequest(text: string): boolean {
  return /\b(latest|current|today|source|citation|cite|research|web|news|live|verify)\b/i.test(
    text,
  );
}

function calibratedReliability({
  entry,
  taskKind,
  reliabilityProfiles,
  now,
}: {
  entry: ChuckFleetEntry;
  taskKind: CalibrationTaskKind;
  reliabilityProfiles: SurfaceReliabilityProfile[];
  now: Date;
}): number {
  const exact = reliabilityProfiles.find(
    (profile) =>
      profile.family === entry.family &&
      profile.surface === entry.surface &&
      profile.taskKind === taskKind,
  );
  if (exact) {
    const activation = reliabilityActivationForProfile({ profile: exact, now });
    if (activation.activeForRouting) {
      return activation.decayedReliability;
    }
  }
  switch (entry.weightPolicy) {
    case "full-vote":
      return 0.7;
    case "partial-vote":
      return 0.58;
    case "flag-not-vote":
      return 0.45;
  }
  return 0.5;
}

function scoutTimeoutMsFor({
  config,
  stakeClass,
  schedulingMode,
}: {
  config: ChuckConfig;
  stakeClass: StakeClass;
  schedulingMode: FleetSchedulingMode;
}): number {
  if (schedulingMode === "blocked-trivial-only") {
    return 0;
  }
  const base =
    stakeClass === "high-readonly" || stakeClass === "high-mutating" || stakeClass === "destructive"
      ? Math.min(config.budgets.highRiskTimeoutMs, 90_000)
      : Math.min(config.budgets.defaultTimeoutMs, 45_000);
  return schedulingMode === "staggered" ? Math.max(15_000, Math.floor(base * 0.75)) : base;
}

function requiresCitationSpan({
  taskClass,
  requestText,
}: {
  taskClass: TaskClass;
  requestText: string;
}): boolean {
  return taskClass === "factual" || sourceHeavyRequest(requestText);
}

function authoritySensitiveDiff(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  return /\b(import\s+.*(?:child_process|fs|node:fs|node:child_process|net|http|https)|exec(File|Sync)?\(|spawn\(|fetch\(|curl\b|chmod\b|sudo\b|launchctl\b|Keychain|credential|token|secret|password|\.plist|LaunchAgents|network|socket)\b/i.test(
    text,
  );
}

function lowestClusterSimilarity(alignmentMatrix?: AlignmentMatrix): number {
  const summaries =
    alignmentMatrix?.clusters
      .map((cluster) => cluster.summary)
      .filter((summary) => summary.trim()) ?? [];
  if (summaries.length < 2) {
    return 1;
  }
  let lowest = 1;
  for (let i = 0; i < summaries.length; i += 1) {
    for (let j = i + 1; j < summaries.length; j += 1) {
      lowest = Math.min(lowest, lexicalJaccard(summaries[i], summaries[j]));
    }
  }
  return lowest;
}

function lexicalJaccard(a: string, b: string): number {
  const aWords = wordSet(a);
  const bWords = wordSet(b);
  if (aWords.size === 0 && bWords.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) {
      intersection += 1;
    }
  }
  return intersection / new Set([...aWords, ...bWords]).size;
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9_]{3,}/g)
      ?.filter((word) => !COMMON_WORDS.has(word)) ?? [],
  );
}

function clipText(text: string, maxChars: number, marker: string): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - marker.length - 4))}\n[${marker}]`
    : text;
}

const COMMON_WORDS = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "has",
  "that",
  "the",
  "this",
  "with",
  "would",
]);

function surfacePriority(surface: string): number {
  if (surface.includes("/exec") || surface.includes("/cli") || surface.includes("localhost")) {
    return 0;
  }
  if (surface.includes("mac-app")) {
    return 1;
  }
  return 2;
}

function uniqueFamilies(families: ChuckFamily[]): ChuckFamily[] {
  return [...new Set(families)];
}

function seededOrder(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 12), 16);
}

function normalizedMetric(value: number | undefined, fallback: number): number {
  return clamp01(value ?? fallback);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
