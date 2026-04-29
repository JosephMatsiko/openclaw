import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHUCK_V2_STATE_DIR, configWithSafeCliScoutSurfaces } from "./config.js";
import {
  loadRunnerSurfaceProofs,
  runModelDoctor,
  type ModelDoctorReport,
  type RunnerSurfaceProof,
} from "./model-doctor.js";
import {
  surfaceAtlasSummary,
  type SurfaceAtlasEntry,
  type SurfaceAtlasFamily,
  type SurfaceAtlasSummary,
} from "./surface-atlas.js";
import type {
  ChuckConfig,
  ChuckFamily,
  MachineResourceSnapshot,
  StakeClass,
  TaskClass,
  WorkerHealthSnapshot,
} from "./types.js";

export type CapabilityAuthorityMode =
  | "read-only"
  | "can-draft"
  | "can-act-with-policy"
  | "requires-approval";
export type CapabilityReadiness = "load-bearing" | "provisional" | "degraded" | "blocked";
export type CapabilityConfidence = "none" | "low" | "medium" | "high";
export type CapabilityQuotaClass = "unknown" | "scarce" | "normal" | "local";
export type CapabilitySovereigntyLevel =
  | "local"
  | "subscription"
  | "connector"
  | "external"
  | "unknown";
export type CapabilityRevocationState = "active" | "revoked" | "not-proven";
export type SurfaceProofVerdict = "proved" | "missing" | "failed";
export type SurfaceExtractionMethod =
  | "http-json"
  | "cli-stdout"
  | "driver-json"
  | "app-driver-text"
  | "pwa-ocr"
  | "ocr-recovery"
  | "legacy-runner-receipt"
  | "connector"
  | "external"
  | "unknown";

export type SurfaceProofRecord = {
  verdict: SurfaceProofVerdict;
  method: string;
  evidence: string;
  caveats: string[];
  checkedAt?: string;
};

export type SurfaceProofDetail = {
  surface: string;
  family: SurfaceAtlasFamily;
  promptDeliveryProof: SurfaceProofRecord;
  answerAttributionProof: SurfaceProofRecord;
  extractionMethod: SurfaceExtractionMethod;
  receiptSignature?: string;
  receiptEndedAt?: string;
  proofModel: "split" | "legacy";
};

export type LateSurfaceRecovery = {
  surface: string;
  family: ChuckFamily;
  status: "recovered-late";
  label: string;
  caveat: string;
  updatedAt: string;
  evidence: Array<{
    name: string;
    path: string;
    updatedAt: string;
    sizeBytes: number;
  }>;
};

export type CapabilityLedgerEntry = {
  surface: string;
  family: SurfaceAtlasFamily | ChuckFamily;
  taskClasses: TaskClass[];
  authorityMode: CapabilityAuthorityMode;
  readiness: CapabilityReadiness;
  confidence: CapabilityConfidence;
  lastReceiptId?: string;
  lastProofAt?: string;
  failureMode?: string;
  quotaClass: CapabilityQuotaClass;
  sovereigntyLevel: CapabilitySovereigntyLevel;
  revocationState: CapabilityRevocationState;
  countsAsIndependentFamily: boolean;
  canCountForFamily: boolean;
  promptDeliveryProof: SurfaceProofRecord;
  answerAttributionProof: SurfaceProofRecord;
  extractionMethod: SurfaceExtractionMethod;
  nextRepairAction: string;
  caveats: string[];
};

export type CapabilityLedger = {
  generatedAt: string;
  entries: CapabilityLedgerEntry[];
  summary: CapabilityLedgerSummary;
};

export type CapabilityLedgerSummary = {
  totalSurfaces: number;
  loadBearingSurfaces: number;
  provisionalSurfaces: number;
  degradedSurfaces: number;
  blockedSurfaces: number;
  independentLoadBearingFamilies: ChuckFamily[];
  independentLoadBearingFamilyCount: number;
  fullCapacityFamilies: ChuckFamily[];
  partialCapacityFamilies: ChuckFamily[];
  blockedCapacityFamilies: ChuckFamily[];
  capacityScore: number;
  familyCapacity: Array<{
    family: string;
    status: "full" | "partial" | "blocked";
    loadBearing: number;
    provisional: number;
    degraded: number;
    blocked: number;
    bottlenecks: string[];
  }>;
  readinessByFamily: Array<{
    family: string;
    loadBearing: number;
    provisional: number;
    degraded: number;
    blocked: number;
  }>;
};

