import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
// node:sqlite is stable in Node 24 (experimental warning on Node 22); the
// repo currently targets Node 22+ per CLAUDE.md. A warning-free path can be
// swapped behind this module later without touching callers.
import { DatabaseSync } from "node:sqlite";
import {
  cosineSimilarity,
  deserializeEmbedding,
  EMBEDDING_MODEL_ID,
  serializeEmbedding,
} from "./embedder.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import type { EdgeWriteInput, GraphStorage, NodeWriteInput } from "./storage.js";
import type {
  GraphEdge,
  GraphNode,
  GraphNodeId,
  GraphNodeQuery,
  GraphWriteResult,
} from "./types.js";

type NodeRow = {
  id: string;
  kind: string;
  summary: string;
  body: string | null;
  scope: string;
  scope_id: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  source_session_id: string | null;
  source_session_key: string | null;
  source_entry_id: string | null;
  source_surface: string | null;
  origin_label: string | null;
  embedding: Uint8Array | null;
  embedding_model: string | null;
};

type EdgeRow = {
  id: string;
  kind: string;
  from_id: string;
  to_id: string;
  weight: number | null;
  created_at: number;
  updated_at: number;
};

function rowToNode(row: NodeRow): GraphNode {
  const hasSessionSource = row.source_session_id !== null;
  const source =
    hasSessionSource || row.source_surface !== null || row.origin_label !== null
      ? {
          sessionId: row.source_session_id ?? "",
          ...(row.source_session_key !== null ? { sessionKey: row.source_session_key } : {}),
          ...(row.source_entry_id !== null ? { entryId: row.source_entry_id } : {}),
          ...(row.source_surface !== null
            ? {
                surface: row.source_surface as GraphNode["source"] extends infer S
                  ? S extends { surface?: infer U }
                    ? U
                    : never
                  : never,
              }
            : {}),
          ...(row.origin_label !== null ? { originLabel: row.origin_label } : {}),
        }
      : undefined;
  return {
    id: row.id,
    kind: row.kind as GraphNode["kind"],
    summary: row.summary,
    ...(row.body !== null ? { body: row.body } : {}),
    scope: row.scope as GraphNode["scope"],
    scopeId: row.scope_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(source ? { source } : {}),
  };
}

