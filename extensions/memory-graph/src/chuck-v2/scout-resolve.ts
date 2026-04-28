import { createHash } from "node:crypto";
import { normalizeClaimText } from "./efficiency.js";
import type { FleetDispatchPlan, FleetDispatchTask } from "./runner-dispatch.js";
import type {
  FleetDispatchExecutionResult,
  FleetDispatchTaskExecution,
} from "./runner-executor.js";
import type { ChuckFamily } from "./types.js";

export type ParsedScoutSections = {
  claims: string[];
  risks: string[];
  missingEvidence: string[];
  deepenNeeded: "yes" | "no" | "unknown";
};

export type ScoutFamilySignal = {
  family: ChuckFamily;
  surface: string;
  status: FleetDispatchTaskExecution["status"];
  countingEligible: boolean;
  deepenNeeded: ParsedScoutSections["deepenNeeded"];
  claimCount: number;
  riskCount: number;
  missingEvidenceCount: number;
};

export type ScoutResolveDisposition =
  | "halt-no-usable-scouts"
  | "deepen"
  | "ready-for-adjudication"
  | "degraded-ready";

export type FleetScoutResolve = {
  dispatchId: string;
  runId: string;
  usableSurfaces: string[];
  usableFamilies: ChuckFamily[];
  independentUsableFamilyCount: number;
  failedSurfaces: string[];
  skippedSurfaces: string[];
  deepenNeededSurfaces: string[];
  noDeepenSurfaces: string[];
  unknownDeepenSurfaces: string[];
  normalizedClaims: Array<{
    family: ChuckFamily;
    surface: string;
    text: string;
  }>;
  dissentRetained: boolean;
  disposition: ScoutResolveDisposition;
  reasons: string[];
  familySignals: ScoutFamilySignal[];
};

export type FleetDeepenDispatchPlanOptions = {
  scoutPlan: FleetDispatchPlan;
  scoutResolve: FleetScoutResolve;
  requestText: string;
  promptBudgetChars?: number;
  timeoutMs?: number;
  maxClaims?: number;
};

export function parseScoutSections(text: string): ParsedScoutSections {
  const sections: ParsedScoutSections = {
    claims: [],
    risks: [],
    missingEvidence: [],
    deepenNeeded: "unknown",
  };
  let current: "claims" | "risks" | "missingEvidence" | "deepenNeeded" | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const label = line.match(/^(CLAIMS|RISKS|MISSING[_ ]EVIDENCE|DEEPEN_NEEDED)\s*:\s*(.*)$/i);
    if (label) {
      const labelName = label[1].toUpperCase().replace(" ", "_");
      current = scoutSectionForLabel(labelName);
      const inline = label[2]?.trim();
      if (inline) {
        appendScoutLine(sections, current, inline);
      }
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    appendScoutLine(sections, current, bullet?.[1]?.trim() ?? line);
  }
  return sections;
}

function scoutSectionForLabel(
  labelName: string,
): "claims" | "risks" | "missingEvidence" | "deepenNeeded" {
  if (labelName === "CLAIMS") {
    return "claims";
  }
  if (labelName === "RISKS") {
    return "risks";
  }
  if (labelName === "MISSING_EVIDENCE") {
    return "missingEvidence";
  }
  return "deepenNeeded";
}

