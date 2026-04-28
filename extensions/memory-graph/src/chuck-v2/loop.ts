import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHUCK_V2_STATE_DIR, DEFAULT_CHUCK_CONFIG } from "./config.js";
import { planFleetEfficiency, type EfficiencyDecision } from "./efficiency.js";
import { appendChuckEventLine, chainChuckEvents } from "./events.js";
import { evaluateKernelAdjudication, evaluateKernelPreflight } from "./kernel.js";
import { signRunnerReceipt } from "./receipt.js";
import { createFleetDispatchPlan, type FleetDispatchPlan } from "./runner-dispatch.js";
import { appendFleetTrace, createFleetTraceRecord, type FleetTraceRecord } from "./trace.js";
import type {
  AlignmentMatrix,
  ChuckConfig,
  ChuckEvent,
  ChuckFamily,
  Claim,
  DecisionRecord,
  DocketItem,
  KernelDisposition,
  MachineResourceSnapshot,
  WorkerHealthSnapshot,
} from "./types.js";

export type ChuckLoopMode = "preflight" | "demo-fleet";

export type ChuckLoopResult = {
  runId: string;
  createdAt: string;
  requestText: string;
  mode: ChuckLoopMode;
  disposition: KernelDisposition;
  finalAction: string;
  operatorActionRequired: boolean;
  preflight: ReturnType<typeof evaluateKernelPreflight>;
  efficiencyDecision: EfficiencyDecision;
  dispatchPlan: FleetDispatchPlan;
  traceRecord: FleetTraceRecord;
  adjudication?: ReturnType<typeof evaluateKernelAdjudication>;
  decisionRecord?: DecisionRecord;
  docketItem: DocketItem;
  events: ChuckEvent[];
};

export type ChuckLoopInput = {
  requestText: string;
  mode?: ChuckLoopMode;
  config?: ChuckConfig;
  health?: WorkerHealthSnapshot;
  resources?: MachineResourceSnapshot;
  activeFleetRuns?: number;
  sovereigntyCritical?: boolean;
  operatorApproved?: boolean;
  runId?: string;
  now?: string;
  signingSecret?: string;
};

export type PersistChuckLoopOptions = {
  stateDir?: string;
};

export type PersistedChuckLoop = {
  runPath: string;
  decisionRecordPath?: string;
  traceDbPath: string;
  traceId: string;
  docketPath: string;
  eventsPath: string;
};

