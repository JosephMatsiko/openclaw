import { createHmac, randomUUID } from "node:crypto";
import type { AuthorityDiff, RunnerReceipt, StakeClass } from "./types.js";

export type IntentAuthorityEnvelope = "advisory" | "dry-run" | "authority-bearing";

export type IntentAnchor = {
  anchorId: string;
  objective: string;
  allowedResources: string[];
  allowedSurfaces: string[];
  authorityEnvelope: IntentAuthorityEnvelope;
  stakeClass: StakeClass;
  createdAt: string;
  expiresAt: string;
  operatorApprovalRequired: boolean;
  reasons: string[];
  signature: string;
};

export type CreateIntentAnchorInput = {
  objective: string;
  allowedResources?: string[];
  allowedSurfaces?: string[];
  authorityEnvelope: IntentAuthorityEnvelope;
  stakeClass: StakeClass;
  createdAt?: string;
  expiresAt?: string;
  operatorApprovalRequired?: boolean;
  reasons?: string[];
  signingSecret: string;
};

export function createIntentAnchor({
  objective,
  allowedResources = [],
  allowedSurfaces = [],
  authorityEnvelope,
  stakeClass,
  createdAt = new Date().toISOString(),
  expiresAt = new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString(),
  operatorApprovalRequired = false,
  reasons = [],
  signingSecret,
}: CreateIntentAnchorInput): IntentAnchor {
  const unsigned = {
    anchorId: `intent-${randomUUID()}`,
    objective,
    allowedResources: [...new Set(allowedResources)].toSorted(),
    allowedSurfaces: [...new Set(allowedSurfaces)].toSorted(),
    authorityEnvelope,
    stakeClass,
    createdAt,
    expiresAt,
    operatorApprovalRequired,
    reasons: [...new Set(reasons)].toSorted(),
  };
  return {
    ...unsigned,
    signature: signIntentAnchorPayload(unsigned, signingSecret),
  };
}

export function verifyIntentAnchor(anchor: IntentAnchor, signingSecret: string): boolean {
  const { signature, ...unsigned } = anchor;
  return signature === signIntentAnchorPayload(unsigned, signingSecret);
}

export function intentAnchorForBuilderRun({
  objective,
  targetFiles,
  receipts = [],
  authorityDiff,
  patchPresent,
  createdAt,
  signingSecret,
}: {
  objective: string;
  targetFiles: string[];
  receipts?: RunnerReceipt[];
  authorityDiff: AuthorityDiff;
  patchPresent: boolean;
  createdAt: string;
  signingSecret: string;
}): IntentAnchor {
  const operatorApprovalRequired =
    authorityDiff.operatorApprovalRequired || authorityDiff.riskClass === "destructive";
  return createIntentAnchor({
    objective,
    allowedResources: targetFiles,
    allowedSurfaces: receipts.map((receipt) => receipt.surface),
    authorityEnvelope: patchPresent ? "authority-bearing" : "dry-run",
    stakeClass: patchPresent ? "high-mutating" : "medium",
    createdAt,
    operatorApprovalRequired,
    reasons: authorityDiff.reasons,
    signingSecret,
  });
}

export function intentAnchorForFleetRun({
  objective,
  allowedSurfaces,
  stakeClass,
  createdAt = new Date().toISOString(),
  signingSecret,
}: {
  objective: string;
  allowedSurfaces: string[];
  stakeClass: StakeClass;
  createdAt?: string;
  signingSecret: string;
}): IntentAnchor {
  return createIntentAnchor({
    objective,
    allowedResources: [],
    allowedSurfaces,
    authorityEnvelope:
      stakeClass === "trivial" || stakeClass === "medium" || stakeClass === "high-readonly"
        ? "advisory"
        : "authority-bearing",
    stakeClass,
    createdAt,
    operatorApprovalRequired: stakeClass === "destructive",
    reasons:
      stakeClass === "destructive" ? ["destructive stake requires explicit operator approval"] : [],
    signingSecret,
  });
}

function signIntentAnchorPayload(
  anchor: Omit<IntentAnchor, "signature">,
  signingSecret: string,
): string {
  return createHmac("sha256", signingSecret)
    .update(
      JSON.stringify({
        anchorId: anchor.anchorId,
        objective: anchor.objective,
        allowedResources: anchor.allowedResources,
        allowedSurfaces: anchor.allowedSurfaces,
        authorityEnvelope: anchor.authorityEnvelope,
        stakeClass: anchor.stakeClass,
        createdAt: anchor.createdAt,
        expiresAt: anchor.expiresAt,
        operatorApprovalRequired: anchor.operatorApprovalRequired,
        reasons: anchor.reasons,
      }),
    )
    .digest("hex");
}
