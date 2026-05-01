// Schema-level invariants for @openclaw/plugin-memory-graph-prior-delta.
//
// These are "structural protections" — the plugin rejects mutations that
// violate them at the validator layer, not as policy guidelines an auditor
// must catch later.
//
// The four invariants from prior-delta-schema.md:
//
//   1. Append-only — prior-capsule, posterior-delta, compaction-record,
//      dissent-record all immutable after insert.
//
//   2. Compaction cannot drop dissent — a CompactionRecord that omits any
//      dissent id from its constituent deltas is rejected at validation.
//
//   3. Three-signature compaction — proposer + approver + signer must all
//      be distinct voice ids.
//
//   4. (Implicit, validated alongside 3) Cross-family discipline — the
//      approver's family must differ from the majority contributor family.

import {
  APPEND_ONLY_NODE_TYPES,
  type AppendOnlyNodeType,
  type CompactionRecord,
  type PosteriorDelta,
  type VoiceFamily,
} from "./types.js";

export class SchemaViolation extends Error {
  constructor(
    public readonly invariant: string,
    message: string,
  ) {
    super(`schema-violation[${invariant}]: ${message}`);
    this.name = "SchemaViolation";
  }
}

export type GraphMutation =
  | {
      kind: "INSERT";
      target: { type: string; id: string; [k: string]: unknown };
    }
  | {
      kind: "UPDATE";
      target: { type: string; id: string; [k: string]: unknown };
      patch?: Record<string, unknown>;
    }
  | { kind: "DELETE"; target: { type: string; id: string } };

/**
 * Invariant 1: append-only nodes reject UPDATE / DELETE.
 *
 * Exception: prior-capsule.read_markers is monotonically-growing metadata
 * and may be updated; everything else is immutable.
 */
export function validateAppendOnly(mutation: GraphMutation): void {
  const targetType = mutation.target.type;
  if (!APPEND_ONLY_NODE_TYPES.includes(targetType as AppendOnlyNodeType)) {
    return;
  }
  if (mutation.kind === "INSERT") return;
  if (
    mutation.kind === "UPDATE" &&
    targetType === "prior-capsule" &&
    mutation.patch &&
    Object.keys(mutation.patch).every((k) => k === "read_markers")
  ) {
    return;
  }
  throw new SchemaViolation(
    "append-only",
    `cannot ${mutation.kind} on append-only node type ${targetType}`,
  );
}

/**
 * Invariant 2: a CompactionRecord must preserve every dissent id from
 * every delta it folds in.
 *
 * `removedDeltas` is the materialized set of deltas the compaction is
 * folding in (typically loaded by the caller from the host graph using
 * the record's `removed_delta_ids`).
 */
export function validateCompactionPreservesDissent(
  record: CompactionRecord,
  removedDeltas: ReadonlyArray<PosteriorDelta>,
): void {
  const preserved = new Set(record.preserved_dissent_ids);
  for (const delta of removedDeltas) {
    for (const dissent of delta.dissent) {
      if (!preserved.has(dissent.id)) {
        throw new SchemaViolation(
          "compaction-preserves-dissent",
          `compaction ${record.id} would drop dissent ${dissent.id} from delta ${delta.id}`,
        );
      }
    }
  }
}

/**
 * Invariant 3: three distinct signatures.
 */
export function validateThreeSignatures(record: CompactionRecord): void {
  const { proposer, approver, signer } = record;
  if (!proposer || !approver || !signer) {
    throw new SchemaViolation(
      "three-signature-compaction",
      "compaction requires proposer + approver + signer (none may be empty)",
    );
  }
  if (proposer === approver) {
    throw new SchemaViolation(
      "three-signature-compaction",
      `proposer (${proposer}) must differ from approver`,
    );
  }
  if (approver === signer) {
    throw new SchemaViolation(
      "three-signature-compaction",
      `approver (${approver}) must differ from signer`,
    );
  }
  if (proposer === signer) {
    throw new SchemaViolation(
      "three-signature-compaction",
      `proposer (${proposer}) must differ from signer`,
    );
  }
}

export interface CrossFamilyContext {
  /** Map from voice id to family. Caller supplies; we don't reach into the host graph. */
  voiceFamilies: Record<string, VoiceFamily>;
}

/**
 * Invariant 4: cross-family discipline — the approver must NOT share family
 * with the majority contributor.
 *
 * `removedDeltas` provides the contributor families. `ctx.voiceFamilies`
 * is required to resolve `record.approver` to its family — the schema
 * itself doesn't carry approver-family because voice family registry
 * lives in skill-panel-ask. Callers wire the registry in.
 */
export function validateCrossFamilyDiscipline(
  record: CompactionRecord,
  removedDeltas: ReadonlyArray<PosteriorDelta>,
  ctx: CrossFamilyContext,
): void {
  if (removedDeltas.length === 0) {
    // No contributors — cannot determine majority family; nothing to enforce.
    return;
  }
  const approverFamily = ctx.voiceFamilies[record.approver];
  if (!approverFamily) {
    throw new SchemaViolation(
      "cross-family-discipline",
      `approver voice ${record.approver} not present in voiceFamilies registry`,
    );
  }

  const familyVotes = new Map<VoiceFamily, number>();
  for (const delta of removedDeltas) {
    familyVotes.set(delta.family, (familyVotes.get(delta.family) ?? 0) + 1);
  }
  let majorityFamily: VoiceFamily | null = null;
  let majorityCount = 0;
  for (const [family, count] of familyVotes) {
    if (count > majorityCount) {
      majorityFamily = family;
      majorityCount = count;
    }
  }
  if (!majorityFamily) return;

  if (approverFamily === majorityFamily) {
    throw new SchemaViolation(
      "cross-family-discipline",
      `approver ${record.approver} (family ${approverFamily}) shares majority family ${majorityFamily}; pick a different approver`,
    );
  }
}

/**
 * Convenience: run all four invariants on a CompactionRecord at once.
 *
 * Use this in the prior_delta tool's compaction-propose / approve / sign
 * actions before persisting the record.
 */
export function validateCompaction(
  record: CompactionRecord,
  removedDeltas: ReadonlyArray<PosteriorDelta>,
  ctx: CrossFamilyContext,
): void {
  validateThreeSignatures(record);
  validateCompactionPreservesDissent(record, removedDeltas);
  validateCrossFamilyDiscipline(record, removedDeltas, ctx);
}
