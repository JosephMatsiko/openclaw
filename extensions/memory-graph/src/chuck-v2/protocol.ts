import type { AlignmentMatrix, FinalAction, Protocol, StakeClass } from "./types.js";

export type ProtocolClassification = {
  protocol: Protocol;
  finalAction: FinalAction;
  operatorActionRequired: boolean;
  confidenceLabel: "none" | "low" | "medium" | "high-evidence-bounded" | "degraded";
  reason: string;
};

function sortedClusterSizes(alignmentMatrix: AlignmentMatrix): number[] {
  return alignmentMatrix.clusters.map((c) => new Set(c.familyVotes).size).toSorted((a, b) => b - a);
}

export function classifyProtocol({
  configuredFleetSize,
  validFamilyCount,
  alignmentMatrix,
  stakeClass,
  impersonationDetected = false,
  hasDeterministicVerifier = false,
  intraFamilyFractureDetected = false,
}: {
  configuredFleetSize: number;
  validFamilyCount: number;
  alignmentMatrix: AlignmentMatrix;
  stakeClass: StakeClass;
  impersonationDetected?: boolean;
  hasDeterministicVerifier?: boolean;
  intraFamilyFractureDetected?: boolean;
}): ProtocolClassification {
  if (impersonationDetected) {
    return {
      protocol: "IMPERSONATION_DETECTED",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      confidenceLabel: "none",
      reason: "actual runner family crossed requested family",
    };
  }
  if (validFamilyCount < 3) {
    return {
      protocol: "INCOMPLETE",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      confidenceLabel: "none",
      reason: "minimum fleet floor is 3 valid families",
    };
  }
  if (intraFamilyFractureDetected) {
    return {
      protocol: "INTRA_FAMILY_FRACTURE",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      confidenceLabel: "none",
      reason: "same-family surfaces produced opposing verdict or action",
    };
  }

  const sizes = sortedClusterSizes(alignmentMatrix);
  const top = sizes[0] ?? 0;
  const second = sizes[1] ?? 0;
  const minority = validFamilyCount - top;

  if (top === validFamilyCount) {
    return {
      protocol: "UNANIMOUS",
      finalAction:
        stakeClass === "destructive" ? "operator-approval-required" : "emit-task-capsule",
      operatorActionRequired: stakeClass === "destructive",
      confidenceLabel:
        validFamilyCount < configuredFleetSize ? "degraded" : "high-evidence-bounded",
      reason: "all valid families landed in the same claim cluster",
    };
  }

  if (validFamilyCount === 4 && top === 2 && second === 2) {
    return {
      protocol: "SCHISM",
      finalAction:
        hasDeterministicVerifier && stakeClass !== "destructive"
          ? "fork-to-verifier"
          : "operator-halt",
      operatorActionRequired: !(hasDeterministicVerifier && stakeClass !== "destructive"),
      confidenceLabel: "none",
      reason: "2-2 split is an epistemic schism",
    };
  }

  if (minority >= 2) {
    return {
      protocol: "DEEP_FRACTURE",
      finalAction:
        hasDeterministicVerifier && stakeClass !== "destructive"
          ? "fork-to-verifier"
          : "operator-halt",
      operatorActionRequired: !(hasDeterministicVerifier && stakeClass !== "destructive"),
      confidenceLabel: "none",
      reason: "minority block is large enough to reject simple majority",
    };
  }

  if (minority === 1 && top >= 2) {
    return {
      protocol: "OUTLIER",
      finalAction: "red-team-outlier",
      operatorActionRequired: false,
      confidenceLabel: validFamilyCount < configuredFleetSize ? "degraded" : "medium",
      reason: "single outlier preserved for premise validation and red-team rotation",
    };
  }

  return {
    protocol: "FRAGMENT",
    finalAction: "operator-halt",
    operatorActionRequired: true,
    confidenceLabel: "none",
    reason: "no stable majority cluster",
  };
}