export type CapabilityRelianceVerdict = {
  allowed: boolean;
  reasons: string[];
};

export type BuildCapabilityLedgerInput = {
  config?: ChuckConfig;
  atlas?: SurfaceAtlasSummary;
  doctor?: ModelDoctorReport;
  executionProofs?: Record<string, RunnerSurfaceProof>;
  proofDetails?: Record<string, SurfaceProofDetail>;
  lateRecoveries?: LateSurfaceRecovery[];
  resources?: MachineResourceSnapshot;
  generatedAt?: string;
};

export function buildCapabilityLedger({
  config = configWithSafeCliScoutSurfaces(),
  atlas = surfaceAtlasSummary({ config }),
  executionProofs = {},
  doctor = runModelDoctor({ config, executionProofs }),
  proofDetails = {},
  lateRecoveries = [],
  resources,
  generatedAt = new Date().toISOString(),
}: BuildCapabilityLedgerInput = {}): CapabilityLedger {
  const doctorBySurface = new Map(doctor.rows.map((row) => [row.surface, row]));
  const configBySurface = new Map(config.fleet.map((entry) => [entry.surface, entry]));
  const lateBySurface = new Map(lateRecoveries.map((recovery) => [recovery.surface, recovery]));
  const entries = atlas.entries.map((atlasEntry) =>
    ledgerEntryForSurface(atlasEntry.surface, {
      atlasEntry,
      configEntry: configBySurface.get(atlasEntry.surface),
      doctorRow: doctorBySurface.get(atlasEntry.surface),
      executionProof: executionProofs[atlasEntry.surface],
      proofDetail: proofDetails[atlasEntry.surface],
      lateRecovery: lateBySurface.get(atlasEntry.surface),
      resources,
    }),
  );
  const countedEntries = assignIndependentFamilyCounts(entries, config);
  return {
    generatedAt,
    entries: countedEntries,
    summary: readinessBoardSummary({ generatedAt, entries: countedEntries }),
  };
}

export function ledgerEntryForSurface(
  surface: string,
  {
    atlasEntry,
    configEntry,
    doctorRow,
    executionProof,
    proofDetail,
    lateRecovery,
    resources,
  }: {
    atlasEntry?: SurfaceAtlasEntry;
    configEntry?: ChuckConfig["fleet"][number];
    doctorRow?: ModelDoctorReport["rows"][number];
    executionProof?: RunnerSurfaceProof;
    proofDetail?: SurfaceProofDetail;
    lateRecovery?: LateSurfaceRecovery;
    resources?: MachineResourceSnapshot;
  },
): CapabilityLedgerEntry {
  const family = atlasEntry?.family ?? configEntry?.family ?? doctorRow?.family ?? "unknown";
  const quotaClass = (configEntry?.quotaPolicy ??
    (family === "sovereign-local" ? "local" : "unknown")) as CapabilityQuotaClass;
  const activeLateRecovery =
    lateRecovery && !hasNewerSplitProof(proofDetail, lateRecovery) ? lateRecovery : undefined;
  const promptDeliveryProof =
    proofDetail?.promptDeliveryProof ?? legacyPromptProof(executionProof, activeLateRecovery);
  const answerAttributionProof =
    proofDetail?.answerAttributionProof ?? legacyAnswerProof(executionProof, activeLateRecovery);
  const extractionMethod = activeLateRecovery
    ? lateRecoveryExtractionMethod(activeLateRecovery)
    : (proofDetail?.extractionMethod ?? (executionProof ? "legacy-runner-receipt" : "unknown"));
  const caveats = [
    ...(promptDeliveryProof.caveats ?? []),
    ...(answerAttributionProof.caveats ?? []),
    ...(activeLateRecovery ? [activeLateRecovery.caveat] : []),
    ...(resources?.memoryPressure === "warning"
      ? ["machine memory warning; stagger GUI/app surfaces"]
      : []),
    ...(resources?.memoryPressure === "critical"
      ? ["critical memory pressure; only trivial work should run"]
      : []),
    ...(doctorRow?.status === "blocked" ? [doctorRow.healthReason] : []),
  ].filter(Boolean);
  const failureMode = activeLateRecovery
    ? activeLateRecovery.label
    : executionProof?.latestStatus === "failed"
      ? (executionProof.lastFailureReason ?? "latest proof failed")
      : proofDetail?.proofModel === "split" &&
          (promptDeliveryProof.verdict === "failed" || answerAttributionProof.verdict === "failed")
        ? (answerAttributionProof.evidence ?? promptDeliveryProof.evidence ?? "split proof failed")
        : doctorRow?.status === "blocked"
          ? doctorRow.healthReason
          : undefined;
  const readiness = readinessForSurface({
    atlasEntry,
    doctorRow,
    executionProof,
    proofDetail,
    lateRecovery: activeLateRecovery,
    promptDeliveryProof,
    answerAttributionProof,
    resources,
  });
  return {
    surface,
    family,
    taskClasses: taskClassesForSurface({ atlasEntry, configEntry }),
    authorityMode: authorityModeForSurface(atlasEntry),
    readiness,
    confidence: confidenceForReadiness(readiness, proofDetail, executionProof),
    lastReceiptId: proofDetail?.receiptSignature?.slice(0, 16),
    lastProofAt:
      proofDetail?.receiptEndedAt ??
      executionProof?.lastSuccessAt ??
      executionProof?.lastFailureAt ??
      activeLateRecovery?.updatedAt,
    failureMode,
    quotaClass,
    sovereigntyLevel: sovereigntyLevelForSurface({ family, atlasEntry, configEntry }),
    revocationState: readiness === "blocked" ? "not-proven" : "active",
    countsAsIndependentFamily: false,
    canCountForFamily: readiness === "load-bearing" && isChuckFamily(family),
    promptDeliveryProof,
    answerAttributionProof,
    extractionMethod,
    nextRepairAction: nextRepairActionForSurface({
      surface,
      readiness,
      doctorRow,
      lateRecovery: activeLateRecovery,
      proofDetail,
      executionProof,
    }),
    caveats: [...new Set(caveats)],
  };
}