export async function runChuckLoop({
  requestText,
  mode = "preflight",
  config = DEFAULT_CHUCK_CONFIG,
  health,
  resources,
  activeFleetRuns,
  sovereigntyCritical = false,
  operatorApproved = false,
  runId = createRunId(),
  now = new Date().toISOString(),
  signingSecret = "chuck-v2-local-shadow-secret",
}: ChuckLoopInput): Promise<ChuckLoopResult> {
  const preflight = evaluateKernelPreflight({
    requestText,
    config,
    health,
    resources,
    activeFleetRuns,
    sovereigntyCritical,
  });
  const efficiencyDecision = planFleetEfficiency({
    runId,
    requestText,
    stakeClass: preflight.assessment.stakeClass,
    taskClass: preflight.assessment.taskClass,
    config,
    health,
    resources,
  });
  const dispatchPlan = createFleetDispatchPlan({
    runId,
    requestText,
    config,
    efficiencyDecision,
    health,
  });

  if (mode === "demo-fleet" && preflight.disposition === "route-fleet") {
    const adjudication = evaluateKernelAdjudication({
      requestText,
      config,
      health,
      resources,
      activeFleetRuns,
      sovereigntyCritical,
      operatorApproved,
      receipts: demoReceipts({ config, now, signingSecret, requestText }),
      claims: [demoClaim({ requestText, producedBy: config.fleet.map((entry) => entry.family) })],
      alignmentMatrix: demoAlignmentMatrix(config),
      adjudicatorFamily: config.fleet[0]?.family ?? "unknown",
      efficiencyDecisionId: efficiencyDecision.decisionId,
      runId,
    });
    const traceRecord = traceRecordForLoop({
      runId,
      preflight: adjudication,
      efficiencyDecision,
      dispatchPlan,
      decisionRecord: adjudication.decisionRecord,
      resources,
      createdAt: now,
    });
    const events = eventsForAdjudicatedLoop({
      requestText,
      decision: adjudication,
      efficiencyDecision,
      dispatchPlan,
      traceRecord,
      occurredAt: now,
    });
    const docketItem = docketItemForLoop({
      runId,
      createdAt: now,
      requestText,
      disposition: adjudication.disposition,
      finalAction: adjudication.finalAction,
      operatorActionRequired: adjudication.operatorActionRequired,
      stakeClass: adjudication.assessment.stakeClass,
      taskClass: adjudication.assessment.taskClass,
      reasons: adjudication.reasons,
      protocol: adjudication.classification.protocol,
      decisionRecordId: adjudication.decisionRecord.runId,
    });
    return {
      runId,
      createdAt: now,
      requestText,
      mode,
      disposition: adjudication.disposition,
      finalAction: adjudication.finalAction,
      operatorActionRequired: adjudication.operatorActionRequired,
      preflight,
      efficiencyDecision,
      dispatchPlan,
      traceRecord,
      adjudication,
      decisionRecord: adjudication.decisionRecord,
      docketItem,
      events,
    };
  }

  const events = eventsForPreflightLoop({ requestText, runId, preflight, occurredAt: now });
  const traceRecord = traceRecordForLoop({
    runId,
    preflight,
    efficiencyDecision,
    dispatchPlan,
    resources,
    createdAt: now,
  });
  const chainedEvents = chainChuckEvents([
    ...events.map(
      ({ eventHash: _eventHash, previousEventHash: _previousEventHash, ...event }) => event,
    ),
    efficiencyEvent({ runId, efficiencyDecision, occurredAt: now }),
    dispatchEvent({ runId, dispatchPlan, occurredAt: now }),
    traceEvent({ runId, traceRecord, occurredAt: now }),
  ]);
  const docketItem = docketItemForLoop({
    runId,
    createdAt: now,
    requestText,
    disposition: preflight.disposition,
    finalAction: preflight.finalAction,
    operatorActionRequired: preflight.operatorActionRequired,
    stakeClass: preflight.assessment.stakeClass,
    taskClass: preflight.assessment.taskClass,
    reasons: preflight.reasons,
  });
  return {
    runId,
    createdAt: now,
    requestText,
    mode,
    disposition: preflight.disposition,
    finalAction: preflight.finalAction,
    operatorActionRequired: preflight.operatorActionRequired,
    preflight,
    efficiencyDecision,
    dispatchPlan,
    traceRecord,
    docketItem,
    events: chainedEvents,
  };
}

