import { createHmac, randomUUID } from "node:crypto";
import { summarizeReceiptInvariants } from "./receipt.js";
import { surfaceReceiptsFromRunnerReceipts } from "./surfaces.js";
import type {
  AlignmentMatrix,
  ChuckFamily,
  Claim,
  ConfidenceLabel,
  DecisionRecord,
  EvidenceClass,
  FinalAction,
  IntraFamilyFracture,
  MachineResourceSnapshot,
  OperatorAttentionCost,
  ProtectedPathVerdict,
  Protocol,
  RunnerReceipt,
  SandboxPolicy,
  StakeClass,
  TaskCapsule,
  TaskClass,
} from "./types.js";

export function decisionRecordFromParts({
  runId,
  stakeClass,
  taskClass,
  configuredFleetSize,
  adjudicatorFamily,
  receipts,
  claims,
  alignmentMatrix,
  protocol,
  finalAction,
  operatorActionRequired,
  confidenceLabel,
  intraFamilyFractures = [],
  authorityDiffId,
  resourceSnapshot,
  operatorAttentionCost,
  efficiencyDecisionId,
}: {
  runId: string;
  stakeClass: StakeClass;
  taskClass: TaskClass;
  configuredFleetSize: number;
  adjudicatorFamily: ChuckFamily;
  receipts: RunnerReceipt[];
  claims: Claim[];
  alignmentMatrix: AlignmentMatrix;
  protocol: Protocol;
  finalAction: FinalAction;
  operatorActionRequired: boolean;
  confidenceLabel: ConfidenceLabel;
  intraFamilyFractures?: IntraFamilyFracture[];
  authorityDiffId?: string;
  resourceSnapshot?: MachineResourceSnapshot;
  operatorAttentionCost?: OperatorAttentionCost;
  efficiencyDecisionId?: string;
}): DecisionRecord {
  const receiptReport = summarizeReceiptInvariants(receipts);
  const validFamilyCount = receiptReport.validFamilies.length;
  const degradedMode =
    validFamilyCount < 3
      ? "INCOMPLETE"
      : validFamilyCount >= configuredFleetSize
        ? "FULL"
        : (`DEGRADED-${validFamilyCount}` as const);
  return {
    runId,
    stakeClass,
    taskClass,
    configuredFleetSize,
    validVoiceCount: receiptReport.validReceipts.length,
    validFamilyCount,
    degradedMode,
    adjudicatorFamily,
    receipts,
    surfaceReceipts: surfaceReceiptsFromRunnerReceipts(receipts),
    intraFamilyFractures,
    claims,
    alignmentMatrix,
    protocol,
    evidenceCited: [...new Set(claims.map((c) => c.evidenceClass))] as EvidenceClass[],
    vaultDoctrineCited: [...new Set(claims.flatMap((c) => c.vaultNodes))],
    authorityDiffId,
    resourceSnapshot,
    operatorAttentionCost,
    efficiencyDecisionId,
    operatorActionRequired,
    finalAction,
    confidenceLabel,
  };
}

export type CreateTaskCapsuleInput = {
  decisionRecordId: string;
  actionPlan: string[];
  allowedTools: string[];
  filesystemScope: TaskCapsule["filesystemScope"];
  networkScope: TaskCapsule["networkScope"];
  externalFootprintId?: string;
  leashId?: string;
  sandboxPolicy?: SandboxPolicy;
  protectedPathVerdict?: ProtectedPathVerdict;
  verifier?: string;
  rollbackPlan?: string[];
  expiresAt: string;
  signingSecret: string;
};

export function createTaskCapsule({
  decisionRecordId,
  actionPlan,
  allowedTools,
  filesystemScope,
  networkScope,
  externalFootprintId,
  leashId,
  sandboxPolicy = {
    runtime: "ephemeral-worktree",
    filesystem: filesystemScope === "none" ? "none" : "ephemeral",
    network: networkScope,
    denyRun: true,
  },
  protectedPathVerdict = "clear",
  verifier,
  rollbackPlan,
  expiresAt,
  signingSecret,
}: CreateTaskCapsuleInput): TaskCapsule {
  const capsuleId = `capsule-${randomUUID()}`;
  const unsigned = {
    capsuleId,
    decisionRecordId,
    actionPlan,
    allowedTools,
    filesystemScope,
    networkScope,
    externalFootprintId: externalFootprintId ?? null,
    leashId: leashId ?? null,
    sandboxPolicy,
    protectedPathVerdict,
    verifier: verifier ?? null,
    rollbackPlan: rollbackPlan ?? null,
    expiresAt,
  };
  const signature = createHmac("sha256", signingSecret)
    .update(JSON.stringify(unsigned))
    .digest("hex");
  return {
    capsuleId,
    decisionRecordId,
    actionPlan,
    allowedTools,
    filesystemScope,
    networkScope,
    externalFootprintId,
    leashId,
    sandboxPolicy,
    protectedPathVerdict,
    verifier,
    rollbackPlan,
    expiresAt,
    signature,
  };
}
