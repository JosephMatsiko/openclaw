import { isExternallyVerifiableEvidence } from "./evidence.js";
import type { EvidenceClass } from "./types.js";

export type VaultWriteDecision = {
  allowedToCommit: boolean;
  proposalOnly: boolean;
  requiresOperatorApproval: boolean;
  reason: string;
};

export function evaluateVaultWrite({
  operatorApproved = false,
  fleetRecommended = false,
}: {
  operatorApproved?: boolean;
  fleetRecommended?: boolean;
}): VaultWriteDecision {
  if (operatorApproved) {
    return {
      allowedToCommit: true,
      proposalOnly: false,
      requiresOperatorApproval: false,
      reason: fleetRecommended
        ? "operator approved fleet-recommended doctrine change"
        : "operator approved doctrine change",
    };
  }
  return {
    allowedToCommit: false,
    proposalOnly: true,
    requiresOperatorApproval: true,
    reason: fleetRecommended
      ? "fleet recommendation remains proposal until operator approval"
      : "Vault writes require operator approval",
  };
}

export function vaultCanResolveConflictAgainst(evidenceClass: EvidenceClass): boolean {
  return !isExternallyVerifiableEvidence(evidenceClass);
}
