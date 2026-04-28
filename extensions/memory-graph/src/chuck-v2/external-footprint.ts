import { createHash } from "node:crypto";
import type {
  ExternalDataClass,
  ExternalDestinationKind,
  ExternalFootprintAssessment,
  ExternalFootprintVerdict,
} from "./types.js";

export type ExternalFootprintInput = {
  destinationKind: ExternalDestinationKind;
  destination?: string;
  dataClasses?: ExternalDataClass[];
  operatorAuthorized?: boolean;
  accessEntitled?: boolean;
  payloadMinimized?: boolean;
  receiptPlanned?: boolean;
  localOrConnectorAlternativeAvailable?: boolean;
  attemptsBypass?: boolean;
  generatedAt?: string;
};

export function assessExternalFootprint(
  input: ExternalFootprintInput,
): ExternalFootprintAssessment {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const destination = input.destination ?? input.destinationKind;
  const dataClasses = [...new Set(input.dataClasses ?? ["none"])] as ExternalDataClass[];
  const reasons: string[] = [];
  const requiredMitigations: string[] = [];

  if (input.destinationKind === "none") {
    reasons.push("no external destination");
  }
  if (input.operatorAuthorized === false) {
    reasons.push("operator has not authorized this external destination");
  }
  if (input.accessEntitled === false) {
    reasons.push("access entitlement is missing or unverified");
  }
  if (input.attemptsBypass === true) {
    reasons.push("request attempts to bypass an external access control");
  }
  if (dataClasses.includes("credential")) {
    reasons.push("credential material must not be sent to external surfaces");
  }
  if (dataClasses.includes("full-local-archive")) {
    reasons.push("full local archives must not be sent to external surfaces");
  }
  if (input.payloadMinimized === false) {
    reasons.push("payload is not minimized");
    requiredMitigations.push(
      "minimize to the smallest prompt, span, or excerpt that can answer the task",
    );
  }
  if (input.receiptPlanned === false) {
    reasons.push("local receipt is not planned");
    requiredMitigations.push(
      "create a local receipt with destination, data classes, and transcript hash",
    );
  }
  if (input.localOrConnectorAlternativeAvailable === true && input.destinationKind !== "none") {
    reasons.push("local/cache/connector alternative exists");
    requiredMitigations.push(
      "prefer local, cache, or connector evidence before external submission",
    );
  }

  const verdict = verdictFor({
    destinationKind: input.destinationKind,
    dataClasses,
    operatorAuthorized: input.operatorAuthorized,
    accessEntitled: input.accessEntitled,
    payloadMinimized: input.payloadMinimized,
    receiptPlanned: input.receiptPlanned,
    localOrConnectorAlternativeAvailable: input.localOrConnectorAlternativeAvailable,
    attemptsBypass: input.attemptsBypass,
  });

  return {
    footprintId: footprintId({
      generatedAt,
      destinationKind: input.destinationKind,
      destination,
      dataClasses,
      verdict,
    }),
    generatedAt,
    destinationKind: input.destinationKind,
    destination,
    dataClasses,
    verdict,
    networkScope:
      verdict === "local-only" || verdict === "blocked" || verdict === "route-local-first"
        ? "deny"
        : "allowlisted",
    operatorApprovalRequired: verdict === "needs-approval",
    receiptRequired: verdict !== "local-only",
    externalTraceMinimizationRequired: verdict !== "local-only",
    reasons,
    requiredMitigations,
  };
}

export function canUseExternalSurface(assessment: ExternalFootprintAssessment): boolean {
  return assessment.verdict === "allowed-minimized";
}

function verdictFor(input: {
  destinationKind: ExternalDestinationKind;
  dataClasses: ExternalDataClass[];
  operatorAuthorized?: boolean;
  accessEntitled?: boolean;
  payloadMinimized?: boolean;
  receiptPlanned?: boolean;
  localOrConnectorAlternativeAvailable?: boolean;
  attemptsBypass?: boolean;
}): ExternalFootprintVerdict {
  if (input.destinationKind === "none") {
    return "local-only";
  }
  if (
    input.attemptsBypass === true ||
    input.operatorAuthorized === false ||
    input.accessEntitled === false ||
    input.dataClasses.includes("credential") ||
    input.dataClasses.includes("full-local-archive")
  ) {
    return "blocked";
  }
  if (input.localOrConnectorAlternativeAvailable === true) {
    return "route-local-first";
  }
  if (input.payloadMinimized === false || input.receiptPlanned === false) {
    return "needs-approval";
  }
  return "allowed-minimized";
}

function footprintId(input: {
  generatedAt: string;
  destinationKind: ExternalDestinationKind;
  destination: string;
  dataClasses: ExternalDataClass[];
  verdict: ExternalFootprintVerdict;
}): string {
  return `footprint-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;
}