export function canKernelRelyOn(
  entry: CapabilityLedgerEntry,
  taskClass: TaskClass,
  stakeClass: StakeClass,
): CapabilityRelianceVerdict {
  const reasons: string[] = [];
  if (entry.readiness === "blocked") {
    reasons.push(`${entry.surface} is blocked`);
  }
  if (
    (stakeClass === "high-mutating" || stakeClass === "destructive") &&
    entry.readiness !== "load-bearing"
  ) {
    reasons.push(`${stakeClass} requires load-bearing surface proof`);
  }
  if (stakeClass === "destructive") {
    reasons.push(
      "destructive work still requires explicit operator approval even on load-bearing surfaces",
    );
  }
  if (!entry.taskClasses.includes(taskClass) && taskClass !== "unknown") {
    reasons.push(`${entry.surface} is not calibrated for ${taskClass}`);
  }
  if (entry.revocationState !== "active") {
    reasons.push(`${entry.surface} is not active`);
  }
  return {
    allowed: reasons.length === 0 && entry.readiness !== "blocked",
    reasons,
  };
}

export function readinessBoardSummary(
  ledger: Pick<CapabilityLedger, "entries"> & { generatedAt?: string },
): CapabilityLedgerSummary {
  const byFamily = new Map<
    string,
    { family: string; loadBearing: number; provisional: number; degraded: number; blocked: number }
  >();
  for (const entry of ledger.entries) {
    const row = byFamily.get(entry.family) ?? {
      family: entry.family,
      loadBearing: 0,
      provisional: 0,
      degraded: 0,
      blocked: 0,
    };
    if (entry.readiness === "load-bearing") {
      row.loadBearing += 1;
    } else if (entry.readiness === "provisional") {
      row.provisional += 1;
    } else if (entry.readiness === "degraded") {
      row.degraded += 1;
    } else {
      row.blocked += 1;
    }
    byFamily.set(row.family, row);
  }
  const independentLoadBearingFamilies = ledger.entries
    .filter((entry) => entry.countsAsIndependentFamily && isChuckFamily(entry.family))
    .map((entry) => entry.family as ChuckFamily);
  const familyCapacity = [...byFamily.values()]
    .map((row) => {
      const familyEntries = ledger.entries.filter((entry) => entry.family === row.family);
      const bottlenecks = familyEntries
        .filter((entry) => entry.readiness !== "load-bearing")
        .map((entry) => `${entry.surface}: ${entry.readiness}`);
      const status: "blocked" | "full" | "partial" =
        row.loadBearing === 0
          ? "blocked"
          : row.provisional + row.degraded + row.blocked === 0
            ? "full"
            : "partial";
      return {
        family: row.family,
        status,
        loadBearing: row.loadBearing,
        provisional: row.provisional,
        degraded: row.degraded,
        blocked: row.blocked,
        bottlenecks,
      };
    })
    .toSorted((a, b) => a.family.localeCompare(b.family));
  const chuckFamilyCapacity = familyCapacity.filter((row) => isChuckFamily(row.family));
  const fullCapacityFamilies = chuckFamilyCapacity
    .filter((row) => row.status === "full")
    .map((row) => row.family as ChuckFamily);
  const partialCapacityFamilies = chuckFamilyCapacity
    .filter((row) => row.status === "partial")
    .map((row) => row.family as ChuckFamily);
  const blockedCapacityFamilies = chuckFamilyCapacity
    .filter((row) => row.status === "blocked")
    .map((row) => row.family as ChuckFamily);
  const capacityScore =
    chuckFamilyCapacity.length === 0
      ? 0
      : Math.round(
          (chuckFamilyCapacity.reduce((sum, row) => {
            const total = row.loadBearing + row.provisional + row.degraded + row.blocked;
            return sum + (total === 0 ? 0 : row.loadBearing / total);
          }, 0) /
            chuckFamilyCapacity.length) *
            100,
        );
  return {
    totalSurfaces: ledger.entries.length,
    loadBearingSurfaces: ledger.entries.filter((entry) => entry.readiness === "load-bearing")
      .length,
    provisionalSurfaces: ledger.entries.filter((entry) => entry.readiness === "provisional").length,
    degradedSurfaces: ledger.entries.filter((entry) => entry.readiness === "degraded").length,
    blockedSurfaces: ledger.entries.filter((entry) => entry.readiness === "blocked").length,
    independentLoadBearingFamilies,
    independentLoadBearingFamilyCount: independentLoadBearingFamilies.length,
    fullCapacityFamilies,
    partialCapacityFamilies,
    blockedCapacityFamilies,
    capacityScore,
    familyCapacity,
    readinessByFamily: [...byFamily.values()].toSorted((a, b) => a.family.localeCompare(b.family)),
  };
}

