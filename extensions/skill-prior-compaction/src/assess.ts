// Per-delta assessment + per-claim deferral reasons. Pure functions.

import { join } from "node:path";
import type { PriorCompactionConfig } from "./config.js";
import { evidenceRefsFor } from "./promote.js";
import type { DeferredClaim, DocketTask, PosteriorDeltaInput } from "./types.js";
import { cleanClaimText, pathExists, readJson, truncate } from "./util.js";

export interface AssessmentResult {
  eligible: boolean;
  reasons: string[];
}

export function assessDelta(delta: PosteriorDeltaInput | null | undefined): AssessmentResult {
  const reasons: string[] = [];
  if (!delta || delta.schemaVersion !== "chuck.posterior-delta.v1") {
    reasons.push("invalid posterior delta schema version");
  }
  if (!delta?.deltaId) reasons.push("missing delta id");
  if (!Array.isArray(delta?.evidence) || delta!.evidence!.length === 0) {
    reasons.push("missing evidence pointers");
  }
  if (!Array.isArray(delta?.claims) || delta!.claims!.length === 0) {
    reasons.push("missing claims");
  }
  if (delta?.authorityImpact === "blocked") reasons.push("authority impact is blocked");
  if (Array.isArray(delta?.dissent) && delta!.dissent!.length > 0) {
    reasons.push("delta carries dissent sidecar");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function claimDeferralReason(
  delta: PosteriorDeltaInput,
  claim: { text?: string; status?: string; dissentRefs?: string[] } | null,
  deltaReasons: string[],
): string | null {
  if (deltaReasons.length > 0) return deltaReasons.join("; ");
  if (!claim || typeof claim.text !== "string" || !claim.text.trim())
    return "claim text is missing";
  const status = String(claim.status ?? "").toLowerCase();
  if (["contested", "retracted"].includes(status)) return `claim status is ${claim.status}`;
  if (Array.isArray(claim.dissentRefs) && claim.dissentRefs.length > 0) {
    return "claim has dissent references";
  }
  return null;
}

export function docketTaskForDelta(
  delta: PosteriorDeltaInput,
  config: PriorCompactionConfig,
): DocketTask | null {
  const taskId = typeof delta?.taskId === "string" ? delta.taskId : null;
  if (!taskId) return null;
  const path = join(config.docketDir, `${taskId}.json`);
  if (!pathExists(path)) return null;
  try {
    return readJson<DocketTask>(path);
  } catch {
    return null;
  }
}

export function receiptOnlyDeferralReason(
  delta: PosteriorDeltaInput,
  config: PriorCompactionConfig,
): string | null {
  const docketTask = docketTaskForDelta(delta, config);
  const text = [
    delta?.taskId,
    delta?.taskTitle,
    delta?.title,
    delta?.intent,
    delta?.taskIntent,
    docketTask?.title,
    docketTask?.ledgerIntent,
    docketTask?.intent,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text.includes("read canary") && !text.includes("read-canary")) return null;
  return "receipt-only read canary; preserve source delta/read marker, but do not promote canary observations into compact prior claims";
}

export function deferredClaim(
  delta: PosteriorDeltaInput,
  claim: {
    claimId?: string;
    text?: string;
    confidence?: PosteriorDeltaInput["confidence"];
    evidenceRefs?: string[];
  },
  reason: string,
): DeferredClaim {
  return {
    claimId: claim?.claimId ?? `${delta.deltaId}:claim-unknown`,
    text: truncate(cleanClaimText(claim?.text ?? `Delta ${delta.deltaId} was deferred.`), 500),
    sourceDeltaId: delta.deltaId ?? "delta-unknown",
    family: delta.producer?.family ?? null,
    surface: delta.producer?.surface ?? null,
    confidence: claim?.confidence ?? delta.confidence ?? "low",
    authorityImpact: delta.authorityImpact ?? "none",
    evidenceRefs: evidenceRefsFor(delta, claim),
    reason,
  };
}

export function deferredClaimForDelta(delta: PosteriorDeltaInput, reason: string): DeferredClaim {
  return {
    claimId: `${delta.deltaId ?? "delta-unknown"}:delta`,
    text: `Delta ${delta.deltaId ?? "unknown"} could not be promoted mechanically.`,
    sourceDeltaId: delta.deltaId ?? "delta-unknown",
    family: delta.producer?.family ?? null,
    surface: delta.producer?.surface ?? null,
    confidence: delta.confidence ?? "low",
    authorityImpact: delta.authorityImpact ?? "none",
    evidenceRefs: evidenceRefsFor(delta, null),
    reason,
  };
}
