// `prior_delta` agent tool stub.
//
// First iteration exposes only the validators + hash helpers — the
// persistence path (writing into memory-graph's SQLite store) lands in
// follow-on changes. This way the typed contract is published and other
// plugins can `import { validateCompaction } from
// "@openclaw/plugin-memory-graph-prior-delta"` immediately.
//
// Available actions:
//   action="validate-compaction" — check a CompactionRecord against all
//     four invariants. Returns { ok, violations[] }.
//   action="compute-prior-id" — content-address a prior-capsule.
//   action="compute-delta-id" — content-address a posterior-delta.
//
// The persistence + read-marker advance + bus-emit logic ships in v0.2.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { PriorDeltaConfig } from "./config.js";
import { posteriorDeltaId, priorCapsuleId } from "./hash.js";
import { type CrossFamilyContext, SchemaViolation, validateCompaction } from "./invariants.js";
import type { CompactionRecord, PosteriorDelta } from "./types.js";

interface ValidateCompactionParams {
  record: CompactionRecord;
  removedDeltas: PosteriorDelta[];
  voiceFamilies: Record<string, string>;
}

interface ComputePriorIdParams {
  parent_hash: string | null;
  content: unknown;
  generated_at: string;
}

interface ComputeDeltaIdParams {
  prior_hash: string;
  voice_id: string;
  content: unknown;
  generated_at: string;
}

type RawParams = {
  action: "validate-compaction" | "compute-prior-id" | "compute-delta-id";
  validateCompaction?: ValidateCompactionParams;
  computePriorId?: ComputePriorIdParams;
  computeDeltaId?: ComputeDeltaIdParams;
};

export function createPriorDeltaTool(_params: {
  api: OpenClawPluginApi;
  config: PriorDeltaConfig;
}) {
  return {
    name: "prior_delta",
    label: "Prior + Delta",
    description:
      "Validate Universal Prior + Posterior Delta records against append-only, dissent-preservation, three-signature, and cross-family-discipline invariants. Compute content-addressed ids for prior-capsules and posterior-deltas.",
    parameters: Type.Object({
      action: Type.String({
        enum: ["validate-compaction", "compute-prior-id", "compute-delta-id"],
        description: "Which validator/helper to run.",
      }),
      validateCompaction: Type.Optional(
        Type.Object(
          {
            record: Type.Any(),
            removedDeltas: Type.Array(Type.Any()),
            voiceFamilies: Type.Record(Type.String(), Type.String()),
          },
          { description: "Required when action='validate-compaction'." },
        ),
      ),
      computePriorId: Type.Optional(
        Type.Object(
          {
            parent_hash: Type.Union([Type.String(), Type.Null()]),
            content: Type.Any(),
            generated_at: Type.String(),
          },
          { description: "Required when action='compute-prior-id'." },
        ),
      ),
      computeDeltaId: Type.Optional(
        Type.Object(
          {
            prior_hash: Type.String(),
            voice_id: Type.String(),
            content: Type.Any(),
            generated_at: Type.String(),
          },
          { description: "Required when action='compute-delta-id'." },
        ),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as RawParams;
      if (raw.action === "validate-compaction") {
        if (!raw.validateCompaction) {
          throw new Error("validateCompaction params required");
        }
        const { record, removedDeltas, voiceFamilies } = raw.validateCompaction;
        const ctx: CrossFamilyContext = {
          voiceFamilies: voiceFamilies as CrossFamilyContext["voiceFamilies"],
        };
        try {
          validateCompaction(record, removedDeltas, ctx);
          return jsonResult({ ok: true, violations: [] });
        } catch (err) {
          if (err instanceof SchemaViolation) {
            return jsonResult({
              ok: false,
              violations: [{ invariant: err.invariant, message: err.message }],
            });
          }
          return jsonResult({
            ok: false,
            violations: [{ invariant: "unknown", message: String(err) }],
          });
        }
      }
      if (raw.action === "compute-prior-id") {
        if (!raw.computePriorId) {
          throw new Error("computePriorId params required");
        }
        const id = priorCapsuleId(raw.computePriorId);
        return jsonResult({ id });
      }
      if (raw.action === "compute-delta-id") {
        if (!raw.computeDeltaId) {
          throw new Error("computeDeltaId params required");
        }
        const id = posteriorDeltaId(raw.computeDeltaId);
        return jsonResult({ id });
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