export function buildCapabilityLedgerForState({
  stateDir = CHUCK_V2_STATE_DIR,
  config = configWithSafeCliScoutSurfaces(),
  doctor: providedDoctor,
  executionProofs: providedExecutionProofs,
  health,
  generatedAt = new Date().toISOString(),
  resources,
}: {
  stateDir?: string;
  config?: ChuckConfig;
  doctor?: ModelDoctorReport;
  executionProofs?: Record<string, RunnerSurfaceProof>;
  health?: WorkerHealthSnapshot;
  generatedAt?: string;
  resources?: MachineResourceSnapshot;
} = {}): CapabilityLedger {
  const executionProofs = providedExecutionProofs ?? loadRunnerSurfaceProofs({ stateDir });
  const proofDetails = loadSurfaceProofDetails({ stateDir });
  const doctor =
    providedDoctor ?? runModelDoctor({ config, stateDir, executionProofs, health, generatedAt });
  return buildCapabilityLedger({
    config,
    doctor,
    executionProofs,
    proofDetails,
    lateRecoveries: loadLateSurfaceRecoveries({ stateDir }),
    resources,
    generatedAt,
  });
}

export function loadSurfaceProofDetails({
  stateDir = CHUCK_V2_STATE_DIR,
}: {
  stateDir?: string;
} = {}): Record<string, SurfaceProofDetail> {
  const dir = join(stateDir, "runner-executions");
  const details = new Map<string, SurfaceProofDetail>();
  loadManualSurfaceProofDetails({ stateDir, details });
  if (!existsSync(dir)) {
    return Object.fromEntries(details);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(dir, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file.path, "utf8")) as unknown;
    } catch {
      continue;
    }
    const executions = Array.isArray((parsed as { executions?: unknown }).executions)
      ? (parsed as { executions: unknown[] }).executions
      : [];
    for (const raw of executions) {
      const item = raw as {
        family?: ChuckFamily;
        surface?: string;
        status?: string;
        receipt?: { runnerSignature?: string; endedAt?: string };
        promptDeliveryProof?: SurfaceProofRecord;
        answerAttributionProof?: SurfaceProofRecord;
        extractionMethod?: SurfaceExtractionMethod;
      };
      if (!item.surface || !item.family || item.status !== "completed") {
        continue;
      }
      const hasSplitProof = Boolean(item.promptDeliveryProof && item.answerAttributionProof);
      details.set(item.surface, {
        surface: item.surface,
        family: item.family,
        promptDeliveryProof:
          item.promptDeliveryProof ??
          provedProof("legacy-runner-receipt", "completed runner receipt", [
            "legacy proof inferred before prompt-delivery split",
          ]),
        answerAttributionProof:
          item.answerAttributionProof ??
          provedProof("legacy-runner-receipt", "completed runner receipt", [
            "legacy proof inferred before answer-attribution split",
          ]),
        extractionMethod: item.extractionMethod ?? "legacy-runner-receipt",
        receiptSignature: item.receipt?.runnerSignature,
        receiptEndedAt: item.receipt?.endedAt,
        proofModel: hasSplitProof ? "split" : "legacy",
      });
    }
  }
  return Object.fromEntries(details);
}

