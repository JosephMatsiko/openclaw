import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCapabilityLedger,
  loadLateSurfaceRecoveries,
  loadSurfaceProofDetails,
  type CapabilityLedger,
} from "./capability-ledger.js";
import {
  CHUCK_V2_STATE_DIR,
  DEFAULT_CHUCK_CONFIG,
  configWithSafeCliScoutSurfaces,
} from "./config.js";
import { appendChuckEventLine, createChuckEvent } from "./events.js";
import {
  docketItemsForModelDoctor,
  loadRunnerSurfaceProofs,
  runModelDoctor,
} from "./model-doctor.js";
import type { ModelDoctorReport, RunnerSurfaceProof } from "./model-doctor.js";
import { captureDarwinMemorySnapshot } from "./resources.js";
import type {
  CapabilityProfile,
  ChuckConfig,
  ChuckFamily,
  ChuckFleetEntry,
  DocketItem,
  MachineResourceSnapshot,
  WorkerHealthSnapshot,
} from "./types.js";

export type OnboardingActionKind =
  | "prove-surface"
  | "repair-surface"
  | "resource-relief"
  | "command-proof"
  | "dashboard-proof"
  | "future-candidate-intake"
  | "candidate-registry"
  | "candidate-proof"
  | "candidate-calibration";

export type OnboardingActionRisk =
  | "auto-safe"
  | "operator-action"
  | "approval-required"
  | "blocked";

export type OnboardingAction = {
  id: string;
  kind: OnboardingActionKind;
  title: string;
  risk: OnboardingActionRisk;
  family?: ChuckFamily;
  surface?: string;
  reasons: string[];
  next: string;
  autoRepairAvailable: boolean;
};

export type OnboardingStageStatus = "ready" | "degraded" | "blocked";

export type OnboardingStage = {
  id: string;
  title: string;
  status: OnboardingStageStatus;
  summary: string;
  actionIds: string[];
};

export type FutureCandidatePolicy = {
  intakeCommand: string;
  memberCommand: string;
  countsAsFamilyOnlyAfter: string[];
  defaultRisk: OnboardingActionRisk;
};

export type FamilyMemberSurfaceProfile = {
  family: ChuckFamily;
  surface: string;
  label: string;
  role: "primary" | "child" | "cousin" | "fallback" | "local-model";
  status: "configured" | "planned";
  countsAsIndependentFamily: false;
  notes: string[];
};

export type ChuckOnboardingReport = {
  runId: string;
  generatedAt: string;
  stateDir: string;
  readinessScore: number;
  status: OnboardingStageStatus;
  doctor: ModelDoctorReport;
  capabilityLedger: CapabilityLedger;
  resources: MachineResourceSnapshot;
  stages: OnboardingStage[];
  actions: OnboardingAction[];
  futureCandidatePolicy: FutureCandidatePolicy;
  familyMemberCatalog: FamilyMemberSurfaceProfile[];
  repairMode: boolean;
  repairSummary: {
    safeRepairsApplied: string[];
    docketItemsCreated: number;
    approvalRequired: number;
  };
};

export type CandidateClassification =
  | "existing-family-new-surface"
  | "configured-surface"
  | "new-family-candidate";

export type CandidateOnboardingRecord = {
  candidateId: string;
  createdAt: string;
  stateDir: string;
  familyOrProduct: string;
  proposedFamily: ChuckFamily;
  familyLabel: string;
  surface: string;
  voice: string;
  classification: CandidateClassification;
  capabilityProfile: CapabilityProfile;
  commercialPolicy: ChuckFleetEntry["commercialPolicy"];
  quotaPolicy: ChuckFleetEntry["quotaPolicy"];
  weightPolicy: ChuckFleetEntry["weightPolicy"];
  countsAsIndependentFamilyNow: false;
  countsAsIndependentFamilyAfter: string[];
  openClawExposure: "blocked-until-chuck-proof";
  status: "docketed-for-proof" | "blocked";
  reasons: string[];
  requiredPromotionGates: string[];
  actions: OnboardingAction[];
  docketItems: DocketItem[];
  recordPath?: string;
};

export type RunChuckOnboardingInput = {
  config?: ChuckConfig;
  stateDir?: string;
  generatedAt?: string;
  health?: WorkerHealthSnapshot;
  executionProofs?: Record<string, RunnerSurfaceProof>;
  resources?: MachineResourceSnapshot;
  dashboardReachable?: boolean;
  commandRegistered?: boolean;
  repair?: boolean;
};

