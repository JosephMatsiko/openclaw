// Chuck persona preamble — read fresh on every /ask request.
//
// Salvaged from chuck-pwa-server.mjs's buildChuckPreamble(). Same logic,
// rebuilt as a TypeScript module inside an openclaw plugin. Reads:
//   1. The canonical ~/.openclaw/workspace/IDENTITY.md (if injection enabled)
//   2. Recent memory-graph nodes from ~/.openclaw/memory/graph.sqlite
//      (last N by ts; if injection enabled)
//
// No gateway dependency — direct filesystem + SQLite read. Survives
// gateway WS warmup (issue #75791) and openclaw plugin warmup.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChuckPwaConfig } from "./config.js";

const HOME = homedir();
const IDENTITY_PATH = join(HOME, ".openclaw", "workspace", "IDENTITY.md");
const MEMORY_GRAPH_DB = join(HOME, ".openclaw", "memory", "graph.sqlite");

const OPERATING_FRAME = [
  "You are CHUCK — Joseph's named agent (Joseph named you 2026-04-21). One Chuck across every surface he reaches you on. The user message below arrives through Joseph's Chuck PWA chat (iPad / iPhone / Mac, all served via Tailscale from his Mac, routed through the openclaw gateway via @openclaw/plugin-chuck-pwa).",
  "",
  "Voice: editor, not coach. Confident, tight, American English. First-name basis with Joseph. No hedging, no hype, no cheerleading. First-person 'I' is fine when it reads as conversation. Be brief and useful — this is a chat surface, not a report.",
  "",
  "If asked who you are, answer as Chuck — not as the underlying CLI/web tool's default agent persona. Your operator is Joseph Matsiko. Identity above the model is fixed; the model under you is interchangeable.",
];

interface MemoryNode {
  type: string;
  content: string;
}

async function readRecentMemoryNodes(limit: number): Promise<MemoryNode[]> {
  if (limit <= 0) return [];
  if (!existsSync(MEMORY_GRAPH_DB)) return [];
  try {
    const sqliteMod = await import("node:sqlite");
    const db = new sqliteMod.DatabaseSync(MEMORY_GRAPH_DB, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT type, content FROM nodes ORDER BY COALESCE(ts, created_at) DESC LIMIT ?")
        .all(limit) as Array<{ type: unknown; content: unknown }>;
      return rows
        .filter((r) => typeof r.type === "string")
        .map((r) => ({
          type: String(r.type),
          content:
            typeof r.content === "string" ? r.content.slice(0, 280) : String(r.content ?? ""),
        }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Build the persona preamble that prepends to every /ask user prompt.
 *
 * Returns a string that ends with a separator line; the caller appends
 * the user's actual prompt after.
 */
export async function buildChuckPreamble(config: ChuckPwaConfig): Promise<string> {
  const parts: string[] = [...OPERATING_FRAME];

  if (config.personaInjectsIdentity) {
    try {
      if (existsSync(IDENTITY_PATH)) {
        const identity = readFileSync(IDENTITY_PATH, "utf8");
        parts.push("");
        parts.push("--- IDENTITY.md (your operating doctrine) ---");
        parts.push(identity);
        parts.push("--- end IDENTITY.md ---");
      }
    } catch {
      /* IDENTITY.md missing — fall through with operating frame only. */
    }
  }

  if (config.personaInjectsRecentMemory && config.personaRecentNodes > 0) {
    const nodes = await readRecentMemoryNodes(config.personaRecentNodes);
    if (nodes.length > 0) {
      parts.push("");
      parts.push(`--- recent memory-graph nodes (your last ${nodes.length} stored items) ---`);
      for (const node of nodes) {
        parts.push(`[${node.type}] ${node.content}`);
      }
      parts.push("--- end memory-graph context ---");
    }
  }

  parts.push("");
  parts.push("--- USER MESSAGE FOLLOWS ---");
  parts.push("");
  return parts.join("\n");
}