function loadManualSurfaceProofDetails({
  stateDir,
  details,
}: {
  stateDir: string;
  details: Map<string, SurfaceProofDetail>;
}) {
  const manualDir = join(stateDir, "surface-proof-details");
  if (!existsSync(manualDir)) {
    return;
  }
  const files = readdirSync(manualDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(manualDir, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file.path, "utf8")) as unknown;
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { proofDetails?: unknown }).proofDetails)
        ? (parsed as { proofDetails: unknown[] }).proofDetails
        : [parsed];
    for (const candidate of candidates) {
      if (isSurfaceProofDetail(candidate)) {
        details.set(candidate.surface, candidate);
      }
    }
  }
}

function isSurfaceProofDetail(value: unknown): value is SurfaceProofDetail {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proof = value as Partial<SurfaceProofDetail>;
  return (
    typeof proof.surface === "string" &&
    typeof proof.family === "string" &&
    isSurfaceProofRecord(proof.promptDeliveryProof) &&
    isSurfaceProofRecord(proof.answerAttributionProof) &&
    isSurfaceExtractionMethod(proof.extractionMethod) &&
    (proof.proofModel === "split" || proof.proofModel === "legacy")
  );
}

function isSurfaceProofRecord(value: unknown): value is SurfaceProofRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proof = value as Partial<SurfaceProofRecord>;
  return (
    (proof.verdict === "proved" || proof.verdict === "missing" || proof.verdict === "failed") &&
    typeof proof.method === "string" &&
    typeof proof.evidence === "string"
  );
}

function isSurfaceExtractionMethod(value: unknown): value is SurfaceExtractionMethod {
  return (
    value === "http-json" ||
    value === "cli-stdout" ||
    value === "driver-json" ||
    value === "app-driver-text" ||
    value === "pwa-ocr" ||
    value === "ocr-recovery" ||
    value === "legacy-runner-receipt" ||
    value === "connector" ||
    value === "external" ||
    value === "unknown"
  );
}

