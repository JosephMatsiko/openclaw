import { randomUUID } from "node:crypto";

export type PerplexityLeaseStatus =
  | "active"
  | "completed"
  | "expired"
  | "needs-attention"
  | "failed";

export type PerplexityEntitlementStatus = "verified-max" | "verified-paid" | "free" | "unknown";

export type PerplexityIncognitoState = "ON" | "OFF" | "UNKNOWN";

export type PerplexitySessionLease = {
  leaseId: string;
  runId: string;
  surface: "perplexity/mac-app";
  mode: "research" | "labs" | "create";
  status: PerplexityLeaseStatus;
  incognitoRequired: true;
  incognitoVerified: boolean;
  originalIncognitoState: PerplexityIncognitoState;
  entitlementStatus: PerplexityEntitlementStatus;
  entitlementSource: "local-accessibility" | "local-ocr" | "manual" | "unknown";
  startedAt: string;
  lastObservedAt: string;
  expiresAt?: string;
  transcriptPath?: string;
  receiptId?: string;
  reasons: string[];
};

export type PerplexityLeaseDecision = {
  action: "reuse-active-lease" | "start-new-incognito-lease" | "needs-attention";
  lease?: PerplexitySessionLease;
  incognitoRequired: true;
  entitlementStatus: PerplexityEntitlementStatus;
  reasons: string[];
};

export function createPerplexitySessionLease({
  runId,
  now = new Date().toISOString(),
  mode = "research",
  originalIncognitoState = "UNKNOWN",
  incognitoVerified = false,
  entitlementStatus = "unknown",
  entitlementSource = "unknown",
  transcriptPath,
  receiptId,
  leaseId = `pplx-lease-${randomUUID()}`,
  expiresAt,
  reasons = [],
}: {
  runId: string;
  now?: string;
  mode?: PerplexitySessionLease["mode"];
  originalIncognitoState?: PerplexityIncognitoState;
  incognitoVerified?: boolean;
  entitlementStatus?: PerplexityEntitlementStatus;
  entitlementSource?: PerplexitySessionLease["entitlementSource"];
  transcriptPath?: string;
  receiptId?: string;
  leaseId?: string;
  expiresAt?: string;
  reasons?: string[];
}): PerplexitySessionLease {
  return {
    leaseId,
    runId,
    surface: "perplexity/mac-app",
    mode,
    status: incognitoVerified ? "active" : "needs-attention",
    incognitoRequired: true,
    incognitoVerified,
    originalIncognitoState,
    entitlementStatus,
    entitlementSource,
    startedAt: now,
    lastObservedAt: now,
    expiresAt,
    transcriptPath,
    receiptId,
    reasons: [
      "Perplexity shared-Max native/Comet profile is driven in Incognito for account-profile isolation",
      ...reasons,
      ...(entitlementStatus === "unknown"
        ? ["Perplexity entitlement is unknown; do not report Max as verified"]
        : []),
    ],
  };
}

export function choosePerplexityLease({
  activeLeases = [],
  now = new Date().toISOString(),
  entitlementStatus = "unknown",
  requestedMode = "research",
}: {
  activeLeases?: PerplexitySessionLease[];
  now?: string;
  entitlementStatus?: PerplexityEntitlementStatus;
  requestedMode?: PerplexitySessionLease["mode"];
} = {}): PerplexityLeaseDecision {
  const reusable = activeLeases.find(
    (lease) =>
      lease.status === "active" &&
      lease.incognitoRequired &&
      lease.incognitoVerified &&
      lease.mode === requestedMode &&
      !isExpired(lease, now),
  );
  if (reusable) {
    return {
      action: "reuse-active-lease",
      lease: { ...reusable, lastObservedAt: now },
      incognitoRequired: true,
      entitlementStatus: reusable.entitlementStatus,
      reasons: [`reusing active Perplexity Incognito lease ${reusable.leaseId}`],
    };
  }
  if (entitlementStatus === "free") {
    return {
      action: "needs-attention",
      incognitoRequired: true,
      entitlementStatus,
      reasons: [
        "Perplexity account appears free; Max/Paid entitlement must be confirmed before relying on it",
      ],
    };
  }
  return {
    action: "start-new-incognito-lease",
    incognitoRequired: true,
    entitlementStatus,
    reasons: ["no reusable Perplexity Incognito lease found; start a new lease"],
  };
}

export function completePerplexityLease({
  lease,
  now = new Date().toISOString(),
}: {
  lease: PerplexitySessionLease;
  now?: string;
}): PerplexitySessionLease {
  return {
    ...lease,
    status: "completed",
    lastObservedAt: now,
    reasons: [...lease.reasons, "lease completed by Chuck"],
  };
}

export function shouldRestorePerplexityIncognito({
  closingLease,
  activeLeases = [],
}: {
  closingLease: PerplexitySessionLease;
  activeLeases?: PerplexitySessionLease[];
}): boolean {
  if (closingLease.originalIncognitoState !== "OFF") {
    return false;
  }
  return !activeLeases.some(
    (lease) =>
      lease.leaseId !== closingLease.leaseId &&
      lease.status === "active" &&
      lease.incognitoRequired,
  );
}

function isExpired(lease: PerplexitySessionLease, now: string): boolean {
  return (
    lease.expiresAt !== undefined && new Date(lease.expiresAt).getTime() <= new Date(now).getTime()
  );
}
