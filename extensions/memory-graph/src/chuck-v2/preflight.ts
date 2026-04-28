import { validateFleet } from "./config.js";
import type {
  ChuckConfig,
  ChuckFamily,
  ChuckFleetEntry,
  MachineResourceSnapshot,
  StakeClass,
  WorkerHealthSnapshot,
} from "./types.js";

const VOICE_TO_HEALTH_KEY: Record<string, string> = {
  "claude-cli": "claude",
  "claude-ai": "claude-ai",
  "chatgpt-web": "chatgpt",
  codex: "codex",
  "gemini-cli": "gemini",
  "gemini-web": "gemini-web",
  "gemini-studio": "aistudio",
  "perplexity-mac": "perplexity",
  grok: "grok",
  "ollama-local": "ollama",
};

export type PreflightAdmission = {
  admitted: boolean;
  degradedMode: "FULL" | `DEGRADED-${number}` | "INCOMPLETE";
  validFamilies: ChuckFamily[];
  unavailable: Array<{ family: ChuckFamily; voice: string; reason: string }>;
  reasons: string[];
  resourceMode: "normal" | "memory-warning" | "memory-critical" | "concurrency-limited";
};

function healthFor(
  entry: ChuckFleetEntry,
  health?: WorkerHealthSnapshot,
): { healthy: boolean; reason: string } {
  const key = VOICE_TO_HEALTH_KEY[entry.voice] ?? entry.voice;
  const row = health?.workers[key];
  if (!row) {
    return { healthy: true, reason: "no health row; treated as unknown-healthy" };
  }
  return {
    healthy: row.healthy,
    reason: row.details ?? (row.healthy ? "healthy" : "unhealthy"),
  };
}

function degradedMode(valid: number, configured: number): PreflightAdmission["degradedMode"] {
  if (valid < 3) {
    return "INCOMPLETE";
  }
  if (valid >= configured) {
    return "FULL";
  }
  return `DEGRADED-${valid}`;
}

export function preflightAdmission({
  config,
  health,
  resources,
  activeFleetRuns = 0,
  stakeClass,
  sovereigntyCritical = false,
}: {
  config: ChuckConfig;
  health?: WorkerHealthSnapshot;
  resources?: MachineResourceSnapshot;
  activeFleetRuns?: number;
  stakeClass: StakeClass;
  sovereigntyCritical?: boolean;
}): PreflightAdmission {
  const validation = validateFleet(config.fleet);
  const reasons: string[] = [];
  if (!validation.ok) {
    reasons.push(
      `invalid fleet config: duplicateFamilySurfaces=${validation.duplicateFamilySurfaces.join(",") || "none"} missingSurface=${validation.missingSurface.join(",") || "none"} missingRationale=${validation.missingRationale.join(",") || "none"}`,
    );
    if (validation.invalidCommercialPolicy.length > 0) {
      reasons.push(`invalid commercial policy: ${validation.invalidCommercialPolicy.join(",")}`);
    }
  }

  const validFamilies: ChuckFamily[] = [];
  const unavailable: PreflightAdmission["unavailable"] = [];
  for (const entry of config.fleet) {
    const healthRow = healthFor(entry, health);
    if (healthRow.healthy) {
      validFamilies.push(entry.family);
    } else {
      unavailable.push({ family: entry.family, voice: entry.voice, reason: healthRow.reason });
    }
  }

  if (sovereigntyCritical && !validFamilies.includes("sovereign-local")) {
    reasons.push("sovereignty-critical task but sovereign-local family is unavailable");
  }

  const distinctCount = new Set(validFamilies).size;
  const configuredFamilyCount = new Set(config.fleet.map((entry) => entry.family)).size;
  const mode = degradedMode(distinctCount, configuredFamilyCount);
  const minRequired =
    stakeClass === "high-mutating" || stakeClass === "destructive"
      ? config.thresholds.highRiskMinimumFamilies
      : config.thresholds.minimumFamilies;
  if (distinctCount < minRequired) {
    reasons.push(`only ${distinctCount} valid families; ${minRequired} required for ${stakeClass}`);
  }
  if (stakeClass === "destructive" && mode !== "FULL") {
    reasons.push("destructive task cannot auto-proceed under degraded fleet");
  }
  const resourceAssessment = assessResourcePressure({
    resources,
    activeFleetRuns,
    maxConcurrentFleetRuns: config.budgets.maxConcurrentFleetRuns,
    lowFreeMemoryMb: config.budgets.lowFreeMemoryMb,
    stakeClass,
  });
  reasons.push(...resourceAssessment.reasons);

  return {
    admitted:
      validation.ok &&
      reasons.length === 0 &&
      !(sovereigntyCritical && !validFamilies.includes("sovereign-local")),
    degradedMode: mode,
    validFamilies: [...new Set(validFamilies)],
    unavailable,
    reasons,
    resourceMode: resourceAssessment.resourceMode,
  };
}

function assessResourcePressure({
  resources,
  activeFleetRuns,
  maxConcurrentFleetRuns,
  lowFreeMemoryMb,
  stakeClass,
}: {
  resources?: MachineResourceSnapshot;
  activeFleetRuns: number;
  maxConcurrentFleetRuns: number;
  lowFreeMemoryMb: number;
  stakeClass: StakeClass;
}): { resourceMode: PreflightAdmission["resourceMode"]; reasons: string[] } {
  const reasons: string[] = [];
  let resourceMode: PreflightAdmission["resourceMode"] = "normal";

  if (activeFleetRuns >= maxConcurrentFleetRuns) {
    resourceMode = "concurrency-limited";
    reasons.push(
      `active fleet runs ${activeFleetRuns} >= maxConcurrentFleetRuns ${maxConcurrentFleetRuns}`,
    );
  }

  if (!resources) {
    return { resourceMode, reasons };
  }

  if (resources.memoryPressure === "critical") {
    resourceMode = "memory-critical";
    if (stakeClass !== "trivial") {
      reasons.push("critical memory pressure; only trivial work admitted");
    }
  } else if (resources.memoryPressure === "warning") {
    resourceMode = resourceMode === "normal" ? "memory-warning" : resourceMode;
    if (stakeClass === "high-mutating" || stakeClass === "destructive") {
      reasons.push("memory warning blocks high-mutating/destructive fleet work");
    }
  }

  if (
    resources.freeMemoryMb !== undefined &&
    resources.freeMemoryMb < lowFreeMemoryMb &&
    stakeClass !== "trivial"
  ) {
    resourceMode = resources.memoryPressure === "critical" ? "memory-critical" : "memory-warning";
    reasons.push(`free memory ${resources.freeMemoryMb}MB below floor ${lowFreeMemoryMb}MB`);
  }

  return { resourceMode, reasons };
}