export function loadLateSurfaceRecoveries({
  stateDir = CHUCK_V2_STATE_DIR,
}: {
  stateDir?: string;
} = {}): LateSurfaceRecovery[] {
  const dir = join(stateDir, "stuck-surface-contributions");
  if (!existsSync(dir)) {
    return [];
  }
  const files = readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      return stat.isFile() ? { name, path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size } : null;
    })
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  const recoveries: LateSurfaceRecovery[] = [];
  const add = (
    surface: string,
    family: ChuckFamily,
    patterns: RegExp[],
    label: string,
    caveat: string,
  ) => {
    const matches = patterns
      .flatMap((pattern) => files.filter((file) => pattern.test(file.name)))
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    if (matches.length === 0) {
      return;
    }
    const evidence = matches.slice(0, 6).map((file) => ({
      name: file.name,
      path: file.path,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      sizeBytes: file.sizeBytes,
    }));
    recoveries.push({
      surface,
      family,
      status: "recovered-late",
      label,
      caveat,
      updatedAt: evidence[0]?.updatedAt ?? new Date().toISOString(),
      evidence,
    });
  };
  add(
    "chatgpt/web-chat",
    "openai",
    [/^chatgpt-20260428-retry\.json$/, /^20260428-perplexity-aistudio-synthesis\.md$/],
    "ChatGPT web rerun captured",
    "late recovery after original Deepen timeout; requires normal repeatable proof before load-bearing use",
  );
  add(
    "aistudio/web",
    "google",
    [
      /^aistudio-20260428-retry\.json$/,
      /^aistudio-20260428-contribution\.json$/,
      /^20260428-perplexity-aistudio-synthesis\.md$/,
    ],
    "AI Studio rerun captured",
    "late recovery after original Deepen timeout; entitlement and Run-button proof remain required",
  );
  add(
    "perplexity/mac-app",
    "perplexity",
    [
      /^perplexity-20260428-live-proof\.json$/,
      /^perplexity-20260428-page-\d+\.json$/,
      /^perplexity-20260428-ocr-contribution-full\.txt$/,
      /^20260428-perplexity-aistudio-synthesis\.md$/,
    ],
    "Perplexity Scout-missed contribution captured by live OCR/proof",
    "OCR-only late recovery after Scout miss; direct answer extraction remains required",
  );
  return recoveries.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function formatCapabilityLedgerReport(
  ledger: CapabilityLedger,
  { limit = 18 }: { limit?: number } = {},
): string {
  const lines = [
    "Chuck Fleet Readiness Board",
    `Surfaces: ${ledger.summary.totalSurfaces}; load-bearing ${ledger.summary.loadBearingSurfaces}; provisional ${ledger.summary.provisionalSurfaces}; degraded ${ledger.summary.degradedSurfaces}; blocked ${ledger.summary.blockedSurfaces}.`,
    `Independent load-bearing families: ${ledger.summary.independentLoadBearingFamilies.join(", ") || "none"}`,
    "",
  ];
  for (const entry of ledger.entries.slice(0, limit)) {
    lines.push(
      `- ${entry.family} · ${entry.surface} · ${entry.readiness}${entry.countsAsIndependentFamily ? " · family-count" : ""}`,
      `  proof: prompt=${entry.promptDeliveryProof.verdict}; answer=${entry.answerAttributionProof.verdict}; extraction=${entry.extractionMethod}`,
      `  next: ${entry.nextRepairAction}`,
    );
    if (entry.caveats.length > 0) {
      lines.push(`  caveats: ${entry.caveats.slice(0, 3).join("; ")}`);
    }
  }
  return lines.join("\n");
}

function readinessForSurface({
  atlasEntry,
  doctorRow,
  executionProof,
  proofDetail,
  lateRecovery,
  promptDeliveryProof,
  answerAttributionProof,
  resources,
}: {
  atlasEntry?: SurfaceAtlasEntry;
  doctorRow?: ModelDoctorReport["rows"][number];
  executionProof?: RunnerSurfaceProof;
  proofDetail?: SurfaceProofDetail;
  lateRecovery?: LateSurfaceRecovery;
  promptDeliveryProof: SurfaceProofRecord;
  answerAttributionProof: SurfaceProofRecord;
  resources?: MachineResourceSnapshot;
}): CapabilityReadiness {
  if (resources?.memoryPressure === "critical") {
    return "blocked";
  }
  if (doctorRow?.status === "blocked") {
    return "blocked";
  }
  if (atlasEntry?.surface === "ollama/localhost" && doctorRow?.status !== "ready") {
    return executionProof?.successes ? "provisional" : "blocked";
  }
  if (lateRecovery) {
    return "degraded";
  }
  if (executionProof?.latestStatus === "failed" && executionProof.successes === 0) {
    return "blocked";
  }
  if (executionProof?.latestStatus === "failed") {
    return "degraded";
  }
  if (
    proofDetail?.proofModel === "split" &&
    (promptDeliveryProof.verdict === "failed" || answerAttributionProof.verdict === "failed")
  ) {
    return "blocked";
  }
  const promptOk = promptDeliveryProof.verdict === "proved";
  const answerOk = answerAttributionProof.verdict === "proved";
  if (
    promptOk &&
    answerOk &&
    proofDetail?.proofModel === "split" &&
    (executionProof?.latestStatus === "completed" || isConnectorOrToolSurface(atlasEntry)) &&
    proofDetail.extractionMethod !== "unknown"
  ) {
    return "load-bearing";
  }
  if (
    promptOk &&
    answerOk &&
    proofDetail?.proofModel === "legacy" &&
    isCliLikeSurface(atlasEntry) &&
    executionProof?.repeatable
  ) {
    return "load-bearing";
  }
  if (executionProof && executionProof.successes > 0) {
    return "provisional";
  }
  if (
    doctorRow?.status === "ready" ||
    atlasEntry?.status === "configured" ||
    atlasEntry?.status === "available-tool"
  ) {
    return "provisional";
  }
  return "blocked";
}

