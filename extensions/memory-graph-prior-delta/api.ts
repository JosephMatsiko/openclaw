// Public API barrel for @openclaw/plugin-memory-graph-prior-delta.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type {
  AppendOnlyNodeType,
  CompactionFoldsEdge,
  CompactionProofMethod,
  CompactionRecord,
  DeltaAgainstPriorEdge,
  DissentAgainstClaimEdge,
  DissentRecord,
  PosteriorDelta,
  PosteriorDeltaClaim,
  PosteriorDeltaDissent,
  PosteriorDeltaProposedMutation,
  PriorCapsule,
  PriorDeltaEdge,
  PriorDeltaNode,
  PriorReadMarker,
  Reversibility,
  VoiceFamily,
  VoiceSurface,
} from "./src/types.js";
export { APPEND_ONLY_NODE_TYPES } from "./src/types.js";
export {
  type CrossFamilyContext,
  type GraphMutation,
  SchemaViolation,
  validateAppendOnly,
  validateCompaction,
  validateCompactionPreservesDissent,
  validateCrossFamilyDiscipline,
  validateThreeSignatures,
} from "./src/invariants.js";
export { posteriorDeltaId, priorCapsuleId, sha256, shortId, stableStringify } from "./src/hash.js";
export { type PriorDeltaConfig, resolveConfig } from "./src/config.js";
export { openStore, type OpenStoreOptions, type PriorDeltaStore } from "./src/store.js";