export type RunCandidateOnboardingInput = {
  config?: ChuckConfig;
  stateDir?: string;
  generatedAt?: string;
  familyOrProduct: string;
  surface: string;
  capabilityProfile?: CapabilityProfile;
  commercialPolicy?: ChuckFleetEntry["commercialPolicy"];
  quotaPolicy?: ChuckFleetEntry["quotaPolicy"];
  weightPolicy?: ChuckFleetEntry["weightPolicy"];
  persist?: boolean;
};

export async function runChuckOnboarding({
  config = configWithSafeCliScoutSurfaces(DEFAULT_CHUCK_CONFIG),
  stateDir = CHUCK_V2_STATE_DIR,
  generatedAt = new Date().toISOString(),
  health,
  executionProofs,
  resources,
  dashboardReachable,
  commandRegistered,
  repair = false,
}: RunChuckOnboardingInput = {}): Promise<ChuckOnboardingReport> {
  const proofs = executionProofs ?? loadRunnerSurfaceProofs({ stateDir });
  const doctor = runModelDoctor({ config, health, executionProofs: proofs, generatedAt, stateDir });
  const resourceSnapshot =
    resources ??
    (await captureDarwinMemorySnapshot().catch(() => ({
      capturedAt: generatedAt,
      memoryPressure: "warning" as const,
      notes: [
        "darwin memory snapshot unavailable; onboarding assumes degraded resources until proven",
      ],
    })));
  const actions = onboardingActions({
    doctor,
    resources: resourceSnapshot,
    dashboardReachable,
    commandRegistered,
  });
  const capabilityLedger = buildCapabilityLedger({
    config,
    doctor,
    executionProofs: proofs,
    proofDetails: loadSurfaceProofDetails({ stateDir }),
    lateRecoveries: loadLateSurfaceRecoveries({ stateDir }),
    resources: resourceSnapshot,
    generatedAt,
  });
  const stages = onboardingStages({
    doctor,
    resources: resourceSnapshot,
    actions,
    dashboardReachable,
    commandRegistered,
  });
  const readinessScore = onboardingReadinessScore(stages);
  const status = stages.some((stage) => stage.status === "blocked")
    ? "blocked"
    : stages.some((stage) => stage.status === "degraded")
      ? "degraded"
      : "ready";
  const report: ChuckOnboardingReport = {
    runId: `onboard-${generatedAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`,
    generatedAt,
    stateDir,
    readinessScore,
    status,
    doctor,
    capabilityLedger,
    resources: resourceSnapshot,
    stages,
    actions,
    futureCandidatePolicy: {
      intakeCommand: "/chuck onboard candidate <family-or-product> <surface>",
      memberCommand: "/chuck onboard member <family> <surface>",
      countsAsFamilyOnlyAfter: [
        "family identity is distinct from existing families",
        "surface metadata includes rationale, commercial policy, quota policy, and capability profile",
        "auth/session proof exists without PAYG dependency unless operator-approved",
        "runner receipts prove actual family attribution at the orchestrator boundary",
        "Phase 0 calibration has enough task-class evidence to promote from provisional",
      ],
      defaultRisk: "operator-action",
    },
    familyMemberCatalog: familyMemberSurfaceCatalog(config),
    repairMode: repair,
    repairSummary: {
      safeRepairsApplied: [],
      docketItemsCreated: 0,
      approvalRequired: actions.filter((action) => action.risk === "approval-required").length,
    },
  };
  if (repair) {
    const persisted = await persistOnboardingReport(report);
    return {
      ...report,
      repairSummary: {
        safeRepairsApplied: ["persisted onboarding report and setup docket"],
        docketItemsCreated: persisted.docketItemsCreated,
        approvalRequired: report.repairSummary.approvalRequired,
      },
    };
  }
  return report;
}