function isConnectorOrToolSurface(atlasEntry?: SurfaceAtlasEntry): boolean {
  return (
    atlasEntry?.category === "connector" ||
    atlasEntry?.category === "tool-surface" ||
    atlasEntry?.category === "local-runtime"
  );
}

function assignIndependentFamilyCounts(
  entries: CapabilityLedgerEntry[],
  config: ChuckConfig,
): CapabilityLedgerEntry[] {
  const configOrder = new Map(config.fleet.map((entry, index) => [entry.surface, index]));
  const winners = new Set<string>();
  const eligible = entries
    .filter((entry) => entry.canCountForFamily && isChuckFamily(entry.family))
    .toSorted((a, b) => (configOrder.get(a.surface) ?? 999) - (configOrder.get(b.surface) ?? 999));
  for (const entry of eligible) {
    const family = entry.family as ChuckFamily;
    if (!winners.has(family)) {
      winners.add(family);
    }
  }
  const counted = new Set<ChuckFamily>();
  return entries.map((entry) => {
    const family = entry.family;
    const counts =
      entry.canCountForFamily &&
      isChuckFamily(family) &&
      winners.has(family) &&
      !counted.has(family);
    if (counts && isChuckFamily(family)) {
      counted.add(family);
    }
    return { ...entry, countsAsIndependentFamily: counts };
  });
}

function taskClassesForSurface({
  atlasEntry,
  configEntry,
}: {
  atlasEntry?: SurfaceAtlasEntry;
  configEntry?: ChuckConfig["fleet"][number];
}): TaskClass[] {
  if (configEntry?.capabilityProfile === "code-grounded") {
    return ["code-review", "code-mutation", "architecture"];
  }
  if (
    configEntry?.capabilityProfile === "live-research" ||
    configEntry?.capabilityProfile === "meta-router"
  ) {
    return ["factual", "summary", "architecture"];
  }
  if (configEntry?.capabilityProfile === "sovereign-local") {
    return ["summary", "code-review", "architecture", "unknown"];
  }
  if (atlasEntry?.category === "connector") {
    return ["factual", "summary"];
  }
  return ["factual", "summary", "code-review", "code-mutation", "architecture", "unknown"];
}

function authorityModeForSurface(atlasEntry?: SurfaceAtlasEntry): CapabilityAuthorityMode {
  const authorities = new Set(atlasEntry?.abilities.map((ability) => ability.authority) ?? []);
  if (authorities.has("requires-approval")) {
    return "requires-approval";
  }
  if (authorities.has("can-act-with-policy")) {
    return "can-act-with-policy";
  }
  if (authorities.has("can-draft")) {
    return "can-draft";
  }
  return "read-only";
}

function confidenceForReadiness(
  readiness: CapabilityReadiness,
  proofDetail?: SurfaceProofDetail,
  executionProof?: RunnerSurfaceProof,
): CapabilityConfidence {
  if (readiness === "blocked") {
    return "none";
  }
  if (readiness === "load-bearing" && proofDetail?.proofModel === "split") {
    return "high";
  }
  if (readiness === "load-bearing") {
    return "medium";
  }
  if (executionProof?.successes) {
    return "medium";
  }
  return "low";
}

function sovereigntyLevelForSurface({
  family,
  atlasEntry,
  configEntry,
}: {
  family: SurfaceAtlasFamily | ChuckFamily;
  atlasEntry?: SurfaceAtlasEntry;
  configEntry?: ChuckConfig["fleet"][number];
}): CapabilitySovereigntyLevel {
  if (family === "sovereign-local" || configEntry?.commercialPolicy === "local-only") {
    return "local";
  }
  if (atlasEntry?.category === "connector") {
    return "connector";
  }
  if (configEntry?.commercialPolicy === "subscription-only") {
    return "subscription";
  }
  if (atlasEntry?.category === "tool-surface") {
    return "local";
  }
  return "unknown";
}

