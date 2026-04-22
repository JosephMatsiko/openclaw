// SQL schema for the memory-graph SQLite store.
//
// Revisions land here as new migrations; the storage layer applies them in
// order at open time and records the applied version in `schema_version`.

export const SCHEMA_VERSION = 4;

export const MIGRATIONS: readonly string[] = [
  // v1: nodes + edges + metadata.
  //
  // `scope + scope_id` partitions the graph per workspace (default) or per
  // agent. Every query scopes on both columns so a shared database can host
  // independent per-agent graphs without cross-leaks.
  //
  // Nodes keep optional source provenance (session + transcript entry) so
  // future tooling can trace a node back to the turn that produced it.
  //
  // Edges use ON DELETE CASCADE so pruning a node also removes its edges.
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source_session_id TEXT,
    source_session_key TEXT,
    source_entry_id TEXT
  );

  CREATE INDEX IF NOT EXISTS nodes_scope_idx ON nodes (scope, scope_id);
  CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes (kind);
  CREATE INDEX IF NOT EXISTS nodes_updated_idx ON nodes (updated_at DESC);

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    weight REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS edges_from_idx ON edges (from_id);
  CREATE INDEX IF NOT EXISTS edges_to_idx ON edges (to_id);
  CREATE INDEX IF NOT EXISTS edges_kind_idx ON edges (kind);
  `,
  // v2: per-node normalized sentence-embedding vector for semantic retrieval.
  // Stored as a raw Float32 BLOB (length = 4 * embedding_dim bytes). Model
  // id is tracked so a future model swap can trigger re-embedding without
  // silently mixing vector spaces.
  `
  ALTER TABLE nodes ADD COLUMN embedding BLOB;
  ALTER TABLE nodes ADD COLUMN embedding_model TEXT;
  `,
  // v3: source_surface — which interface produced this node. Lets future
  // queries separate "things I told the Telegram bot" from "things I
  // discussed in Claude Code." Values are free-form; common ones:
  // 'telegram', 'openclaw-terminal', 'claude-code', 'claude-desktop',
  // 'explicit' (user called memory_store directly), 'unknown'.
  `
  ALTER TABLE nodes ADD COLUMN source_surface TEXT;
  CREATE INDEX IF NOT EXISTS nodes_source_surface_idx ON nodes (source_surface);
  `,
  // v4: split raw thread bulk from bulk-imported historical transcripts.
  //
  // memory_ingest_claude_code wrote every historical user turn as
  // kind='thread' with ingest-time timestamps, which polluted any
  // time-windowed query (notably the Layer-2 daily summarizer). Relabel
  // those rows as 'thread_archive' so live-vs-historical can be filtered
  // cleanly. Identifier: source_surface='claude-code' + source_session_id
  // prefixed 'cc:' (the convention mcp-server.mjs uses on ingest).
  //
  // No schema change; this is a data-repair migration gated by version so
  // it runs once per DB.
  `
  UPDATE nodes
     SET kind = 'thread_archive'
   WHERE kind = 'thread'
     AND source_surface = 'claude-code'
     AND source_session_id LIKE 'cc:%';
  `,
];