export async function persistOnboardingReport(report: ChuckOnboardingReport): Promise<{
  reportPath: string;
  docketPath: string;
  eventsPath: string;
  docketItemsCreated: number;
}> {
  const stamp = report.generatedAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const onboardingDir = join(report.stateDir, "onboarding");
  const reportPath = join(onboardingDir, `${stamp}.json`);
  const docketPath = join(report.stateDir, "docket.jsonl");
  const eventsPath = join(report.stateDir, "events.jsonl");
  await mkdir(onboardingDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const docketItems = docketItemsForOnboarding(report);
  if (docketItems.length > 0) {
    await appendFile(
      docketPath,
      docketItems.map((item) => `${JSON.stringify(item)}\n`).join(""),
      "utf8",
    );
  }
  await appendFile(
    eventsPath,
    appendChuckEventLine(
      createChuckEvent({
        type: "self-improvement.proposed",
        occurredAt: report.generatedAt,
        eventId: `evt-onboarding-${stamp}`,
        payload: onboardingSummary(report),
      }),
    ),
    "utf8",
  );
  return { reportPath, docketPath, eventsPath, docketItemsCreated: docketItems.length };
}

export async function runCandidateOnboarding({
  config = configWithSafeCliScoutSurfaces(DEFAULT_CHUCK_CONFIG),
  stateDir = CHUCK_V2_STATE_DIR,
  generatedAt = new Date().toISOString(),
  familyOrProduct,
  surface,
  capabilityProfile = "unknown",
  commercialPolicy,
  quotaPolicy = "unknown",
  weightPolicy,
  persist = true,
}: RunCandidateOnboardingInput): Promise<CandidateOnboardingRecord> {
  const cleanFamilyOrProduct = familyOrProduct.trim();
  const cleanSurface = surface.trim();
  if (!cleanFamilyOrProduct || !cleanSurface) {
    throw new Error("candidate onboarding requires both family/product and surface");
  }
  const proposedFamily = normalizeCandidateFamily(cleanFamilyOrProduct);
  const configuredEntry = config.fleet.find((entry) => entry.surface === cleanSurface);
  const sameFamilyConfigured =
    proposedFamily !== "unknown" && config.fleet.some((entry) => entry.family === proposedFamily);
  const classification: CandidateClassification = configuredEntry
    ? "configured-surface"
    : sameFamilyConfigured
      ? "existing-family-new-surface"
      : "new-family-candidate";
  const resolvedCommercialPolicy =
    commercialPolicy ?? (proposedFamily === "sovereign-local" ? "local-only" : "subscription-only");
  const resolvedWeightPolicy =
    weightPolicy ??
    (classification === "existing-family-new-surface" ? "partial-vote" : "flag-not-vote");
  const candidateId = `candidate-${generatedAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}-${sanitizeActionId(`${cleanFamilyOrProduct}-${cleanSurface}`)}`;
  const voice = sanitizeActionId(cleanFamilyOrProduct) || "candidate";
  const reasons = candidateReasons({
    classification,
    proposedFamily,
    cleanFamilyOrProduct,
    cleanSurface,
  });
  const requiredPromotionGates = candidatePromotionGates({ classification });
  const countsAsIndependentFamilyAfter =
    classification === "existing-family-new-surface"
      ? ["never by itself; same-family surfaces provide intra-family signal only"]
      : requiredPromotionGates;
  const actions = candidateOnboardingActions({
    candidateId,
    family: proposedFamily,
    familyOrProduct: cleanFamilyOrProduct,
    surface: cleanSurface,
    classification,
    requiredPromotionGates,
  });
  const status =
    resolvedCommercialPolicy === "operator-approved-exception" ? "blocked" : "docketed-for-proof";
  const record: CandidateOnboardingRecord = {
    candidateId,
    createdAt: generatedAt,
    stateDir,
    familyOrProduct: cleanFamilyOrProduct,
    proposedFamily,
    familyLabel: proposedFamily === "unknown" ? cleanFamilyOrProduct : proposedFamily,
    surface: cleanSurface,
    voice,
    classification,
    capabilityProfile,
    commercialPolicy: resolvedCommercialPolicy,
    quotaPolicy,
    weightPolicy: resolvedWeightPolicy,
    countsAsIndependentFamilyNow: false,
    countsAsIndependentFamilyAfter,
    openClawExposure: "blocked-until-chuck-proof",
    status,
    reasons,
    requiredPromotionGates,
    actions,
    docketItems: [],
  };
  const withDocket = {
    ...record,
    docketItems: docketItemsForCandidate(record),
  };
  if (!persist) {
    return withDocket;
  }
  const persisted = await persistCandidateOnboardingRecord(withDocket);
  return { ...withDocket, recordPath: persisted.recordPath };
}

export async function persistCandidateOnboardingRecord(record: CandidateOnboardingRecord): Promise<{
  recordPath: string;
  docketPath: string;
  eventsPath: string;
  docketItemsCreated: number;
}> {
  const candidatesDir = join(record.stateDir, "candidates");
  const recordPath = join(candidatesDir, `${record.candidateId}.json`);
  const docketPath = join(record.stateDir, "docket.jsonl");
  const eventsPath = join(record.stateDir, "events.jsonl");
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (record.docketItems.length > 0) {
    await appendFile(
      docketPath,
      record.docketItems.map((item) => `${JSON.stringify(item)}\n`).join(""),
      "utf8",
    );
  }
  await appendFile(
    eventsPath,
    appendChuckEventLine(
      createChuckEvent({
        type: "self-improvement.proposed",
        occurredAt: record.createdAt,
        eventId: `evt-${record.candidateId}`,
        payload: candidateOnboardingSummary(record),
      }),
    ),
    "utf8",
  );
  return { recordPath, docketPath, eventsPath, docketItemsCreated: record.docketItems.length };
}

export function onboardingSummary(report: ChuckOnboardingReport): Record<string, unknown> {
  return {
    runId: report.runId,
    status: report.status,
    readinessScore: report.readinessScore,
    configuredFamilies: report.doctor.configuredFamilies,
    executionReadyFamilies: report.doctor.executionReadyFamilies,
    loadBearingSurfaces: report.capabilityLedger.summary.loadBearingSurfaces,
    independentLoadBearingFamilies: report.capabilityLedger.summary.independentLoadBearingFamilies,
    memoryPressure: report.resources.memoryPressure,
    actionCount: report.actions.length,
    familyMemberCount: report.familyMemberCatalog.length,
    plannedFamilyMembers: report.familyMemberCatalog.filter((member) => member.status === "planned")
      .length,
    approvalRequired: report.repairSummary.approvalRequired,
    repairMode: report.repairMode,
  };
}

export function formatOnboardingReport(report: ChuckOnboardingReport): string {
  const lines = [
    `Chuck onboarding ${report.runId}`,
    `Status: ${report.status}`,
    `Readiness: ${report.readinessScore}/100`,
    `Fleet: ${report.doctor.executionReadyFamilies.length}/${report.doctor.configuredFamilies.length} execution-ready families (${report.doctor.executionReadyFamilies.join(", ") || "none"})`,
    `Readiness board: ${report.capabilityLedger.summary.loadBearingSurfaces} load-bearing surface(s); ${report.capabilityLedger.summary.independentLoadBearingFamilyCount} independent load-bearing famil${report.capabilityLedger.summary.independentLoadBearingFamilyCount === 1 ? "y" : "ies"} (${report.capabilityLedger.summary.independentLoadBearingFamilies.join(", ") || "none"})`,
    `Memory: ${report.resources.memoryPressure}${report.resources.freeMemoryMb === undefined ? "" : `, free ${Math.round(report.resources.freeMemoryMb)}MB`}`,
    `Repair: ${report.repairMode ? `${report.repairSummary.docketItemsCreated} docket item(s), ${report.repairSummary.approvalRequired} approval gate(s)` : "not run"}`,
    "",
    "Stages:",
    ...report.stages.map((stage) => `- ${stage.status}: ${stage.title} — ${stage.summary}`),
  ];
  if (report.actions.length > 0) {
    lines.push("", "Next actions:");
    lines.push(
      ...report.actions
        .slice(0, 10)
        .map((action) => `- ${action.risk}: ${action.title} — ${action.next}`),
    );
  }
  lines.push("", `Future candidates: ${report.futureCandidatePolicy.intakeCommand}`);
  lines.push(
    `Family members: ${report.futureCandidatePolicy.memberCommand} (${report.familyMemberCatalog.length} catalogued)`,
  );
  return lines.join("\n");
}

export function familyMemberSurfaceCatalog(
  config: ChuckConfig = configWithSafeCliScoutSurfaces(DEFAULT_CHUCK_CONFIG),
): FamilyMemberSurfaceProfile[] {
  const configured = new Set(config.fleet.map((entry) => `${entry.family}:${entry.surface}`));
  const members: Omit<FamilyMemberSurfaceProfile, "status" | "countsAsIndependentFamily">[] = [
    {
      family: "anthropic",
      surface: "claude-cli/exec",
      label: "Claude CLI / Claude Code",
      role: "primary",
      notes: ["subscription CLI/code surface"],
    },
    {
      family: "anthropic",
      surface: "claude/web-chat",
      label: "Claude web",
      role: "child",
      notes: ["browser fallback; same Anthropic family"],
    },
    {
      family: "anthropic",
      surface: "claude/mac-app",
      label: "Claude Mac app",
      role: "child",
      notes: ["desktop app surface; same Anthropic family", "mode metadata: chat, cowork, code"],
    },
    {
      family: "anthropic",
      surface: "claude/artifacts-design",
      label: "Claude artifacts/design",
      role: "cousin",
      notes: ["specialized creation surface; same Anthropic family"],
    },
    {
      family: "openai",
      surface: "chatgpt/web-chat",
      label: "ChatGPT web",
      role: "primary",
      notes: ["subscription web surface"],
    },
    {
      family: "openai",
      surface: "codex/exec",
      label: "Codex CLI",
      role: "primary",
      notes: ["repo-grounded code surface"],
    },
    {
      family: "openai",
      surface: "codex-review/exec",
      label: "Codex review",
      role: "child",
      notes: ["same OpenAI family; review signal only"],
    },
    {
      family: "openai",
      surface: "chatgpt/mac-app",
      label: "ChatGPT Mac app",
      role: "child",
      notes: ["desktop app surface; same OpenAI family"],
    },
    {
      family: "openai",
      surface: "chatgpt/mobile-voice",
      label: "ChatGPT mobile voice",
      role: "cousin",
      notes: ["voice interface surface; same OpenAI family"],
    },
    {
      family: "google",
      surface: "gemini/cli",
      label: "Gemini CLI",
      role: "primary",
      notes: ["quota-sensitive CLI surface"],
    },
    {
      family: "google",
      surface: "gemini/web-chat",
      label: "Gemini web/PWA",
      role: "child",
      notes: ["consumer Pro fallback; same Google family"],
    },
    {
      family: "google",
      surface: "aistudio/web",
      label: "Google AI Studio",
      role: "cousin",
      notes: [
        "developer studio surface; same Google family",
        "driver must click Run, not Send; prefer the visible Run shortcut when available",
      ],
    },
    {
      family: "google",
      surface: "notebooklm/web",
      label: "NotebookLM",
      role: "cousin",
      notes: ["document-grounded Google cousin; not a family vote"],
    },
    {
      family: "perplexity",
      surface: "perplexity/mac-app",
      label: "Perplexity Mac app",
      role: "primary",
      notes: ["Incognito lease protocol; source-heavy research"],
    },
    {
      family: "perplexity",
      surface: "perplexity/web",
      label: "Perplexity web",
      role: "child",
      notes: ["browser fallback; same Perplexity family"],
    },
    {
      family: "perplexity",
      surface: "perplexity/comet",
      label: "Comet browser",
      role: "cousin",
      notes: ["browser/action surface if available; same Perplexity family"],
    },
    {
      family: "perplexity",
      surface: "perplexity/spaces",
      label: "Perplexity Spaces",
      role: "cousin",
      notes: ["project context surface; same Perplexity family"],
    },
    {
      family: "xai",
      surface: "grok/web-or-app",
      label: "Grok web/app",
      role: "primary",
      notes: ["X/current-social signal"],
    },
    {
      family: "xai",
      surface: "grok/x",
      label: "Grok inside X",
      role: "child",
      notes: ["X-native cousin; same xAI family"],
    },
    {
      family: "xai",
      surface: "grok/mobile",
      label: "Grok mobile",
      role: "child",
      notes: ["mobile surface; same xAI family"],
    },
    {
      family: "sovereign-local",
      surface: "ollama/localhost",
      label: "Ollama local",
      role: "primary",
      notes: ["local sovereignty floor"],
    },
    {
      family: "sovereign-local",
      surface: "lmstudio/local",
      label: "LM Studio",
      role: "local-model",
      notes: ["local model host candidate"],
    },
    {
      family: "sovereign-local",
      surface: "llama.cpp/local",
      label: "llama.cpp",
      role: "local-model",
      notes: ["low-level local runner candidate"],
    },
    {
      family: "sovereign-local",
      surface: "mlx/local",
      label: "MLX local",
      role: "local-model",
      notes: ["Apple Silicon local runner candidate"],
    },
    {
      family: "sovereign-local",
      surface: "qwen/local",
      label: "Qwen local",
      role: "local-model",
      notes: ["candidate local model under local governance"],
    },
    {
      family: "sovereign-local",
      surface: "deepseek/local",
      label: "DeepSeek local",
      role: "local-model",
      notes: ["candidate local model; do not route externally without operator review"],
    },
  ];
  return members.map((member) =>
    Object.assign({}, member, {
      status: configured.has(`${member.family}:${member.surface}`)
        ? ("configured" as const)
        : ("planned" as const),
      countsAsIndependentFamily: false as const,
    }),
  );
}

export function formatCandidateOnboardingRecord(record: CandidateOnboardingRecord): string {
  return [
    `Chuck candidate onboarding ${record.candidateId}`,
    `Status: ${record.status}`,
    `Candidate: ${record.familyOrProduct} via ${record.surface}`,
    `Classification: ${record.classification}`,
    `Proposed family: ${record.proposedFamily}`,
    "Counts as independent family now: no",
    `OpenClaw exposure: ${record.openClawExposure}`,
    `Record: ${record.recordPath ?? "not persisted"}`,
    "",
    "Promotion gates:",
    ...record.requiredPromotionGates.map((gate) => `- ${gate}`),
    "",
    "Next actions:",
    ...record.actions.map((action) => `- ${action.risk}: ${action.title} — ${action.next}`),
  ].join("\n");
}

export function candidateOnboardingSummary(
  record: CandidateOnboardingRecord,
): Record<string, unknown> {
  return {
    candidateId: record.candidateId,
    status: record.status,
    familyOrProduct: record.familyOrProduct,
    proposedFamily: record.proposedFamily,
    surface: record.surface,
    classification: record.classification,
    countsAsIndependentFamilyNow: record.countsAsIndependentFamilyNow,
    openClawExposure: record.openClawExposure,
    docketItems: record.docketItems.length,
  };
}

function onboardingActions({
  doctor,
  resources,
  dashboardReachable,
  commandRegistered,
}: {
  doctor: ModelDoctorReport;
  resources: MachineResourceSnapshot;
  dashboardReachable?: boolean;
  commandRegistered?: boolean;
}): OnboardingAction[] {
  const actions: OnboardingAction[] = [];
  for (const row of doctor.rows) {
    if (row.status !== "ready") {
      actions.push({
        id: `surface-${sanitizeActionId(row.surface)}-setup`,
        kind: "repair-surface",
        title: `Wire ${row.family} via ${row.surface}`,
        risk: "operator-action",
        family: row.family,
        surface: row.surface,
        reasons: [row.healthReason, row.nextAction],
        next: row.guide.setupAction,
        autoRepairAvailable: false,
      });
      continue;
    }
    if (!row.countsAsLoadBearingFamily) {
      actions.push({
        id: `surface-${sanitizeActionId(row.surface)}-proof`,
        kind: "prove-surface",
        title: `Prove ${row.family} via ${row.surface}`,
        risk: "operator-action",
        family: row.family,
        surface: row.surface,
        reasons: [row.executionReason, row.nextAction],
        next: row.guide.preferredProbe,
        autoRepairAvailable: false,
      });
    }
  }
  if (resources.memoryPressure === "warning") {
    actions.push({
      id: "resource-memory-warning",
      kind: "resource-relief",
      title: "Reduce memory pressure before heavy Fleet work",
      risk: "auto-safe",
      reasons: resources.notes ?? ["macOS memory pressure is warning"],
      next: "stagger GUI/app surfaces and avoid high-mutating builder runs until pressure returns to normal",
      autoRepairAvailable: false,
    });
  }
  if (resources.memoryPressure === "critical") {
    actions.push({
      id: "resource-memory-critical",
      kind: "resource-relief",
      title: "Block non-trivial onboarding under critical memory",
      risk: "blocked",
      reasons: resources.notes ?? ["macOS memory pressure is critical"],
      next: "admit only trivial work until memory pressure falls",
      autoRepairAvailable: false,
    });
  }
  if (dashboardReachable === false) {
    actions.push({
      id: "dashboard-unreachable",
      kind: "dashboard-proof",
      title: "Restore Chuck dashboard",
      risk: "auto-safe",
      reasons: ["dashboard health check failed"],
      next: "restart com.openclaw.chuck-dashboard and recheck localhost:7777",
      autoRepairAvailable: true,
    });
  }
  if (commandRegistered === false) {
    actions.push({
      id: "openclaw-command-unregistered",
      kind: "command-proof",
      title: "Register /chuck command with OpenClaw",
      risk: "operator-action",
      reasons: ["/chuck command registration proof missing"],
      next: "load memory-graph extension and prove /chuck help from an authorized channel",
      autoRepairAvailable: false,
    });
  }
  actions.push({
    id: "future-candidate-intake",
    kind: "future-candidate-intake",
    title: "Keep candidate intake open for future model families and products",
    risk: "operator-action",
    reasons: [
      "new labs/products must enter through Chuck Surface Registry before OpenClaw exposure",
    ],
    next: "/chuck onboard candidate <family-or-product> <surface>",
    autoRepairAvailable: false,
  });
  return dedupeActions(actions);
}

function onboardingStages({
  doctor,
  resources,
  actions,
  dashboardReachable,
  commandRegistered,
}: {
  doctor: ModelDoctorReport;
  resources: MachineResourceSnapshot;
  actions: OnboardingAction[];
  dashboardReachable?: boolean;
  commandRegistered?: boolean;
}): OnboardingStage[] {
  const actionIdsFor = (kind: OnboardingActionKind) =>
    actions.filter((action) => action.kind === kind).map((action) => action.id);
  return [
    {
      id: "fleet",
      title: "Fleet surfaces",
      status: doctor.canRunLoadBearingMinimumFleet
        ? doctor.canRunLoadBearingHighRiskFleet
          ? "ready"
          : "degraded"
        : "blocked",
      summary: `${doctor.executionReadyFamilies.length}/${doctor.configuredFamilies.length} families execution-ready`,
      actionIds: [...actionIdsFor("repair-surface"), ...actionIdsFor("prove-surface")],
    },
    {
      id: "resources",
      title: "Mac resource floor",
      status:
        resources.memoryPressure === "critical"
          ? "blocked"
          : resources.memoryPressure === "warning"
            ? "degraded"
            : "ready",
      summary: resources.memoryPressure,
      actionIds: actionIdsFor("resource-relief"),
    },
    {
      id: "openclaw",
      title: "OpenClaw command bridge",
      status: commandRegistered === false ? "degraded" : "ready",
      summary:
        commandRegistered === false
          ? "/chuck proof missing"
          : "/chuck command bridge available or not checked",
      actionIds: actionIdsFor("command-proof"),
    },
    {
      id: "dashboard",
      title: "Dashboard command surface",
      status: dashboardReachable === false ? "degraded" : "ready",
      summary:
        dashboardReachable === false
          ? "dashboard health failed"
          : "dashboard available or not checked",
      actionIds: actionIdsFor("dashboard-proof"),
    },
    {
      id: "future-candidates",
      title: "Future candidate intake",
      status: "ready",
      summary: "new families/products onboard to Chuck first, then OpenClaw",
      actionIds: actionIdsFor("future-candidate-intake"),
    },
  ];
}

function docketItemsForOnboarding(report: ChuckOnboardingReport): DocketItem[] {
  const doctorItems = docketItemsForModelDoctor(report.doctor);
  const actionItems = report.actions
    .filter((action) => action.kind !== "prove-surface" && action.kind !== "repair-surface")
    .filter((action) => action.risk !== "auto-safe")
    .map(
      (action): DocketItem => ({
        docketId: `docket-onboard-${action.id}`,
        runId: report.runId,
        createdAt: report.generatedAt,
        updatedAt: report.generatedAt,
        status: action.risk === "approval-required" ? "needs-approval" : "needs-setup",
        title: action.title,
        stakeClass: action.risk === "blocked" ? "high-readonly" : "medium",
        taskClass: "unknown",
        finalAction: "operator-halt",
        operatorActionRequired: action.risk !== "auto-safe",
        reasons: action.reasons,
      }),
    );
  return [...doctorItems, ...actionItems];
}

function docketItemsForCandidate(record: CandidateOnboardingRecord): DocketItem[] {
  return record.actions.map(
    (action): DocketItem => ({
      docketId: `docket-${action.id}`,
      runId: record.candidateId,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      status: action.risk === "approval-required" ? "needs-approval" : "needs-setup",
      title: action.title,
      stakeClass: action.kind === "candidate-proof" ? "high-readonly" : "medium",
      taskClass: "unknown",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      reasons: action.reasons,
    }),
  );
}

function onboardingReadinessScore(stages: OnboardingStage[]): number {
  const values: number[] = stages.map((stage) =>
    stage.status === "ready" ? 1 : stage.status === "degraded" ? 0.5 : 0,
  );
  return Math.round(
    (values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)) * 100,
  );
}