export async function persistChuckLoopResult(
  result: ChuckLoopResult,
  { stateDir = CHUCK_V2_STATE_DIR }: PersistChuckLoopOptions = {},
): Promise<PersistedChuckLoop> {
  const runsDir = join(stateDir, "runs");
  const decisionsDir = join(stateDir, "decision-records");
  const tracesDir = join(stateDir, "traces");
  await mkdir(runsDir, { recursive: true });
  await mkdir(decisionsDir, { recursive: true });
  await mkdir(tracesDir, { recursive: true });
  const runPath = join(runsDir, `${result.runId}.json`);
  const decisionRecordPath = result.decisionRecord
    ? join(decisionsDir, `${result.decisionRecord.runId}.json`)
    : undefined;
  const traceDbPath = join(tracesDir, "fleet-traces.sqlite");
  const docketPath = join(stateDir, "docket.jsonl");
  const eventsPath = join(stateDir, "events.jsonl");
  await writeFile(runPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (result.decisionRecord && decisionRecordPath) {
    await writeFile(
      decisionRecordPath,
      `${JSON.stringify(result.decisionRecord, null, 2)}\n`,
      "utf8",
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  const traceDb = new DatabaseSync(traceDbPath);
  try {
    appendFleetTrace(traceDb, result.traceRecord);
  } finally {
    traceDb.close();
  }
  await appendFile(docketPath, `${JSON.stringify(result.docketItem)}\n`, "utf8");
  await appendFile(eventsPath, result.events.map(appendChuckEventLine).join(""), "utf8");
  return {
    runPath,
    decisionRecordPath,
    traceDbPath,
    traceId: result.traceRecord.traceId,
    docketPath,
    eventsPath,
  };
}

export async function readDocketItems({
  stateDir = CHUCK_V2_STATE_DIR,
  limit = 20,
}: {
  stateDir?: string;
  limit?: number;
} = {}): Promise<DocketItem[]> {
  let text = "";
  try {
    text = await readFile(join(stateDir, "docket.jsonl"), "utf8");
  } catch {
    return [];
  }
  const latestByDocketId = new Map<string, DocketItem>();
  for (const item of text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DocketItem)) {
    latestByDocketId.delete(item.docketId);
    latestByDocketId.set(item.docketId, item);
  }
  return [...latestByDocketId.values()].slice(-limit);
}

export function summarizeChuckLoopResult(result: ChuckLoopResult): Record<string, unknown> {
  return {
    runId: result.runId,
    mode: result.mode,
    disposition: result.disposition,
    finalAction: result.finalAction,
    stakeClass: result.preflight.assessment.stakeClass,
    taskClass: result.preflight.assessment.taskClass,
    docketStatus: result.docketItem.status,
    operatorActionRequired: result.operatorActionRequired,
    decisionRecordId: result.decisionRecord?.runId,
    efficiencyDecisionId: result.efficiencyDecision.decisionId,
    efficiencyOption: result.efficiencyDecision.chosenOption.kind,
    efficiencyStage: result.efficiencyDecision.stage,
    schedulingMode: result.efficiencyDecision.chosenOption.schedulingMode,
    dispatchId: result.dispatchPlan.dispatchId,
    dispatchTaskCount: result.dispatchPlan.tasks.length,
    traceId: result.traceRecord.traceId,
    traceGrade: result.traceRecord.grade.grade,
    protocol: result.adjudication?.classification.protocol,
    reasons: result.docketItem.reasons,
  };
}

function eventsForPreflightLoop({
  requestText,
  runId,
  preflight,
  occurredAt,
}: {
  requestText: string;
  runId: string;
  preflight: ReturnType<typeof evaluateKernelPreflight>;
  occurredAt: string;
}): ChuckEvent[] {
  return chainChuckEvents([
    {
      eventId: `${runId}:prompt`,
      type: "prompt.received",
      occurredAt,
      runId,
      payload: { text: requestText },
    },
    {
      eventId: `${runId}:stake`,
      type: "stake.classified",
      occurredAt,
      runId,
      payload: {
        stakeClass: preflight.assessment.stakeClass,
        taskClass: preflight.assessment.taskClass,
        reasons: preflight.assessment.reasons,
      },
    },
    {
      eventId: `${runId}:preflight`,
      type: "preflight.evaluated",
      occurredAt,
      runId,
      payload: {
        admitted: preflight.preflight.admitted,
        degradedMode: preflight.preflight.degradedMode,
        validFamilies: preflight.preflight.validFamilies,
        reasons: preflight.preflight.reasons,
        disposition: preflight.disposition,
        finalAction: preflight.finalAction,
      },
    },
  ]);
}

function efficiencyEvent({
  runId,
  efficiencyDecision,
  occurredAt,
}: {
  runId: string;
  efficiencyDecision: EfficiencyDecision;
  occurredAt: string;
}) {
  return {
    eventId: `${runId}:efficiency`,
    type: "efficiency.planned" as const,
    occurredAt,
    runId,
    payload: {
      decisionId: efficiencyDecision.decisionId,
      chosenOption: efficiencyDecision.chosenOption.kind,
      stage: efficiencyDecision.stage,
      schedulingMode: efficiencyDecision.chosenOption.schedulingMode,
      visibleToOperator: efficiencyDecision.visibleToOperator,
      reason: efficiencyDecision.reason,
    },
  };
}

function dispatchEvent({
  runId,
  dispatchPlan,
  occurredAt,
}: {
  runId: string;
  dispatchPlan: FleetDispatchPlan;
  occurredAt: string;
}) {
  return {
    eventId: `${runId}:dispatch`,
    type: "fleet.dispatch.planned" as const,
    occurredAt,
    runId,
    payload: {
      dispatchId: dispatchPlan.dispatchId,
      optionKind: dispatchPlan.optionKind,
      stage: dispatchPlan.stage,
      schedulingMode: dispatchPlan.schedulingMode,
      taskCount: dispatchPlan.tasks.length,
      independentFamilyCount: dispatchPlan.independentFamilyCount,
      skippedSurfaces: dispatchPlan.skippedSurfaces,
    },
  };
}

function traceEvent({
  runId,
  traceRecord,
  occurredAt,
}: {
  runId: string;
  traceRecord: FleetTraceRecord;
  occurredAt: string;
}) {
  return {
    eventId: `${runId}:trace`,
    type: "fleet.trace.recorded" as const,
    occurredAt,
    runId,
    payload: {
      traceId: traceRecord.traceId,
      routeTaken: traceRecord.routeTaken,
      grade: traceRecord.grade.grade,
      score: traceRecord.grade.score,
      regressionSignals: traceRecord.grade.regressionSignals,
    },
  };
}

function eventsForAdjudicatedLoop({
  requestText,
  decision,
  efficiencyDecision,
  dispatchPlan,
  traceRecord,
  occurredAt,
}: {
  requestText: string;
  decision: ReturnType<typeof evaluateKernelAdjudication>;
  efficiencyDecision: EfficiencyDecision;
  dispatchPlan: FleetDispatchPlan;
  traceRecord: FleetTraceRecord;
  occurredAt: string;
}): ChuckEvent[] {
  return chainChuckEvents([
    ...eventsForPreflightLoop({
      requestText,
      runId: decision.decisionRecord.runId,
      preflight: decision,
      occurredAt,
    }).map(({ eventHash: _eventHash, previousEventHash: _previousEventHash, ...event }) => event),
    efficiencyEvent({ runId: decision.decisionRecord.runId, efficiencyDecision, occurredAt }),
    dispatchEvent({ runId: decision.decisionRecord.runId, dispatchPlan, occurredAt }),
    {
      eventId: `${decision.decisionRecord.runId}:protocol`,
      type: "protocol.classified",
      occurredAt,
      runId: decision.decisionRecord.runId,
      payload: {
        protocol: decision.classification.protocol,
        finalAction: decision.finalAction,
        disposition: decision.disposition,
        reason: decision.classification.reason,
      },
    },
    traceEvent({ runId: decision.decisionRecord.runId, traceRecord, occurredAt }),
    {
      eventId: `${decision.decisionRecord.runId}:decision`,
      type: "decision.recorded",
      occurredAt,
      runId: decision.decisionRecord.runId,
      payload: {
        decisionRecordId: decision.decisionRecord.runId,
        operatorActionRequired: decision.operatorActionRequired,
        canExecute: decision.canExecute,
        canContinueResolution: decision.canContinueResolution,
      },
    },
  ]);
}

function docketItemForLoop({
  runId,
  createdAt,
  requestText,
  disposition,
  finalAction,
  operatorActionRequired,
  stakeClass,
  taskClass,
  reasons,
  protocol,
  decisionRecordId,
}: {
  runId: string;
  createdAt: string;
  requestText: string;
  disposition: KernelDisposition;
  finalAction: string;
  operatorActionRequired: boolean;
  stakeClass: DocketItem["stakeClass"];
  taskClass: DocketItem["taskClass"];
  reasons: string[];
  protocol?: DocketItem["protocol"];
  decisionRecordId?: string;
}): DocketItem {
  return {
    docketId: `docket-${runId}`,
    runId,
    createdAt,
    updatedAt: createdAt,
    status: docketStatusFor({ disposition, finalAction, operatorActionRequired }),
    title: summarizePrompt(requestText),
    stakeClass,
    taskClass,
    protocol,
    finalAction,
    operatorActionRequired,
    decisionRecordId,
    reasons,
  };
}

function docketStatusFor({
  disposition,
  finalAction,
  operatorActionRequired,
}: {
  disposition: KernelDisposition;
  finalAction: string;
  operatorActionRequired: boolean;
}): DocketItem["status"] {
  if (operatorActionRequired) {
    return "needs-approval";
  }
  if (disposition === "route-fleet") {
    return "waiting-fleet";
  }
  if (disposition === "continue-resolution") {
    return "waiting-resolution";
  }
  if (disposition === "halt" || finalAction === "operator-halt" || finalAction === "refuse") {
    return "halted";
  }
  return "ready";
}

function traceRecordForLoop({
  runId,
  preflight,
  efficiencyDecision,
  dispatchPlan,
  decisionRecord,
  resources,
  createdAt,
}: {
  runId: string;
  preflight: ReturnType<typeof evaluateKernelPreflight>;
  efficiencyDecision: EfficiencyDecision;
  dispatchPlan: FleetDispatchPlan;
  decisionRecord?: DecisionRecord;
  resources?: MachineResourceSnapshot;
  createdAt: string;
}): FleetTraceRecord {
  return createFleetTraceRecord({
    traceId: `trace-${runId}`,
    createdAt,
    runId,
    taskClass: preflight.assessment.taskClass,
    stakeClass: preflight.assessment.stakeClass,
    routeTaken: efficiencyDecision.chosenOption.kind,
    scoutFamilies: dispatchPlan.tasks
      .filter((task) => task.countsAsIndependentFamilySignal)
      .map((task) => task.family),
    promptBudgetChars: efficiencyDecision.chosenOption.promptBudgetChars,
    surfaceReceiptCount: decisionRecord?.surfaceReceipts.length ?? 0,
    finalDisposition: preflight.finalAction,
    protocol: decisionRecord?.protocol,
    memoryPressure: resources?.memoryPressure,
    quotaPolicy: quotaPolicyForDecision(efficiencyDecision),
    metrics: {
      evidenceQuality:
        decisionRecord === undefined ? undefined : evidenceQualityForDecisionRecord(decisionRecord),
      failures: dispatchPlan.skippedSurfaces.length,
    },
  });
}

function evidenceQualityForDecisionRecord(decisionRecord: DecisionRecord): number {
  if (decisionRecord.evidenceCited.includes("deterministic-verifier")) {
    return 0.95;
  }
  if (
    decisionRecord.evidenceCited.includes("runtime-trace") ||
    decisionRecord.evidenceCited.includes("primary-doc")
  ) {
    return 0.85;
  }
  if (
    decisionRecord.evidenceCited.includes("repo-fact") ||
    decisionRecord.evidenceCited.includes("live-source")
  ) {
    return 0.78;
  }
  if (decisionRecord.evidenceCited.includes("model-reasoning")) {
    return 0.55;
  }
  return 0.35;
}

function quotaPolicyForDecision(efficiencyDecision: EfficiencyDecision): string {
  if (efficiencyDecision.chosenOption.kind === "single-surface") {
    return "minimal";
  }
  if (efficiencyDecision.chosenOption.schedulingMode === "staggered") {
    return "staggered";
  }
  if (efficiencyDecision.chosenOption.kind === "docket") {
    return "deferred";
  }
  return "fleet-scout";
}

function demoReceipts({
  config,
  now,
  signingSecret,
  requestText,
}: {
  config: ChuckConfig;
  now: string;
  signingSecret: string;
  requestText: string;
}) {
  return config.fleet.map((entry, index) =>
    signRunnerReceipt({
      declaredVoice: entry.voice,
      requestedFamily: entry.family,
      actualRunner: `${entry.voice}:shadow-demo`,
      actualFamily: entry.family,
      surface: entry.surface,
      layerUsed: "chuck-v2-demo-fleet",
      modelClaimed: `shadow-demo/${entry.family}`,
      modelVerified: true,
      transcriptText: `DEMO-FLEET ONLY. No model was called. Request: ${requestText}`,
      startedAt: now,
      endedAt: addMilliseconds(now, index + 1),
      signingSecret,
    }),
  );
}

function demoClaim({
  requestText,
  producedBy,
}: {
  requestText: string;
  producedBy: ChuckFamily[];
}): Claim {
  return {
    id: "claim-demo-shadow-1",
    text: `Shadow demo claim for Kernel plumbing only: ${summarizePrompt(requestText)}`,
    category: "technical",
    evidenceClass: "model-reasoning",
    sourceSpans: [{ source: "chuck-v2-demo-fleet" }],
    vaultNodes: [],
    confidence: 0.1,
    producedBy,
  };
}

function demoAlignmentMatrix(config: ChuckConfig): AlignmentMatrix {
  return {
    clusters: [
      {
        id: "demo-shadow-unanimous",
        familyVotes: [...new Set(config.fleet.map((entry) => entry.family))],
        claimIds: ["claim-demo-shadow-1"],
        summary: "All configured demo families are placed in one shadow cluster.",
      },
    ],
    contradictions: [],
  };
}

function createRunId(): string {
  return `chuck-${new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function summarizePrompt(text: string): string {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized || "(empty request)";
}

function addMilliseconds(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}