export function resolveFleetScout(execution: FleetDispatchExecutionResult): FleetScoutResolve {
  const usableSurfaces: string[] = [];
  const failedSurfaces: string[] = [];
  const skippedSurfaces: string[] = [];
  const deepenNeededSurfaces: string[] = [];
  const noDeepenSurfaces: string[] = [];
  const unknownDeepenSurfaces: string[] = [];
  const normalizedClaims: FleetScoutResolve["normalizedClaims"] = [];
  const familySignals: ScoutFamilySignal[] = [];
  const usableFamilies = new Set<ChuckFamily>();

  for (const item of execution.executions) {
    if (item.status !== "completed") {
      if (item.status === "failed") {
        failedSurfaces.push(item.surface);
      } else {
        skippedSurfaces.push(item.surface);
      }
      familySignals.push(baseSignal(item, "unknown", false));
      continue;
    }
    const parsed = parseScoutSections(item.text);
    const countingEligible = item.countingEligible && item.calibration.verdict === "usable";
    if (countingEligible) {
      usableSurfaces.push(item.surface);
      usableFamilies.add(item.family);
    }
    if (parsed.deepenNeeded === "yes") {
      deepenNeededSurfaces.push(item.surface);
    } else if (parsed.deepenNeeded === "no") {
      noDeepenSurfaces.push(item.surface);
    } else {
      unknownDeepenSurfaces.push(item.surface);
    }
    for (const claim of parsed.claims) {
      normalizedClaims.push({
        family: item.family,
        surface: item.surface,
        text: normalizeClaimText(claim),
      });
    }
    familySignals.push({
      family: item.family,
      surface: item.surface,
      status: item.status,
      countingEligible,
      deepenNeeded: parsed.deepenNeeded,
      claimCount: parsed.claims.length,
      riskCount: parsed.risks.length,
      missingEvidenceCount: parsed.missingEvidence.length,
    });
  }

  const deepenValues = new Set(
    familySignals.filter((signal) => signal.countingEligible).map((signal) => signal.deepenNeeded),
  );
  const dissentRetained = deepenValues.size > 1;
  const disposition = scoutDisposition({
    usableCount: usableSurfaces.length,
    failedCount: failedSurfaces.length,
    skippedCount: skippedSurfaces.length,
    deepenCount: deepenNeededSurfaces.length,
    unknownCount: unknownDeepenSurfaces.length,
  });

  return {
    dispatchId: execution.dispatchId,
    runId: execution.runId,
    usableSurfaces,
    usableFamilies: [...usableFamilies],
    independentUsableFamilyCount: usableFamilies.size,
    failedSurfaces,
    skippedSurfaces,
    deepenNeededSurfaces,
    noDeepenSurfaces,
    unknownDeepenSurfaces,
    normalizedClaims,
    dissentRetained,
    disposition,
    reasons: scoutResolveReasons({
      disposition,
      usableSurfaces,
      failedSurfaces,
      skippedSurfaces,
      deepenNeededSurfaces,
      unknownDeepenSurfaces,
    }),
    familySignals,
  };
}

export function createFleetDeepenDispatchPlan({
  scoutPlan,
  scoutResolve,
  requestText,
  promptBudgetChars = 12_000,
  timeoutMs = 120_000,
  maxClaims = 16,
}: FleetDeepenDispatchPlanOptions): FleetDispatchPlan | undefined {
  if (scoutResolve.disposition !== "deepen" || scoutResolve.usableSurfaces.length === 0) {
    return undefined;
  }
  const deepenSurfaces = new Set([
    ...scoutResolve.deepenNeededSurfaces,
    ...scoutResolve.unknownDeepenSurfaces,
  ]);
  const eligibleSurfaces =
    deepenSurfaces.size > 0 ? deepenSurfaces : new Set(scoutResolve.usableSurfaces);
  const selectedTasks = scoutPlan.tasks.filter(
    (task) =>
      scoutResolve.usableSurfaces.includes(task.surface) && eligibleSurfaces.has(task.surface),
  );
  if (selectedTasks.length === 0) {
    return undefined;
  }
  const prompt = buildIdentityBlindDeepenPrompt({
    requestText,
    claims: scoutResolve.normalizedClaims.map((claim) => claim.text),
    maxClaims,
  });
  const tasks: FleetDispatchTask[] = selectedTasks.map((task) => ({
    taskId: task.taskId.endsWith(":scout")
      ? task.taskId.replace(/:scout$/, ":deepen")
      : `${task.taskId}:deepen`,
    runId: task.runId,
    stage: "deepen",
    family: task.family,
    voice: task.voice,
    surface: task.surface,
    countsAsIndependentFamilySignal: task.countsAsIndependentFamilySignal,
    familyVoteKey: task.familyVoteKey,
    prompt,
    promptBudgetChars,
    timeoutMs,
    dropOnTimeout: true,
    sealed: false,
    includesPeerOutputs: true,
    status: "pending",
  }));
  return {
    dispatchId: `${scoutPlan.dispatchId}:deepen`,
    runId: scoutPlan.runId,
    optionKind: "fleet-deepen",
    stage: "deepen",
    schedulingMode: scoutPlan.schedulingMode,
    lateScoutPolicy: scoutPlan.lateScoutPolicy,
    tasks,
    independentFamilyCount: tasks.filter((task) => task.countsAsIndependentFamilySignal).length,
    skippedSurfaces: scoutPlan.skippedSurfaces,
  };
}