function dedupeActions(actions: OnboardingAction[]): OnboardingAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.id)) {
      return false;
    }
    seen.add(action.id);
    return true;
  });
}

function sanitizeActionId(value: string): string {
  return value
    .replaceAll(/[^a-z0-9]+/gi, "-")
    .replaceAll(/^-|-$/g, "")
    .toLowerCase();
}

function normalizeCandidateFamily(value: string): ChuckFamily {
  const normalized = value.trim().toLowerCase();
  if (/(anthropic|claude)/.test(normalized)) {
    return "anthropic";
  }
  if (/(openai|chatgpt|codex)/.test(normalized)) {
    return "openai";
  }
  if (/(google|gemini|vertex)/.test(normalized)) {
    return "google";
  }
  if (normalized.includes("perplexity")) {
    return "perplexity";
  }
  if (/(xai|grok)/.test(normalized)) {
    return "xai";
  }
  if (/(ollama|local|llama|qwen-local|deepseek-local)/.test(normalized)) {
    return "sovereign-local";
  }
  return "unknown";
}

function candidateReasons({
  classification,
  proposedFamily,
  cleanFamilyOrProduct,
  cleanSurface,
}: {
  classification: CandidateClassification;
  proposedFamily: ChuckFamily;
  cleanFamilyOrProduct: string;
  cleanSurface: string;
}): string[] {
  if (classification === "configured-surface") {
    return [
      `${cleanSurface} is already present in Chuck's configured Fleet; onboarding records a proof/calibration refresh request.`,
      "Configured surfaces still need current receipts before load-bearing use.",
    ];
  }
  if (classification === "existing-family-new-surface") {
    return [
      `${cleanFamilyOrProduct} maps to existing family ${proposedFamily}.`,
      "Same-family surfaces are useful, but never add another independent family vote.",
      "The surface must prove attribution, quota posture, and reliability before Chuck exposes it through OpenClaw.",
    ];
  }
  return [
    `${cleanFamilyOrProduct} is not one of Chuck's current typed families.`,
    "New companies/products remain provisional until the Surface Registry, runner receipts, and Phase 0 calibration prove they deserve promotion.",
    "Unknown candidates do not touch OpenClaw execution until Chuck has a safe adapter and explicit gates.",
  ];
}

