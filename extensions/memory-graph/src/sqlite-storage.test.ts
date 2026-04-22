import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./schema.js";
import { SqliteGraphStorage } from "./sqlite-storage.js";

function newStore(now?: () => number) {
  return new SqliteGraphStorage({ dbPath: ":memory:", now });
}

describe("SqliteGraphStorage", () => {
  test("writeNode inserts and round-trips", async () => {
    const store = newStore();
    const res = await store.writeNode({
      kind: "fact",
      summary: "joseph is allergic to peanuts",
      scope: "workspace",
      scopeId: "default",
      confidence: 0.95,
    });
    expect(res.created).toBe(true);
    expect(res.node.summary).toBe("joseph is allergic to peanuts");
    expect(res.node.kind).toBe("fact");
    expect(res.node.scope).toBe("workspace");
    expect(res.node.createdAt).toBeGreaterThan(0);
    expect(res.node.updatedAt).toBe(res.node.createdAt);

    const fetched = await store.getNode(res.node.id);
    expect(fetched?.id).toBe(res.node.id);
    await store.close();
  });

  test("writeNode with same id updates and bumps updated_at", async () => {
    let t = 1000;
    const store = newStore(() => t);
    const first = await store.writeNode({
      id: "fixed",
      kind: "preference",
      summary: "cobalt blue",
      scope: "workspace",
      scopeId: "default",
      confidence: 0.9,
    });
    expect(first.created).toBe(true);
    t = 2000;
    const second = await store.writeNode({
      id: "fixed",
      kind: "preference",
      summary: "cobalt blue (preferred)",
      scope: "workspace",
      scopeId: "default",
      confidence: 0.95,
    });
    expect(second.created).toBe(false);
    expect(second.node.summary).toBe("cobalt blue (preferred)");
    expect(second.node.createdAt).toBe(1000);
    expect(second.node.updatedAt).toBe(2000);
    await store.close();
  });

  test("findNodes scopes strictly", async () => {
    const store = newStore();
    await store.writeNode({
      kind: "fact",
      summary: "A",
      scope: "workspace",
      scopeId: "ws-1",
      confidence: 1,
    });
    await store.writeNode({
      kind: "fact",
      summary: "B",
      scope: "workspace",
      scopeId: "ws-2",
      confidence: 1,
    });
    await store.writeNode({
      kind: "fact",
      summary: "C",
      scope: "agent",
      scopeId: "ws-1",
      confidence: 1,
    });
    const ws1 = await store.findNodes({ scope: "workspace", scopeId: "ws-1" });
    expect(ws1.map((n) => n.summary)).toEqual(["A"]);
    const agent = await store.findNodes({ scope: "agent", scopeId: "ws-1" });
    expect(agent.map((n) => n.summary)).toEqual(["C"]);
    await store.close();
  });

  test("findNodes filters by kind and search", async () => {
    const store = newStore();
    await store.writeNode({
      kind: "fact",
      summary: "peanut allergy",
      scope: "workspace",
      scopeId: "s",
      confidence: 1,
    });
    await store.writeNode({
      kind: "preference",
      summary: "likes cobalt blue",
      scope: "workspace",
      scopeId: "s",
      confidence: 1,
    });
    await store.writeNode({
      kind: "entity",
      summary: "joseph matsiko",
      scope: "workspace",
      scopeId: "s",
      confidence: 1,
    });
    const facts = await store.findNodes({
      scope: "workspace",
      scopeId: "s",
      kinds: ["fact", "preference"],
    });
    expect(facts.map((n) => n.kind).toSorted()).toEqual(["fact", "preference"]);
    const matches = await store.findNodes({
      scope: "workspace",
      scopeId: "s",
      search: "cobalt",
    });
    expect(matches.map((n) => n.summary)).toEqual(["likes cobalt blue"]);
    await store.close();
  });

  test("writeEdge + cascade delete", async () => {
    const store = newStore();
    const a = await store.writeNode({
      kind: "entity",
      summary: "joseph",
      scope: "workspace",
      scopeId: "s",
      confidence: 1,
    });
    const b = await store.writeNode({
      kind: "fact",
      summary: "peanut allergy",
      scope: "workspace",
      scopeId: "s",
      confidence: 1,
    });
    const edge = await store.writeEdge({
      kind: "about",
      fromId: b.node.id,
      toId: a.node.id,
    });
    expect(edge.fromId).toBe(b.node.id);
    expect(edge.toId).toBe(a.node.id);

    const removed = await store.deleteNode(a.node.id);
    expect(removed).toBe(true);
    // Edge pointing at the removed node should cascade-delete.
    const nodes = await store.findNodes({ scope: "workspace", scopeId: "s" });
    expect(nodes.map((n) => n.summary)).toEqual(["peanut allergy"]);
    await store.close();
  });

  test("persists source provenance", async () => {
    const store = newStore();
    const res = await store.writeNode({
      kind: "fact",
      summary: "from a transcript",
      scope: "workspace",
      scopeId: "s",
      confidence: 0.8,
      source: {
        sessionId: "sess-1",
        sessionKey: "key-1",
        entryId: "entry-1",
      },
    });
    expect(res.node.source?.sessionId).toBe("sess-1");
    expect(res.node.source?.sessionKey).toBe("key-1");
    expect(res.node.source?.entryId).toBe("entry-1");
    await store.close();
  });

  test("limit caps findNodes results", async () => {
    const store = newStore();
    for (let i = 0; i < 5; i += 1) {
      await store.writeNode({
        kind: "fact",
        summary: `fact ${i}`,
        scope: "workspace",
        scopeId: "s",
        confidence: 0.5,
      });
    }
    const nodes = await store.findNodes({
      scope: "workspace",
      scopeId: "s",
      limit: 2,
    });
    expect(nodes).toHaveLength(2);
    await store.close();
  });

  test("ingest cursor round-trips per (source, file_path) and namespaces by source", async () => {
    const store = newStore();
    try {
      // Unknown cursor → undefined.
      expect(store.getIngestCursorSync("gateway-transcript", "/tmp/a.jsonl")).toBeUndefined();
      // Write and read back.
      store.setIngestCursorSync("gateway-transcript", "/tmp/a.jsonl", "msg-1");
      expect(store.getIngestCursorSync("gateway-transcript", "/tmp/a.jsonl")).toBe("msg-1");
      // Upsert with a new id.
      store.setIngestCursorSync("gateway-transcript", "/tmp/a.jsonl", "msg-2");
      expect(store.getIngestCursorSync("gateway-transcript", "/tmp/a.jsonl")).toBe("msg-2");
      // Different source → separate cursor.
      expect(store.getIngestCursorSync("claude-code", "/tmp/a.jsonl")).toBeUndefined();
      store.setIngestCursorSync("claude-code", "/tmp/a.jsonl", "cc-msg-1");
      expect(store.getIngestCursorSync("claude-code", "/tmp/a.jsonl")).toBe("cc-msg-1");
      expect(store.getIngestCursorSync("gateway-transcript", "/tmp/a.jsonl")).toBe("msg-2");
      // Different file → separate cursor.
      expect(store.getIngestCursorSync("gateway-transcript", "/tmp/b.jsonl")).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  test("v4 migration relabels bulk claude-code threads as thread_archive", async () => {
    // End-to-end: seed a v3-shape DB with a mix of live threads and
    // bulk-ingested `cc:` threads, then re-open through SqliteGraphStorage
    // and verify the migration relabels only the bulk rows.
    const dir = mkdtempSync(join(tmpdir(), "memory-graph-mig-"));
    const path = join(dir, "graph.sqlite");
    try {
      // --- seed at v3 ---
      const seed = new DatabaseSync(path);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
      // Run v1, v2, v3 manually so the row shape matches what a v3 binary
      // would have produced before v4 existed.
      seed.exec(MIGRATIONS[0]);
      seed.exec(MIGRATIONS[1]);
      seed.exec(MIGRATIONS[2]);
      seed.prepare("INSERT INTO schema_version (version) VALUES (?)").run(3);

      const insert = seed.prepare(
        `INSERT INTO nodes
           (id, kind, summary, body, scope, scope_id, confidence,
            created_at, updated_at,
            source_session_id, source_session_key, source_entry_id,
            source_surface)
         VALUES (?, 'thread', ?, NULL, 'workspace', 'default', 1,
                 1000, 1000, ?, NULL, ?, ?)`,
      );
      // Two bulk-ingested rows — these should be relabeled.
      insert.run("t-bulk-1", "bulk turn 1", "cc:proj-a/sess-1.jsonl", "entry-1", "claude-code");
      insert.run("t-bulk-2", "bulk turn 2", "cc:proj-b/sess-2.jsonl", "entry-2", "claude-code");
      // One live thread via Telegram — should NOT be relabeled.
      insert.run("t-live-tg", "live turn tg", "telegram-sess-1", "entry-3", "telegram");
      // One live thread with no surface (engine default) — should NOT be
      // relabeled either: the migration only touches surface='claude-code'.
      insert.run("t-live-none", "live turn none", "local-sess-1", "entry-4", null);
      // One claude-code thread WITHOUT a cc: prefix (hypothetical live CC
      // turn through the plugin rather than a bulk ingest) — should NOT be
      // relabeled: the cc: prefix is the bulk-ingest signal.
      insert.run("t-live-cc", "live cc turn", "nonbulk-sess-1", "entry-5", "claude-code");
      seed.close();

      // --- reopen with current code (declares v4) ---
      const store = new SqliteGraphStorage({ dbPath: path });
      try {
        const bulk = await store.getNode("t-bulk-1");
        expect(bulk?.kind).toBe("thread_archive");
        const bulk2 = await store.getNode("t-bulk-2");
        expect(bulk2?.kind).toBe("thread_archive");
        const liveTg = await store.getNode("t-live-tg");
        expect(liveTg?.kind).toBe("thread");
        const liveNone = await store.getNode("t-live-none");
        expect(liveNone?.kind).toBe("thread");
        const liveCc = await store.getNode("t-live-cc");
        expect(liveCc?.kind).toBe("thread");
      } finally {
        await store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("origin_label cohort tagging", () => {
    test("explicit source.originLabel persists through write + read", async () => {
      const store = newStore();
      const res = await store.writeNode({
        kind: "fact",
        summary: "smoke-1",
        scope: "workspace",
        scopeId: "default",
        confidence: 0.98,
        source: { sessionId: "s-1", originLabel: "smoke-2026-04-21" },
      });
      expect(res.node.source?.originLabel).toBe("smoke-2026-04-21");
      const fetched = await store.getNode(res.node.id);
      expect(fetched?.source?.originLabel).toBe("smoke-2026-04-21");
      await store.close();
    });

    test("env var OPENCLAW_MEMORY_ORIGIN_LABEL is the fallback default", async () => {
      const prior = process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
      process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = "eval-run-7";
      try {
        const store = newStore();
        const res = await store.writeNode({
          kind: "fact",
          summary: "env default",
          scope: "workspace",
          scopeId: "default",
          confidence: 0.9,
        });
        expect(res.node.source?.originLabel).toBe("eval-run-7");
        await store.close();
      } finally {
        if (prior === undefined) {
          delete process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
        } else {
          process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = prior;
        }
      }
    });

    test("explicit source overrides env-var default", async () => {
      const prior = process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
      process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = "env-label";
      try {
        const store = newStore();
        const res = await store.writeNode({
          kind: "fact",
          summary: "explicit wins",
          scope: "workspace",
          scopeId: "default",
          confidence: 0.9,
          source: { sessionId: "s-1", originLabel: "explicit-label" },
        });
        expect(res.node.source?.originLabel).toBe("explicit-label");
        await store.close();
      } finally {
        if (prior === undefined) {
          delete process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
        } else {
          process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = prior;
        }
      }
    });

    test("no source + no env = null label (real user data path)", async () => {
      const prior = process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
      delete process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
      try {
        const store = newStore();
        const res = await store.writeNode({
          kind: "fact",
          summary: "real user claim",
          scope: "workspace",
          scopeId: "default",
          confidence: 0.9,
        });
        expect(res.node.source?.originLabel).toBeUndefined();
        await store.close();
      } finally {
        if (prior !== undefined) {
          process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = prior;
        }
      }
    });

    test("upsert without label preserves existing stored label", async () => {
      const store = newStore();
      const first = await store.writeNode({
        id: "fixed",
        kind: "fact",
        summary: "v1",
        scope: "workspace",
        scopeId: "default",
        confidence: 0.9,
        source: { sessionId: "s-1", originLabel: "smoke" },
      });
      expect(first.node.source?.originLabel).toBe("smoke");
      // Re-classification without label supplied should not erase the tag.
      const second = await store.writeNode({
        id: "fixed",
        kind: "fact",
        summary: "v2",
        scope: "workspace",
        scopeId: "default",
        confidence: 0.95,
      });
      expect(second.node.source?.originLabel).toBe("smoke");
      await store.close();
    });

    test("whitespace-only env var treated as absent", async () => {
      const prior = process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
      process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = "   ";
      try {
        const store = newStore();
        const res = await store.writeNode({
          kind: "fact",
          summary: "whitespace env",
          scope: "workspace",
          scopeId: "default",
          confidence: 0.9,
        });
        expect(res.node.source?.originLabel).toBeUndefined();
        await store.close();
      } finally {
        if (prior === undefined) {
          delete process.env.OPENCLAW_MEMORY_ORIGIN_LABEL;
        } else {
          process.env.OPENCLAW_MEMORY_ORIGIN_LABEL = prior;
        }
      }
    });
  });
});
