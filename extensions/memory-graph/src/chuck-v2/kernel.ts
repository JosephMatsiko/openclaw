import { DEFAULT_CHUCK_CONFIG } from "./config.js";
import { chainChuckEvents } from "./events.js";
import { preflightAdmission, type PreflightAdmission } from "./preflight.js";
import { classifyProtocol, type ProtocolClassification } from "./protocol.js";
import { isImpersonatedReceipt, summarizeReceiptInvariants } from "./receipt.js";
import { decisionRecordFromParts } from "./records.js";
import { assessStake, type StakeAssessment } from "./stake.js";
import type {
  AlignmentMatrix,
  ChuckConfig,
  ChuckFamily,
  Claim,
  ChuckEvent,
  DecisionRecord,
  FinalAction,
  IntraFamilyFracture,
  KernelDisposition,
  MachineResourceSnapshot,
  RunnerReceipt,
  WorkerHealthSnapshot,
} from "./types.js";

export type KernelPreflightDecision = {
  assessment: StakeAssessment;
  preflight: PreflightAdmission;
  disposition: KernelDisposition;
  finalAction: FinalAction;
  canProceed: boolean;
  operatorActionRequired: boolean;
  reasons: string[];
};

export type KernelAdjudicationDecision = KernelPreflightDecision & {
  classification: ProtocolClassification;
  decisionRecord: DecisionRecord;
  canExecute: boolean;
  canContinueResolution: boolean;
};

