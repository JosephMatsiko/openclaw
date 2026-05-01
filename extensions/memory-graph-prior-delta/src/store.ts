// SQLite store for prior-delta nodes (v0.2 persistence).
//
// Lives in the same SQLite file as the memory-graph plugin
// (~/.openclaw/memory/graph.sqlite), but in its own additive tables
// (prior_capsules, posterior_deltas, compaction_records, dissent_records).
// No collision with memory-graph's existing tables.
//
// All write paths run the invariant validators in ./invariants.ts BEFORE
// the INSERT — so the database itself enforces append-only / dissent-
// preservation / three-signature / cross-family rules.
//
// Uses node:sqlite (DatabaseSync) to match memory-graph's choice.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { posteriorDeltaId, priorCapsuleId, stableStringify } from "./hash.js";
import {
  type CrossFamilyContext,
  SchemaViolation,
  validateAppendOnly,
  validateCompaction,
} from "./invariants.js";
import type {
  CompactionRecord,
  DissentRecord,
  PosteriorDelta,
  PriorCapsule,
  PriorReadMarker,
} from "./types.js";

const SCHEMA_VERSION = 1;

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prior_delta_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prior_capsules (
  id           TEXT PRIMARY KEY,
  parent_hash  TEXT,
  content      TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  read_markers TEXT NOT NULL DEFAULT '{}',
  inserted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prior_capsules_parent ON prior_capsules(parent_hash);
CREATE INDEX IF NOT EXISTS idx_prior_capsules_generated_at ON prior_capsules(generated_at DESC);

CREATE TABLE IF NOT EXISTS posterior_deltas (
  id                  TEXT PRIMARY KEY,
  prior_hash          TEXT NOT NULL,
  voice_id            TEXT NOT NULL,
  family              TEXT NOT NULL,
  surface             TEXT NOT NULL,
  generated_at        TEXT NOT NULL,
  claims              TEXT NOT NULL,
  dissent             TEXT NOT NULL,
  proposed_mutations  TEXT NOT NULL,
  self_doubt_note     TEXT,
  inserted_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posterior_deltas_prior_hash ON posterior_deltas(prior_hash);
CREATE INDEX IF NOT EXISTS idx_posterior_deltas_voice_id ON posterior_deltas(voice_id);

CREATE TABLE IF NOT EXISTS compaction_records (
  id                     TEXT PRIMARY KEY,
  prior_hash_before      TEXT NOT NULL,
  prior_hash_after       TEXT NOT NULL,
  proposer               TEXT NOT NULL,
  approver               TEXT NOT NULL,
  signer                 TEXT NOT NULL,
  proposed_at            TEXT NOT NULL,
  approved_at            TEXT NOT NULL,
  signed_at              TEXT NOT NULL,
  removed_delta_ids      TEXT NOT NULL,
  preserved_dissent_ids  TEXT NOT NULL,
  proof_of_equivalence   TEXT NOT NULL,
  rollback_pointer       TEXT NOT NULL,
  inserted_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_compaction_records_after ON compaction_records(prior_hash_after);

CREATE TABLE IF NOT EXISTS dissent_records (
  id                              TEXT PRIMARY KEY,
  delta_id                        TEXT NOT NULL,
  against_claim_id                TEXT NOT NULL,
  rationale                       TEXT NOT NULL,
  counter_evidence_refs           TEXT NOT NULL,
  preserved_through_compactions   TEXT NOT NULL,
  inserted_at                     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dissent_records_delta_id ON dissent_records(delta_id);
`;

export interface OpenStoreOptions {
  dbPath: string;
}

export interface PriorDeltaStore {
  /** Persist a prior-capsule. Validates append-only first. */
  writePriorCapsule(capsule: PriorCapsule): void;
  /** Persist a posterior-delta. Validates append-only first. */
  writePosteriorDelta(delta: PosteriorDelta): void;
  /** Persist a compaction-record. Runs ALL four invariants first. */
  writeCompactionRecord(
    record: CompactionRecord,
    removedDeltas: ReadonlyArray<PosteriorDelta>,
    ctx: CrossFamilyContext,
  ): void;
  /** Persist a dissent-record. Append-only. */
  writeDissentRecord(record: DissentRecord): void;
  /** Get the prior-capsule with no descendant — the current one. */
  getCurrentPrior(): PriorCapsule | null;
  /** Get a specific prior by id. */
  getPriorByHash(id: string): PriorCapsule | null;
  /** List posterior-deltas keyed against a given prior. */
  listDeltasForPrior(priorHash: string): PosteriorDelta[];
  /** Update a prior's read-markers (the sole allowed mutation on prior-capsule). */
  recordRead(priorHash: string, marker: PriorReadMarker): void;
  /** Diagnostic: how many rows in each table. */
  stats(): {
    priorCapsules: number;
    posteriorDeltas: number;
    compactionRecords: number;
    dissentRecords: number;
  };
  close(): void;
}

export function openStore(opts: OpenStoreOptions): PriorDeltaStore {
  const dbPath = opts.dbPath;
  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // node:sqlite uses WAL by default for openclaw paths via memory-graph,
  // but applying it again here is idempotent + cheap.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(CREATE_SCHEMA_SQL);
  const metaUpsert = db.prepare(
    "INSERT INTO prior_delta_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  metaUpsert.run("schema_version", String(SCHEMA_VERSION));

  const insertPrior = db.prepare(
    "INSERT INTO prior_capsules(id, parent_hash, content, generated_at, generated_by, read_markers) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertDelta = db.prepare(
    "INSERT INTO posterior_deltas(id, prior_hash, voice_id, family, surface, generated_at, claims, dissent, proposed_mutations, self_doubt_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertCompaction = db.prepare(
    "INSERT INTO compaction_records(id, prior_hash_before, prior_hash_after, proposer, approver, signer, proposed_at, approved_at, signed_at, removed_delta_ids, preserved_dissent_ids, proof_of_equivalence, rollback_pointer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertDissent = db.prepare(
    "INSERT INTO dissent_records(id, delta_id, against_claim_id, rationale, counter_evidence_refs, preserved_through_compactions) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const updateReadMarkers = db.prepare("UPDATE prior_capsules SET read_markers = ? WHERE id = ?");
  const selectPriorById = db.prepare("SELECT * FROM prior_capsules WHERE id = ?");
  const selectCurrentPrior = db.prepare(
    `SELECT pc.* FROM prior_capsules pc
     LEFT JOIN prior_capsules child ON child.parent_hash = pc.id
     WHERE child.id IS NULL
     ORDER BY pc.generated_at DESC
     LIMIT 1`,
  );
  const selectDeltasForPrior = db.prepare(
    "SELECT * FROM posterior_deltas WHERE prior_hash = ? ORDER BY generated_at",
  );

  function rowToPrior(row: Record<string, unknown> | undefined): PriorCapsule | null {
    if (!row) return null;
    return {
      type: "prior-capsule",
      id: String(row.id),
      parent_hash: row.parent_hash == null ? null : String(row.parent_hash),
      content: JSON.parse(String(row.content)) as PriorCapsule["content"],
      generated_at: String(row.generated_at),
      generated_by: String(row.generated_by),
      read_markers: JSON.parse(String(row.read_markers)) as PriorCapsule["read_markers"],
    };
  }

  function rowToDelta(row: Record<string, unknown>): PosteriorDelta {
    return {
      type: "posterior-delta",
      id: String(row.id),
      prior_hash: String(row.prior_hash),
      voice_id: String(row.voice_id),
      family: String(row.family) as PosteriorDelta["family"],
      surface: String(row.surface) as PosteriorDelta["surface"],
      generated_at: String(row.generated_at),
      claims: JSON.parse(String(row.claims)) as PosteriorDelta["claims"],
      dissent: JSON.parse(String(row.dissent)) as PosteriorDelta["dissent"],
      proposed_mutations: JSON.parse(
        String(row.proposed_mutations),
      ) as PosteriorDelta["proposed_mutations"],
      self_doubt_note: row.self_doubt_note == null ? null : String(row.self_doubt_note),
    };
  }

  return {
    writePriorCapsule(capsule) {
      // Append-only check: this is an INSERT. Pass a structural target —
      // the validator only consults type + id; passing the whole capsule
      // object trips TS's discriminated-union check because typed inner
      // fields (read_markers, content) widen unpredictably.
      validateAppendOnly({
        kind: "INSERT",
        target: { type: capsule.type, id: capsule.id },
      });
      // Verify content addressing — caller may pass a placeholder id; we
      // recompute and require it to match (catches caller bugs early).
      const computed = priorCapsuleId({
        parent_hash: capsule.parent_hash,
        content: capsule.content,
        generated_at: capsule.generated_at,
      });
      if (capsule.id !== computed) {
        throw new Error(
          `prior_capsule id mismatch: expected ${computed}, got ${capsule.id} (content-addressed ids must match)`,
        );
      }
      insertPrior.run(
        capsule.id,
        capsule.parent_hash,
        stableStringify(capsule.content),
        capsule.generated_at,
        capsule.generated_by,
        stableStringify(capsule.read_markers ?? {}),
      );
    },

    writePosteriorDelta(delta) {
      validateAppendOnly({
        kind: "INSERT",
        target: { type: delta.type, id: delta.id },
      });
      const computed = posteriorDeltaId({
        prior_hash: delta.prior_hash,
        voice_id: delta.voice_id,
        content: {
          claims: delta.claims,
          dissent: delta.dissent,
          proposed_mutations: delta.proposed_mutations,
        },
        generated_at: delta.generated_at,
      });
      if (delta.id !== computed) {
        throw new Error(
          `posterior_delta id mismatch: expected ${computed}, got ${delta.id} (content-addressed ids must match)`,
        );
      }
      insertDelta.run(
        delta.id,
        delta.prior_hash,
        delta.voice_id,
        delta.family,
        delta.surface,
        delta.generated_at,
        stableStringify(delta.claims),
        stableStringify(delta.dissent),
        stableStringify(delta.proposed_mutations),
        delta.self_doubt_note,
      );
    },

    writeCompactionRecord(record, removedDeltas, ctx) {
      validateAppendOnly({
        kind: "INSERT",
        target: { type: record.type, id: record.id },
      });
      // Run all four invariants at once via the composite validator. Throws
      // SchemaViolation on any failure; caller can catch and surface.
      validateCompaction(record, removedDeltas, ctx);
      insertCompaction.run(
        record.id,
        record.prior_hash_before,
        record.prior_hash_after,
        record.proposer,
        record.approver,
        record.signer,
        record.proposed_at,
        record.approved_at,
        record.signed_at,
        stableStringify(record.removed_delta_ids),
        stableStringify(record.preserved_dissent_ids),
        stableStringify(record.proof_of_equivalence),
        record.rollback_pointer,
      );
    },

    writeDissentRecord(record) {
      validateAppendOnly({
        kind: "INSERT",
        target: { type: record.type, id: record.id },
      });
      insertDissent.run(
        record.id,
        record.delta_id,
        record.against_claim_id,
        record.rationale,
        stableStringify(record.counter_evidence_refs),
        stableStringify(record.preserved_through_compactions),
      );
    },

    getCurrentPrior() {
      const row = selectCurrentPrior.get() as Record<string, unknown> | undefined;
      return rowToPrior(row);
    },

    getPriorByHash(id) {
      const row = selectPriorById.get(id) as Record<string, unknown> | undefined;
      return rowToPrior(row);
    },

    listDeltasForPrior(priorHash) {
      const rows = selectDeltasForPrior.all(priorHash) as Array<Record<string, unknown>>;
      return rows.map(rowToDelta);
    },

    recordRead(priorHash, marker) {
      const row = selectPriorById.get(priorHash) as Record<string, unknown> | undefined;
      if (!row) {
        throw new Error(`prior_capsule not found: ${priorHash}`);
      }
      const existing = JSON.parse(String(row.read_markers)) as Record<string, PriorReadMarker>;
      existing[marker.voice_id] = marker;
      // The append-only validator allows UPDATE on prior-capsule when the
      // patch is exclusively read_markers — this matches that constraint.
      validateAppendOnly({
        kind: "UPDATE",
        target: { type: "prior-capsule", id: priorHash },
        patch: { read_markers: existing },
      });
      updateReadMarkers.run(stableStringify(existing), priorHash);
    },

    stats() {
      function count(table: string): number {
        // Table name is a closed allow-list of strings hardcoded just below;
        // sqlite doesn't allow parameterized table names in prepared statements.
        const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
        const row = stmt.get() as { n: number } | undefined;
        return row?.n ?? 0;
      }
      return {
        priorCapsules: count("prior_capsules"),
        posteriorDeltas: count("posterior_deltas"),
        compactionRecords: count("compaction_records"),
        dissentRecords: count("dissent_records"),
      };
    },

    close() {
      db.close();
    },
  };
}

// Re-export SchemaViolation so callers handling persist failures can
// pattern-match without reaching into ./invariants.ts.
export { SchemaViolation };