function nextRepairActionForSurface({
  surface,
  readiness,
  doctorRow,
  lateRecovery,
  proofDetail,
  executionProof,
}: {
  surface: string;
  readiness: CapabilityReadiness;
  doctorRow?: ModelDoctorReport["rows"][number];
  lateRecovery?: LateSurfaceRecovery;
  proofDetail?: SurfaceProofDetail;
  executionProof?: RunnerSurfaceProof;
}): string {
  if (readiness === "load-bearing") {
    return "Keep drift probes current; route by task class and quota.";
  }
  if (readiness === "blocked" && doctorRow?.status === "blocked") {
    return doctorRow.nextAction;
  }
  if (lateRecovery?.surface === "perplexity/mac-app") {
    return "Repair Perplexity direct answer extraction; OCR recovery is not load-bearing.";
  }
  if (lateRecovery) {
    return "Rerun normal surface proof until prompt-delivery and answer-attribution are repeatable.";
  }
  if (!proofDetail || proofDetail.proofModel !== "split") {
    return (
      "Run /chuck onboard prove " +
      surface +
      " to capture split prompt-delivery and answer-attribution proof."
    );
  }
  if (
    proofDetail.promptDeliveryProof.verdict === "failed" ||
    proofDetail.answerAttributionProof.verdict === "failed"
  ) {
    return `Repair failed split proof for ${surface}: ${
      proofDetail.answerAttributionProof.evidence || proofDetail.promptDeliveryProof.evidence
    }`;
  }
  if (executionProof?.latestStatus === "failed") {
    return executionProof.lastFailureReason ?? "Repair latest failed surface proof.";
  }
  return doctorRow?.nextAction ?? "Create a signed runner proof before load-bearing use.";
}

function legacyPromptProof(
  proof?: RunnerSurfaceProof,
  lateRecovery?: LateSurfaceRecovery,
): SurfaceProofRecord {
  if (lateRecovery) {
    return provedProof("late-recovery-artifact", lateRecovery.label, [
      "late recovery; not canonical prompt-delivery proof",
    ]);
  }
  if (proof?.successes) {
    return provedProof("legacy-runner-receipt", `${proof.successes} successful runner receipt(s)`, [
      "legacy proof inferred before prompt-delivery split",
    ]);
  }
  if (proof?.latestStatus === "failed") {
    return failedProof("legacy-runner-receipt", proof.lastFailureReason ?? "latest proof failed");
  }
  return missingProof("none", "no prompt-delivery proof recorded");
}

function legacyAnswerProof(
  proof?: RunnerSurfaceProof,
  lateRecovery?: LateSurfaceRecovery,
): SurfaceProofRecord {
  if (lateRecovery) {
    const ocr = /ocr/i.test(lateRecovery.caveat) || lateRecovery.surface === "perplexity/mac-app";
    return provedProof(ocr ? "ocr-recovery" : "late-recovery-artifact", lateRecovery.label, [
      lateRecovery.caveat,
    ]);
  }
  if (proof?.successes) {
    return provedProof("legacy-runner-receipt", `${proof.successes} successful runner receipt(s)`, [
      "legacy proof inferred before answer-attribution split",
    ]);
  }
  if (proof?.latestStatus === "failed") {
    return failedProof("legacy-runner-receipt", proof.lastFailureReason ?? "latest proof failed");
  }
  return missingProof("none", "no answer-attribution proof recorded");
}

function hasNewerSplitProof(
  proofDetail: SurfaceProofDetail | undefined,
  lateRecovery: LateSurfaceRecovery,
): boolean {
  if (!proofDetail || proofDetail.proofModel !== "split" || !proofDetail.receiptEndedAt) {
    return false;
  }
  return Date.parse(proofDetail.receiptEndedAt) > Date.parse(lateRecovery.updatedAt);
}

function lateRecoveryExtractionMethod(lateRecovery: LateSurfaceRecovery): SurfaceExtractionMethod {
  return /ocr/i.test(lateRecovery.caveat) || lateRecovery.surface === "perplexity/mac-app"
    ? "ocr-recovery"
    : "driver-json";
}

function provedProof(method: string, evidence: string, caveats: string[] = []): SurfaceProofRecord {
  return { verdict: "proved", method, evidence, caveats };
}

function failedProof(method: string, evidence: string): SurfaceProofRecord {
  return { verdict: "failed", method, evidence, caveats: [] };
}

function missingProof(method: string, evidence: string): SurfaceProofRecord {
  return { verdict: "missing", method, evidence, caveats: [] };
}

function isCliLikeSurface(entry?: SurfaceAtlasEntry): boolean {
  return (
    entry?.preferredDriver === "cli" ||
    entry?.preferredDriver === "mcp" ||
    entry?.surface.endsWith("/exec") ||
    entry?.surface === "ollama/localhost"
  );
}

function isChuckFamily(family: unknown): family is ChuckFamily {
  return (
    family === "anthropic" ||
    family === "openai" ||
    family === "google" ||
    family === "perplexity" ||
    family === "sovereign-local" ||
    family === "xai"
  );
}
