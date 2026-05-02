// Claim promotion + status/confidence/authority strength helpers + dissent
// collection. Pure functions; tests cover edge cases.

import type {
  AuthorityImpact,
  ClaimStatus,
  Confidence,
  PosteriorDeltaInput,
  PromotedClaim,
} from "./types.js";
import { cleanClaimText, normalizeText, pushUnique, sha256 } from "./util.js";

const STATUS_ORDER: Record<string, number> = {
  retracted: 0,
  contested: 1,
  proposed: 2,
  supported: 3,
  "operator-resolved": 4,
};
const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const AUTHORITY_ORDER: Record<AuthorityImpact, number> = {
  none: 0,
  proposal: 1,
  "approval-required": 2,
  blocked: 3,
};

export function strongerStatus(
  a: ClaimStatus | string,
  b: ClaimStatus | string,
): ClaimStatus | string {
  return (STATUS_ORDER[b] ?? 0) > (STATUS_ORDER[a] ?? 0) ? b : a;
}

export function strongerConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER[b] > CONFIDENCE_ORDER[a] ? b : a;
}

export function strongerAuthorityImpact(a: AuthorityImpact, b: AuthorityImpact): AuthorityImpact {
  return AUTHORITY_ORDER[b] > AUTHORITY_ORDER[a] ? b : a;
}

export function evidenceRefsFor(
  delta: PosteriorDeltaInput,
  claim: { evidenceRefs?: string[] } | null,
): string[] {
  const refs = Array.isArray(claim?.evidenceRefs)
    ? (claim.evidenceRefs as string[]).filter(Boolean)
    : [];
  if (refs.length) return [...new Set(refs)];
  return (Array.isArray(delta?.evidence) ? delta.evidence : [])
    .map((entry) => entry?.evidenceId ?? "")
    .filter(Boolean) as string[];
}

export function collectDissentRefs(delta: PosteriorDeltaInput, out: Set<string>): void {
  for (const item of Array.isArray(delta?.dissent) ? delta.dissent : []) {
    if (item?.dissentId) out.add(item.dissentId);
  }
  for (const claim of Array.isArray(delta?.claims) ? delta.claims : []) {
    for (const ref of Array.isArray(claim?.dissentRefs) ? claim.dissentRefs : []) {
      if (ref) out.add(ref);
    }
  }
}

export function collectStrings(values: unknown[], out: Set<string>): void {
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "").trim();
    if (text) out.add(text);
  }
}

export function promoteClaim(
  map: Map<string, PromotedClaim>,
  delta: PosteriorDeltaInput,
  claim: {
    text?: string;
    status?: string;
    confidence?: Confidence;
    claimId?: string;
    evidenceRefs?: string[];
  },
): void {
  const text = cleanClaimText(claim.text);
  const key = `claim-${sha256(normalizeText(text)).slice(0, 12)}`;
  const evidenceRefs = evidenceRefsFor(delta, claim);
  if (!map.has(key)) {
    map.set(key, {
      claimKey: key,
      text,
      status: claim.status ?? "supported",
      confidence: claim.confidence ?? delta.confidence ?? "low",
      authorityImpact: delta.authorityImpact ?? "none",
      families: [],
      surfaces: [],
      sourceDeltaIds: [],
      sourceClaimIds: [],
      evidenceRefs: [],
    });
  }
  const entry = map.get(key);
  if (!entry) return;
  entry.status = strongerStatus(entry.status, claim.status ?? "supported");
  entry.confidence = strongerConfidence(
    entry.confidence,
    claim.confidence ?? delta.confidence ?? "low",
  );
  entry.authorityImpact = strongerAuthorityImpact(
    entry.authorityImpact,
    delta.authorityImpact ?? "none",
  );
  pushUnique(entry.families, delta.producer?.family ?? "unknown");
  pushUnique(entry.surfaces, delta.producer?.surface ?? "unknown");
  pushUnique(entry.sourceDeltaIds, delta.deltaId ?? "");
  pushUnique(entry.sourceClaimIds, claim.claimId ?? `${delta.deltaId}:claim-unknown`);
  for (const ref of evidenceRefs) pushUnique(entry.evidenceRefs, ref);
}