function candidatePromotionGates({
  classification,
}: {
  classification: CandidateClassification;
}): string[] {
  const common = [
    "surface metadata includes rationale, commercial policy, quota policy, capability profile, and auth/session boundary",
    "signed runner/orchestrator receipts prove actual family attribution; model self-report is ignored",
    "two harmless probe successes from separate sessions without PAYG dependency unless explicitly approved",
    "Phase 0 calibration records task-class reliability, disagreement behavior, latency, quota, and operator-attention cost",
    "prompt-injection and account-surface safety checks pass before OpenClaw tool exposure",
  ];
  if (classification === "existing-family-new-surface") {
    return [
      ...common,
      "surface remains intra-family signal only; it never increases independent family count",
    ];
  }
  if (classification === "configured-surface") {
    return [...common, "configured surface is refreshed rather than duplicated in the registry"];
  }
  return [
    "operator approves adding a new typed family or keeping the candidate as unknown/provisional",
    ...common,
    "family is distinct from existing families before it can count independently",
  ];
}

function candidateOnboardingActions({
  candidateId,
  family,
  familyOrProduct,
  surface,
  classification,
  requiredPromotionGates,
}: {
  candidateId: string;
  family: ChuckFamily;
  familyOrProduct: string;
  surface: string;
  classification: CandidateClassification;
  requiredPromotionGates: string[];
}): OnboardingAction[] {
  const prefix = sanitizeActionId(candidateId);
  return [
    {
      id: `${prefix}-registry`,
      kind: "candidate-registry",
      title: `Register candidate surface ${familyOrProduct} via ${surface}`,
      risk: classification === "new-family-candidate" ? "approval-required" : "operator-action",
      family,
      surface,
      reasons: [
        "Chuck owns candidate intake before OpenClaw exposure.",
        classification === "existing-family-new-surface"
          ? "same-family surface must remain intra-family signal"
          : "new family/product must remain provisional until promotion gates pass",
      ],
      next: "create a Surface Registry proposal with rationale, auth boundary, quota policy, capability profile, and no PAYG dependency",
      autoRepairAvailable: false,
    },
    {
      id: `${prefix}-receipt-proof`,
      kind: "candidate-proof",
      title: `Prove runner receipts for ${surface}`,
      risk: "operator-action",
      family,
      surface,
      reasons: [
        "candidate cannot count from model self-report",
        "orchestrator-signed transcript hashes are required",
      ],
      next: "run two harmless probes from separate sessions and persist signed RunnerReceipts",
      autoRepairAvailable: false,
    },
    {
      id: `${prefix}-phase0`,
      kind: "candidate-calibration",
      title: `Calibrate ${familyOrProduct} before promotion`,
      risk: "operator-action",
      family,
      surface,
      reasons: requiredPromotionGates.slice(0, 4),
      next: "run Phase 0 task-class evals and compare against current Fleet trace metrics",
      autoRepairAvailable: false,
    },
  ];
}
