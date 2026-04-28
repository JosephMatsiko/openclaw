import {
  buildScoutRoundPrompt,
  type EfficiencyDecision,
  type EfficiencyStage,
} from "./efficiency.js";
import type { ChuckConfig, ChuckFamily, ChuckFleetEntry, WorkerHealthSnapshot } from "./types.js";

export type FleetDispatchTask = {
  taskId: string;
  runId: string;
  stage: EfficiencyStage;
  family: ChuckFamily;
  voice: string;
  surface: string;
  countsAsIndependentFamilySignal: boolean;
  familyVoteKey: ChuckFamily;
  prompt: string;
  promptBudgetChars: number;
  timeoutMs: number;
  dropOnTimeout: boolean;
  sealed: boolean;
  includesPeerOutputs: boolean;
  status: "pending";
};

export type FleetDispatchPlan = {
  dispatchId: string;
  runId: string;
  optionKind: EfficiencyDecision["chosenOption"]["kind"];
  stage: EfficiencyStage;
  schedulingMode: EfficiencyDecision["chosenOption"]["schedulingMode"];
  lateScoutPolicy: EfficiencyDecision["fleetPlan"]["lateScoutPolicy"];
  tasks: FleetDispatchTask[];
  independentFamilyCount: number;
  skippedSurfaces: Array<{
    family: ChuckFamily;
    voice: string;
    surface: string;
    reason: string;
  }>;
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

export function createFleetDispatchPlan({
  runId,
  requestText,
  config,
  efficiencyDecision,
  health,
}: {
  runId: string;
  requestText: string;
  config: ChuckConfig;
  efficiencyDecision: EfficiencyDecision;
  health?: WorkerHealthSnapshot;
}): FleetDispatchPlan {
  const chosen = efficiencyDecision.chosenOption;
  const selectedEntries = config.fleet.filter(
    (entry) => chosen.surfaces.includes(entry.surface) && chosen.families.includes(entry.family),
  );
  const seenFamilies = new Set<ChuckFamily>();
  const skippedSurfaces: FleetDispatchPlan["skippedSurfaces"] = [];
  const tasks: FleetDispatchTask[] = [];
  for (const entry of selectedEntries) {
    const healthResult = healthFor(entry, health);
    if (!healthResult.healthy) {
      skippedSurfaces.push({
        family: entry.family,
        voice: entry.voice,
        surface: entry.surface,
        reason: healthResult.reason,
      });
      continue;
    }
    const scoutPrompt = buildScoutRoundPrompt({
      requestText,
      maxChars: chosen.promptBudgetChars,
      timeoutMs: chosen.timeoutMs,
    });
    const countsAsIndependentFamilySignal = !seenFamilies.has(entry.family);
    seenFamilies.add(entry.family);
    tasks.push({
      taskId: `${runId}:${entry.family}:${sanitizeTaskPart(entry.surface)}:${efficiencyDecision.stage}`,
      runId,
      stage: efficiencyDecision.stage,
      family: entry.family,
      voice: entry.voice,
      surface: entry.surface,
      countsAsIndependentFamilySignal,
      familyVoteKey: entry.family,
      prompt: scoutPrompt.prompt,
      promptBudgetChars: scoutPrompt.maxChars,
      timeoutMs: scoutPrompt.timeoutMs,
      dropOnTimeout: scoutPrompt.dropOnTimeout,
      sealed: scoutPrompt.sealed,
      includesPeerOutputs: scoutPrompt.includesPeerOutputs,
      status: "pending",
    });
  }
  return {
    dispatchId: `dispatch-${runId}-${efficiencyDecision.decisionId}`,
    runId,
    optionKind: chosen.kind,
    stage: efficiencyDecision.stage,
    schedulingMode: chosen.schedulingMode,
    lateScoutPolicy: efficiencyDecision.fleetPlan.lateScoutPolicy,
    tasks,
    independentFamilyCount: tasks.filter((task) => task.countsAsIndependentFamilySignal).length,
    skippedSurfaces,
  };
}

function healthFor(
  entry: ChuckFleetEntry,
  health?: WorkerHealthSnapshot,
): { healthy: boolean; reason: string } {
  const key = VOICE_TO_HEALTH_KEY[entry.voice] ?? entry.voice;
  const row = health?.workers[key];
  if (!row) {
    return { healthy: true, reason: "no health row; dispatch treated as available" };
  }
  return {
    healthy: row.healthy,
    reason: row.details ?? (row.healthy ? "healthy" : "unhealthy"),
  };
}

function sanitizeTaskPart(value: string): string {
  return value.replaceAll(/[^a-z0-9._-]+/gi, "-").replaceAll(/^-|-$/g, "");
}
