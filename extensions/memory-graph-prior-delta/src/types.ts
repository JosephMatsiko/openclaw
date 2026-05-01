// Public types for @openclaw/plugin-memory-graph-prior-delta.
//
// Mirrors the schema in
// `~/.openclaw/workspace/morning-summary/prior-delta-schema.md` (the
// design spec). Four node types and three edge types, all additive to the
// memory-graph plugin's existing SQLite store at
// `~/.openclaw/memory/graph.sqlite`.
//
// All four node types are append-only — the plugin rejects UPDATE / DELETE
// at the validator layer (see ./invariants.ts). The only allowed mutation
// is `prior-capsule.read_markers`, which is treated as monotonically
// growing metadata, not content.

export type VoiceFamily = "anthropic" | "openai" | "google" | "xai" | "perplexity" | "local";

export type VoiceSurface = "cli" | "web-chrome" | "native-app" | "api" | "local-runtime";

export type Reversibility = "trivial" | "reversible-with-effort" | "one-way";

export interface PriorReadMarker {
  voice_id: string;
  read_at: string; // ISO-8601
  delta_id: string; // delta the voice wrote against this prior
}

export interface PriorCapsule {
  type: "prior-capsule";
  id: string; // sha256(parent_hash + content + timestamp)
  parent_hash: string | null; // null = genesis
  content: {
    summary: string; // human-readable; 1-3 paragraphs
    claim_refs: string[]; // node IDs of claim nodes folded in
    dissent_refs: string[]; // node IDs of preserved dissents
    evidence_index: Record<string, string[]>; // claim_id -> [evidence node IDs]
  };
  generated_at: string; // ISO-8601
  generated_by: string; // voice ID or "compaction-ceremony"
  read_markers: Record<string, PriorReadMarker>;
}

export interface PosteriorDeltaClaim {
  id: string; // claim_<sha8>
  statement: string;
  confidence: number; // 0..1
  evidence_refs: string[];
}

export interface PosteriorDeltaDissent {
  id: string; // dissent_<sha8>
  against_claim_id: string; // claim being disputed
  rationale: string;
  counter_evidence_refs: string[];
}

export interface PosteriorDeltaProposedMutation {
  kind: "config" | "memory-graph" | "filesystem" | "channel";
  target: string;
  before_hash: string;
  after_hash: string;
  reversibility: Reversibility;
}

export interface PosteriorDelta {
  type: "posterior-delta";
  id: string; // sha256(prior_hash + voice_id + content + timestamp)
  prior_hash: string;
  voice_id: string;
  family: VoiceFamily;
  surface: VoiceSurface;
  generated_at: string;
  claims: PosteriorDeltaClaim[];
  dissent: PosteriorDeltaDissent[];
  proposed_mutations: PosteriorDeltaProposedMutation[];
  self_doubt_note: string | null;
}

export type CompactionProofMethod = "schema-check" | "lean-proof" | "test-suite-pass";

export interface CompactionRecord {
  type: "compaction-record";
  id: string;
  prior_hash_before: string;
  prior_hash_after: string;
  proposer: string; // voice_id (e.g. Compiler)
  approver: string; // voice_id (e.g. Court)
  signer: string; // voice_id (e.g. Notary)
  proposed_at: string;
  approved_at: string;
  signed_at: string;
  removed_delta_ids: string[];
  preserved_dissent_ids: string[];
  proof_of_equivalence: {
    method: CompactionProofMethod;
    artifact_hash: string;
  };
  rollback_pointer: string;
}

export interface DissentRecord {
  type: "dissent-record";
  id: string;
  delta_id: string;
  against_claim_id: string;
  rationale: string;
  counter_evidence_refs: string[];
  preserved_through_compactions: string[];
}

// Edges
export interface DeltaAgainstPriorEdge {
  type: "delta-against-prior";
  source: string; // PosteriorDelta id
  target: string; // PriorCapsule id
}

export interface DissentAgainstClaimEdge {
  type: "dissent-against-claim";
  source: string; // DissentRecord id
  target: string; // claim id (whatever the host graph uses)
}

export interface CompactionFoldsEdge {
  type: "compaction-folds";
  source: string; // CompactionRecord id
  target: string; // PosteriorDelta id (the delta being folded in)
}

export type PriorDeltaNode = PriorCapsule | PosteriorDelta | CompactionRecord | DissentRecord;

export type PriorDeltaEdge = DeltaAgainstPriorEdge | DissentAgainstClaimEdge | CompactionFoldsEdge;

export const APPEND_ONLY_NODE_TYPES = [
  "prior-capsule",
  "posterior-delta",
  "compaction-record",
  "dissent-record",
] as const;

export type AppendOnlyNodeType = (typeof APPEND_ONLY_NODE_TYPES)[number];