function buildIdentityBlindDeepenPrompt({
  requestText,
  claims,
  maxClaims,
}: {
  requestText: string;
  claims: string[];
  maxClaims: number;
}): string {
  const normalizedClaims = [...new Set(claims.map(normalizeClaimText).filter(Boolean))]
    .toSorted((a, b) => hashOrder(a) - hashOrder(b))
    .slice(0, maxClaims);
  return [
    "You are running the Fleet deepen stage.",
    "You are seeing normalized, identity-blind claims from sealed first-pass scouts.",
    "Do not infer model identity, prestige, vote count, or authority from wording.",
    "Evidence, deterministic tests, receipts, and primary source spans outrank persuasive text.",
    "Treat outlier-shaped claims as possible alpha, but validate premises before action.",
    "",
    "Original task:",
    requestText,
    "",
    "Normalized scout claims:",
    ...normalizedClaims.map((claim, index) => `${index + 1}. ${claim}`),
    "",
    "Return exactly these sections:",
    "CLAIMS:",
    "- ...",
    "RISKS:",
    "- ...",
    "MISSING_EVIDENCE:",
    "- ...",
    "DEEPEN_NEEDED: yes|no",
  ].join("\n");
}

function hashOrder(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 12), 16);
}

function appendScoutLine(
  sections: ParsedScoutSections,
  current: "claims" | "risks" | "missingEvidence" | "deepenNeeded" | undefined,
  value: string,
): void {
  if (!current) {
    return;
  }
  if (current === "deepenNeeded") {
    if (/\byes\b/i.test(value)) {
      sections.deepenNeeded = "yes";
    } else if (/\bno\b/i.test(value)) {
      sections.deepenNeeded = "no";
    }
    return;
  }
  sections[current].push(value);
}

function baseSignal(
  item: Extract<FleetDispatchTaskExecution, { status: "failed" | "skipped" }>,
  deepenNeeded: ParsedScoutSections["deepenNeeded"],
  countingEligible: boolean,
): ScoutFamilySignal {
  return {
    family: item.family,
    surface: item.surface,
    status: item.status,
    countingEligible,
    deepenNeeded,
    claimCount: 0,
    riskCount: 0,
    missingEvidenceCount: 0,
  };
}

function scoutDisposition({
  usableCount,
  failedCount,
  skippedCount,
  deepenCount,
  unknownCount,
}: {
  usableCount: number;
  failedCount: number;
  skippedCount: number;
  deepenCount: number;
  unknownCount: number;
}): ScoutResolveDisposition {
  if (usableCount === 0) {
    return "halt-no-usable-scouts";
  }
  if (deepenCount > 0 || unknownCount > 0) {
    return "deepen";
  }
  if (failedCount > 0 || skippedCount > 0) {
    return "degraded-ready";
  }
  return "ready-for-adjudication";
}

function scoutResolveReasons({
  disposition,
  usableSurfaces,
  failedSurfaces,
  skippedSurfaces,
  deepenNeededSurfaces,
  unknownDeepenSurfaces,
}: {
  disposition: ScoutResolveDisposition;
  usableSurfaces: string[];
  failedSurfaces: string[];
  skippedSurfaces: string[];
  deepenNeededSurfaces: string[];
  unknownDeepenSurfaces: string[];
}): string[] {
  const reasons: string[] = [`scout resolve disposition: ${disposition}`];
  reasons.push(`usable scout surfaces: ${usableSurfaces.length}`);
  if (deepenNeededSurfaces.length > 0) {
    reasons.push(`deepen requested by: ${deepenNeededSurfaces.join(", ")}`);
  }
  if (unknownDeepenSurfaces.length > 0) {
    reasons.push(`deepen signal missing from: ${unknownDeepenSurfaces.join(", ")}`);
  }
  if (failedSurfaces.length > 0) {
    reasons.push(`failed scout surfaces: ${failedSurfaces.join(", ")}`);
  }
  if (skippedSurfaces.length > 0) {
    reasons.push(`skipped scout surfaces: ${skippedSurfaces.join(", ")}`);
  }
  return reasons;
}