export function eventsForKernelAdjudication({
  requestText,
  decision,
  occurredAt,
}: {
  requestText: string;
  decision: KernelAdjudicationDecision;
  occurredAt: string;
}): ChuckEvent[] {
  return chainChuckEvents([
    {
      eventId: `${decision.decisionRecord.runId}:prompt`,
      type: "prompt.received",
      occurredAt,
      runId: decision.decisionRecord.runId,
      payload: { text: requestText },
    },
    {
      eventId: `${decision.decisionRecord.runId}:stake`,
      type: "stake.classified",
      occurredAt,
      runId: decision.decisionRecord.runId,
      payload: {
        stakeClass: decision.assessment.stakeClass,
        taskClass: decision.assessment.taskClass,
        reasons: decision.assessment.reasons,
      },
    },
    {
      eventId: `${decision.decisionRecord.runId}:preflight`,
      type: "preflight.evaluated",
      occurredAt,
      runId: decision.decisionRecord.runId,
      payload: {
        admitted: decision.preflight.admitted,
        degradedMode: decision.preflight.degradedMode,
        validFamilies: decision.preflight.validFamilies,
        reasons: decision.preflight.reasons,
      },
    },
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

export function evaluateKernelPreflight({
  requestText,
  config = DEFAULT_CHUCK_CONFIG,
  health,
  resources,
  activeFleetRuns,
  sovereigntyCritical = false,
}: {
  requestText: string;
  config?: ChuckConfig;
  health?: WorkerHealthSnapshot;
  resources?: MachineResourceSnapshot;
  activeFleetRuns?: number;
  sovereigntyCritical?: boolean;
}): KernelPreflightDecision {
  const assessment = assessStake(requestText);
  const preflight = preflightAdmission({
    config,
    health,
    resources,
    activeFleetRuns,
    stakeClass: assessment.stakeClass,
    sovereigntyCritical,
  });
  const reasons = [...assessment.reasons, ...preflight.reasons];

  if (!preflight.admitted) {
    return {
      assessment,
      preflight,
      disposition: "halt",
      finalAction: "operator-halt",
      canProceed: false,
      operatorActionRequired: true,
      reasons,
    };
  }

  if (assessment.requiresOperatorApproval) {
    return {
      assessment,
      preflight,
      disposition: "operator-approval-required",
      finalAction: "operator-approval-required",
      canProceed: false,
      operatorActionRequired: true,
      reasons,
    };
  }

  if (assessment.stakeClass === "trivial") {
    return {
      assessment,
      preflight,
      disposition: "route-single-model",
      finalAction: "single-model-response",
      canProceed: true,
      operatorActionRequired: false,
      reasons,
    };
  }

  return {
    assessment,
    preflight,
    disposition: "route-fleet",
    finalAction: "emit-task-capsule",
    canProceed: true,
    operatorActionRequired: false,
    reasons,
  };
}

export function evaluateKernelAdjudication({
  requestText,
  config = DEFAULT_CHUCK_CONFIG,
  health,
  resources,
  activeFleetRuns,
  sovereigntyCritical = false,
  receipts,
  claims,
  alignmentMatrix,
  adjudicatorFamily,
  hasDeterministicVerifier = false,
  operatorApproved = false,
  intraFamilyFractures = [],
  efficiencyDecisionId,
  runId,
}: {
  requestText: string;
  config?: ChuckConfig;
  health?: WorkerHealthSnapshot;
  resources?: MachineResourceSnapshot;
  activeFleetRuns?: number;
  sovereigntyCritical?: boolean;
  receipts: RunnerReceipt[];
  claims: Claim[];
  alignmentMatrix: AlignmentMatrix;
  adjudicatorFamily: ChuckFamily;
  hasDeterministicVerifier?: boolean;
  operatorApproved?: boolean;
  intraFamilyFractures?: IntraFamilyFracture[];
  efficiencyDecisionId?: string;
  runId: string;
}): KernelAdjudicationDecision {
  const preflightDecision = evaluateKernelPreflight({
    requestText,
    config,
    health,
    resources,
    activeFleetRuns,
    sovereigntyCritical,
  });
  const receiptReport = summarizeReceiptInvariants(receipts);
  const configuredFamilyCount = new Set(config.fleet.map((entry) => entry.family)).size;
  const impersonationDetected =
    receiptReport.impersonatedReceipts.length > 0 ||
    receipts.some((receipt) => isImpersonatedReceipt(receipt));
  const classification = classifyProtocol({
    configuredFleetSize: configuredFamilyCount,
    validFamilyCount: receiptReport.validFamilies.length,
    alignmentMatrix,
    stakeClass: preflightDecision.assessment.stakeClass,
    impersonationDetected,
    hasDeterministicVerifier,
    intraFamilyFractureDetected: intraFamilyFractures.some(
      (fracture) => fracture.operatorActionRequired,
    ),
  });
  const operatorActionRequired = classification.operatorActionRequired && !operatorApproved;
  const finalAction = finalActionAfterApproval(classification.finalAction, operatorApproved);
  const disposition = dispositionForFinalAction(finalAction, operatorActionRequired);
  const canContinueResolution =
    preflightDecision.preflight.admitted &&
    !operatorActionRequired &&
    (finalAction === "red-team-outlier" || finalAction === "fork-to-verifier");
  const canExecute =
    preflightDecision.preflight.admitted &&
    !operatorActionRequired &&
    (finalAction === "emit-task-capsule" || finalAction === "single-model-response");
  const decisionRecord = decisionRecordFromParts({
    runId,
    stakeClass: preflightDecision.assessment.stakeClass,
    taskClass: preflightDecision.assessment.taskClass,
    configuredFleetSize: configuredFamilyCount,
    adjudicatorFamily,
    receipts,
    claims,
    alignmentMatrix,
    protocol: classification.protocol,
    finalAction,
    operatorActionRequired,
    confidenceLabel: classification.confidenceLabel,
    intraFamilyFractures,
    resourceSnapshot: resources,
    efficiencyDecisionId,
  });

  return {
    ...preflightDecision,
    classification,
    decisionRecord,
    disposition,
    finalAction,
    canProceed: preflightDecision.preflight.admitted && !operatorActionRequired,
    canExecute,
    canContinueResolution,
    operatorActionRequired,
    reasons: [...preflightDecision.reasons, classification.reason],
  };
}

function finalActionAfterApproval(
  finalAction: FinalAction,
  operatorApproved: boolean,
): FinalAction {
  if (finalAction === "operator-approval-required" && operatorApproved) {
    return "emit-task-capsule";
  }
  return finalAction;
}

function dispositionForFinalAction(
  finalAction: FinalAction,
  operatorActionRequired: boolean,
): KernelDisposition {
  switch (finalAction) {
    case "single-model-response":
      return "route-single-model";
    case "emit-task-capsule":
      return "execute";
    case "fork-to-verifier":
    case "red-team-outlier":
      return "continue-resolution";
    case "operator-approval-required":
      return "operator-approval-required";
    case "operator-halt":
      return "halt";
    case "refuse":
      return "refuse";
  }
  if (operatorActionRequired) {
    return "operator-approval-required";
  }
  return "halt";
}