// Pull a default origin_label from the environment when the caller does not
// set one explicitly. Smoke-test runners and eval harnesses launch with
// OPENCLAW_MEMORY_ORIGIN_LABEL=<cohort> and every node written during that
// process inherits the label, which makes after-the-fact bulk purges possible
// without having to diff against real user data.
function envOriginLabel(): string | null {
  const raw = process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    kind: row.kind as GraphEdge["kind"],
    fromId: row.from_id,
    toId: row.to_id,
    ...(row.weight !== null ? { weight: row.weight } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SqliteGraphStorageOptions = {
  // Absolute path to the SQLite file. Pass `:memory:` for an in-memory
  // database (used by tests and ephemeral agents).
  dbPath: string;
  // Override the clock for deterministic tests.
  now?: () => number;
};

// SqliteGraphStorage is a synchronous-but-Promise-wrapped implementation of
// GraphStorage over node:sqlite. Keeping the public surface async lets future
// backends (network-backed, batched, etc.) slot in without touching callers.
export class SqliteGraphStorage implements GraphStorage {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: SqliteGraphStorageOptions) {
    const path = options.dbPath;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.now = options.now ?? (() => Date.now());
    this.db.exec("PRAGMA foreign_keys = ON;");
    // WAL keeps readers unblocked during writes, survives crashes better than
    // rollback-journal mode, and is durable enough with synchronous=NORMAL for
    // a personal-use graph where write rates are low.
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    this.applyMigrations();
    if (path !== ":memory:") {
      // Graph contains facts, preferences, and constraints extracted from the
      // user's real conversations. Lock permissions down to owner-only. Best
      // effort — if chmod fails (non-POSIX fs) just continue.
      try {
        chmodSync(path, 0o600);
      } catch {
        // ignore
      }
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private applyMigrations(): void {
    // Bootstrap the schema_version table so we can read current state before
    // deciding which migrations to run. This is idempotent across re-opens.
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
    const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    const currentVersion = row?.version ?? 0;
    // Apply only migrations between currentVersion and our declared
    // SCHEMA_VERSION. Stop at SCHEMA_VERSION so an older binary sharing the
    // DB with a newer one never tries to run a migration it doesn't own.
    const target = Math.min(SCHEMA_VERSION, MIGRATIONS.length);
    for (let i = currentVersion; i < target; i += 1) {
      this.db.exec(MIGRATIONS[i]);
    }
    if (!row) {
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    } else if (row.version < SCHEMA_VERSION) {
      // Monotonic: advance the recorded version forward. NEVER regress — an
      // older binary running against a future-schema DB must leave it alone.
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }

  async writeNode(input: NodeWriteInput): Promise<GraphWriteResult> {
    const id = input.id ?? randomUUID();
    const ts = this.now();
    const existing = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | NodeRow
      | undefined;

    const source = input.source;
    // Caller-supplied label wins; env-var default is the fallback. Preserving
    // any existing stored label on upsert (when neither is supplied) avoids
    // accidentally erasing cohort provenance on a re-classify.
    const originLabel = source?.originLabel ?? envOriginLabel() ?? existing?.origin_label ?? null;
    if (existing) {
      this.db
        .prepare(
          `UPDATE nodes
             SET kind = ?, summary = ?, body = ?, scope = ?, scope_id = ?,
                 confidence = ?, updated_at = ?,
                 source_session_id = ?, source_session_key = ?, source_entry_id = ?,
                 source_surface = ?, origin_label = ?
           WHERE id = ?`,
        )
        .run(
          input.kind,
          input.summary,
          input.body ?? null,
          input.scope,
          input.scopeId,
          input.confidence,
          ts,
          source?.sessionId ?? null,
          source?.sessionKey ?? null,
          source?.entryId ?? null,
          source?.surface ?? null,
          originLabel,
          id,
        );
      const updated = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow;
      return { node: rowToNode(updated), created: false };
    }

    this.db
      .prepare(
        `INSERT INTO nodes
           (id, kind, summary, body, scope, scope_id, confidence,
            created_at, updated_at,
            source_session_id, source_session_key, source_entry_id,
            source_surface, origin_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.summary,
        input.body ?? null,
        input.scope,
        input.scopeId,
        input.confidence,
        ts,
        ts,
        source?.sessionId ?? null,
        source?.sessionKey ?? null,
        source?.entryId ?? null,
        source?.surface ?? null,
        originLabel,
      );
    const inserted = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow;
    return { node: rowToNode(inserted), created: true };
  }

  async writeEdge(input: EdgeWriteInput): Promise<GraphEdge> {
    const id = input.id ?? randomUUID();
    const ts = this.now();
    const existing = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as
      | EdgeRow
      | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE edges
             SET kind = ?, from_id = ?, to_id = ?, weight = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.kind, input.fromId, input.toId, input.weight ?? null, ts, id);
      const updated = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow;
      return rowToEdge(updated);
    }
    this.db
      .prepare(
        `INSERT INTO edges
           (id, kind, from_id, to_id, weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.fromId, input.toId, input.weight ?? null, ts, ts);
    const inserted = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow;
    return rowToEdge(inserted);
  }

  findNodesSync(query: GraphNodeQuery): GraphNode[] {
    const clauses = ["scope = ?", "scope_id = ?"];
    const values: (string | number)[] = [query.scope, query.scopeId];
    if (query.kinds && query.kinds.length > 0) {
      clauses.push(`kind IN (${query.kinds.map(() => "?").join(",")})`);
      for (const kind of query.kinds) {
        values.push(kind);
      }
    }
    if (query.search && query.search.trim()) {
      clauses.push("(summary LIKE ? OR body LIKE ?)");
      const like = `%${query.search.trim()}%`;
      values.push(like, like);
    }
    const limit = query.limit && query.limit > 0 ? query.limit : 50;
    const sql = `SELECT * FROM nodes WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...values) as NodeRow[];
    return rows.map(rowToNode);
  }

  async findNodes(query: GraphNodeQuery): Promise<GraphNode[]> {
    return this.findNodesSync(query);
  }

  async getNode(id: GraphNodeId): Promise<GraphNode | undefined> {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? rowToNode(row) : undefined;
  }

  async deleteNode(id: GraphNodeId): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---- Ingest cursor (per-source, per-file) ---------------------------
  //
  // Reuses the `ingest_cursor` table that `mcp-server.mjs` creates for its
  // `memory_ingest_claude_code` tool. The plugin's transcript-update
  // listener uses this so a fresh process init doesn't re-walk lines
  // already persisted before a restart. The `source` string namespaces by
  // caller — MCP uses `'claude-code'`; the plugin uses
  // `'gateway-transcript'` so neither steps on the other.

  private ensureIngestCursorTable(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ingest_cursor (
         source TEXT NOT NULL,
         file_path TEXT NOT NULL,
         last_entry_id TEXT,
         last_seen_at INTEGER NOT NULL,
         PRIMARY KEY (source, file_path)
       );`,
    );
  }

  // Returns the last seen entry id for (source, file), or undefined if we
  // have no record. Callers iterate the file and skip lines until they see
  // this id — anything after it is genuinely new.
  getIngestCursorSync(source: string, filePath: string): string | undefined {
    this.ensureIngestCursorTable();
    const row = this.db
      .prepare("SELECT last_entry_id FROM ingest_cursor WHERE source = ? AND file_path = ?")
      .get(source, filePath) as { last_entry_id: string | null } | undefined;
    const id = row?.last_entry_id;
    return id ?? undefined;
  }

  // Upserts the cursor to `lastEntryId`. Idempotent by (source, file). The
  // `last_seen_at` is bumped to now() so a future GC pass can prune stale
  // cursors without leaning on the cursor values themselves.
  setIngestCursorSync(source: string, filePath: string, lastEntryId: string): void {
    this.ensureIngestCursorTable();
    this.db
      .prepare(
        `INSERT INTO ingest_cursor (source, file_path, last_entry_id, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source, file_path) DO UPDATE SET
             last_entry_id = excluded.last_entry_id,
             last_seen_at = excluded.last_seen_at`,
      )
      .run(source, filePath, lastEntryId, this.now());
  }

  // Store (or overwrite) the embedding vector + model id for a node. Called
  // lazily from semantic-search callers so nodes without embeddings get
  // backfilled as they're queried, rather than blocking writes on a model
  // load. Returns true if the row existed.
  storeEmbeddingSync(id: GraphNodeId, vector: Float32Array, modelId: string): boolean {
    const result = this.db
      .prepare("UPDATE nodes SET embedding = ?, embedding_model = ? WHERE id = ?")
      .run(serializeEmbedding(vector), modelId, id);
    return result.changes > 0;
  }

  // Return ids + summaries + bodies for nodes that don't yet have an
  // embedding for the current model. Callers can iterate and backfill.
  listNodesMissingEmbeddingSync(
    scope: GraphNode["scope"],
    scopeId: string,
    modelId: string = EMBEDDING_MODEL_ID,
    limit: number = 1000,
  ): Array<{ id: string; summary: string; body: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT id, summary, body
           FROM nodes
          WHERE scope = ? AND scope_id = ?
            AND (embedding IS NULL OR embedding_model IS NOT ?)
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(scope, scopeId, modelId, limit) as Array<{
      id: string;
      summary: string;
      body: string | null;
    }>;
    return rows;
  }

  // Rank nodes by cosine similarity against `queryVector`. Brute-force over
  // matching rows with the same embedding_model — correct and simple up to
  // ~10k rows, which comfortably covers any personal-use graph. Nodes
  // without an embedding for this model are skipped; populate them via
  // storeEmbeddingSync first.
  findSimilarNodesSync(args: {
    queryVector: Float32Array;
    scope: GraphNode["scope"];
    scopeId: string;
    kinds?: GraphNode["kind"][];
    limit?: number;
    modelId?: string;
  }): Array<{ node: GraphNode; score: number }> {
    const modelId = args.modelId ?? EMBEDDING_MODEL_ID;
    const clauses = ["scope = ?", "scope_id = ?", "embedding IS NOT NULL", "embedding_model = ?"];
    const values: (string | number)[] = [args.scope, args.scopeId, modelId];
    if (args.kinds && args.kinds.length > 0) {
      clauses.push(`kind IN (${args.kinds.map(() => "?").join(",")})`);
      for (const kind of args.kinds) {
        values.push(kind);
      }
    }
    const sql = `SELECT * FROM nodes WHERE ${clauses.join(" AND ")}`;
    const rows = this.db.prepare(sql).all(...values) as NodeRow[];
    const ranked: Array<{ node: GraphNode; score: number }> = [];
    for (const row of rows) {
      if (!row.embedding) {
        continue;
      }
      const vec = deserializeEmbedding(row.embedding);
      const score = cosineSimilarity(args.queryVector, vec);
      ranked.push({ node: rowToNode(row), score });
    }
    ranked.sort((a, b) => b.score - a.score);
    const limit = args.limit && args.limit > 0 ? args.limit : 20;
    return ranked.slice(0, limit);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
