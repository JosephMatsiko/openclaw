import { createHash } from "node:crypto";
import type {
  ChuckConfig,
  DocumentCitation,
  DocumentEvidenceRecord,
  DocumentEvidenceUnit,
  DocumentSourceKind,
  EvidenceClass,
} from "./types.js";

const DEFAULT_PRECEDENCE: EvidenceClass[] = [
  "deterministic-verifier",
  "runtime-trace",
  "primary-doc",
  "live-source",
  "repo-fact",
  "model-reasoning",
  "vault-doctrine",
  "unsourced",
];

export function evidenceRank(
  evidenceClass: EvidenceClass,
  precedence = DEFAULT_PRECEDENCE,
): number {
  const i = precedence.indexOf(evidenceClass);
  return i >= 0 ? i : precedence.length;
}

export function compareEvidence(
  left: EvidenceClass,
  right: EvidenceClass,
  precedence = DEFAULT_PRECEDENCE,
): number {
  return evidenceRank(left, precedence) - evidenceRank(right, precedence);
}

export function canVaultOverride(
  target: EvidenceClass,
  config: Pick<ChuckConfig, "evidencePolicy">,
): boolean {
  if (config.evidencePolicy.vaultMayOverruleExternalTruth) {
    return false;
  }
  return target === "model-reasoning" || target === "unsourced";
}

export function isExternallyVerifiableEvidence(evidenceClass: EvidenceClass): boolean {
  return [
    "deterministic-verifier",
    "runtime-trace",
    "primary-doc",
    "live-source",
    "repo-fact",
  ].includes(evidenceClass);
}

export function evidenceClassForDocumentSourceKind(sourceKind: DocumentSourceKind): EvidenceClass {
  switch (sourceKind) {
    case "repo-file":
      return "repo-fact";
    case "web-page":
      return "live-source";
    case "screenshot":
    case "transcript":
      return "runtime-trace";
    case "connector-export":
    case "generated-artifact":
    case "local-file":
    case "pdf":
      return "primary-doc";
  }
  return "model-reasoning";
}

export function sha256DocumentSourceText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function createDocumentEvidenceRecord(input: {
  sourceKind: DocumentSourceKind;
  sourcePathOrUrl: string;
  sourceText: string;
  units: DocumentEvidenceUnit[];
  ingestedAt?: string;
  contradictions?: DocumentEvidenceRecord["contradictions"];
  citationLog?: DocumentEvidenceRecord["citationLog"];
}): DocumentEvidenceRecord {
  const sourceHash = sha256DocumentSourceText(input.sourceText);
  return {
    recordId: `doc-evd-${sourceHash.slice("sha256:".length, "sha256:".length + 16)}`,
    sourceHash,
    sourceKind: input.sourceKind,
    sourcePathOrUrl: input.sourcePathOrUrl,
    ingestedAt: input.ingestedAt ?? new Date().toISOString(),
    units: input.units,
    contradictions: input.contradictions ?? [],
    citationLog: input.citationLog ?? [],
  };
}

export function validateDocumentEvidenceRecord(record: DocumentEvidenceRecord): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const unitIds = new Set<string>();

  if (!record.recordId.startsWith("doc-evd-")) {
    errors.push("recordId must start with doc-evd-");
  }
  if (!record.sourceHash.startsWith("sha256:")) {
    errors.push("sourceHash must be sha256-prefixed");
  }
  if (!record.sourcePathOrUrl.trim()) {
    errors.push("sourcePathOrUrl is required");
  }
  if (record.units.length === 0) {
    errors.push("at least one evidence unit is required");
  }

  for (const unit of record.units) {
    if (!unit.unitId.trim()) {
      errors.push("unitId is required");
      continue;
    }
    if (unitIds.has(unit.unitId)) {
      errors.push(`duplicate unitId: ${unit.unitId}`);
    }
    unitIds.add(unit.unitId);
    if (unit.spans.length === 0) {
      errors.push(`unit ${unit.unitId} must contain at least one span`);
    }

    const spanIds = new Set<string>();
    for (const span of unit.spans) {
      if (!span.spanId.trim()) {
        errors.push(`unit ${unit.unitId} has a span without spanId`);
        continue;
      }
      if (spanIds.has(span.spanId)) {
        errors.push(`duplicate spanId ${span.spanId} in unit ${unit.unitId}`);
      }
      spanIds.add(span.spanId);
      if (!span.text.trim()) {
        errors.push(`span ${span.spanId} in unit ${unit.unitId} has no text`);
      }
      if (
        span.startOffset !== undefined &&
        span.endOffset !== undefined &&
        span.endOffset < span.startOffset
      ) {
        errors.push(`span ${span.spanId} in unit ${unit.unitId} has invalid offsets`);
      }
    }
  }

  for (const citation of record.citationLog) {
    const result = verifyDocumentCitation(record, citation);
    if (!result.ok) {
      errors.push(
        ...result.errors.map((error) => `citation ${citation.decisionRecordId}:${error}`),
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function verifyDocumentCitation(
  record: DocumentEvidenceRecord,
  citation: DocumentCitation,
): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (citation.documentRecordId !== record.recordId) {
    errors.push("documentRecordId does not match record");
  }
  if (citation.sourceHash !== undefined && citation.sourceHash !== record.sourceHash) {
    errors.push("sourceHash does not match record");
  }

  const unit = record.units.find((candidate) => candidate.unitId === citation.unitId);
  if (!unit) {
    errors.push(`missing unit: ${citation.unitId}`);
    return { ok: false, errors };
  }

  const span = unit.spans.find((candidate) => candidate.spanId === citation.spanId);
  if (!span) {
    errors.push(`missing span: ${citation.spanId}`);
    return { ok: false, errors };
  }

  if (citation.quote !== undefined && !span.text.includes(citation.quote)) {
    errors.push("quote is not present in cited span");
  }

  return { ok: errors.length === 0, errors };
}

export function documentCitationToSourceSpan(
  record: DocumentEvidenceRecord,
  citation: DocumentCitation,
): {
  source: string;
  documentRecordId: string;
  unitId: string;
  spanId: string;
  quote?: string;
} {
  return {
    source: record.sourcePathOrUrl,
    documentRecordId: record.recordId,
    unitId: citation.unitId,
    spanId: citation.spanId,
    quote: citation.quote,
  };
}
