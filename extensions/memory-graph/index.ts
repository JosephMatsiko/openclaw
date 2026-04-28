import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerContextEngine } from "openclaw/plugin-sdk";
import { onSessionTranscriptUpdate } from "openclaw/plugin-sdk/agent-harness";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createChuckOpenClawCommand } from "./src/chuck-v2/openclaw-command.js";
import { resolveMemoryGraphConfig } from "./src/config.js";
import { MemoryGraphContextEngine } from "./src/engine.js";
import { runExecutionGate } from "./src/execution-gate.js";
import {
  buildMemoryBlockSync,
  buildPrincipleBlockSync,
  persistTurnFromMessages,
} from "./src/pipeline.js";
import { runRoutingHook } from "./src/routing-hook.js";
import { SqliteGraphStorage } from "./src/sqlite-storage.js";

export * from "./src/chuck-v2/index.js";

function resolveScopeId(config: ReturnType<typeof resolveMemoryGraphConfig>): string {
  return config.scope === "agent" ? "main" : "default";
}

// Globally-shared content dedup. On some installs this file is loaded
// BOTH as compiled `dist/index.js` and as source `index.ts` via a TS
// loader, producing two separate module scopes that each run `register`
// and each install their own listener. Module-level `const` Maps in each
// instance dedup within themselves but not across — so writes still
// double. Hanging dedup off `globalThis` via a Symbol is the cheap fix:
// both module copies see the same Map object.
type DedupBuckets = Map<string, Set<string>>;
const DEDUP_KEY = Symbol.for("openclaw.memory-graph.persisted-content-dedup");
type GlobalWithDedup = { [k: symbol]: DedupBuckets | undefined };
function getDedupBuckets(): DedupBuckets {
  const g = globalThis as unknown as GlobalWithDedup;
  let existing = g[DEDUP_KEY];
  if (!existing) {
    existing = new Map<string, Set<string>>();
    g[DEDUP_KEY] = existing;
  }
  return existing;
}
const MODULE_PERSISTED_CONTENT_PER_SESSION_CAP = 512;
// Two-bucket dedup: one key for user-only writes ("u:…"), one for
// user+assistant pair writes ("p:…"). Both key solely on the user-text
// prefix so streaming growth of the assistant body doesn't bust dedup.
// Intended shape per turn: one user-only persist, then one pair persist
// once the assistant's first chunk arrives. Subsequent streaming chunks
// re-hit the pair key and are skipped.
function moduleDedupKey(userText: string, assistantText?: string): string {
  const prefix = assistantText === undefined ? "u:" : "p:";
  return `${prefix}${userText.slice(0, 400)}`;
}

export default definePluginEntry({
  id: "memory-graph",
  name: "Memory (Graph)",
  description:
    "Graph-backed memory plugin with cross-session nodes and universal prompt/write integration",
  kind: "memory",
  register(api) {
    const config = resolveMemoryGraphConfig(api.pluginConfig);
    const scopeId = resolveScopeId(config);

    api.registerCommand(
      createChuckOpenClawCommand({
        stateDir: api.runtime.state.resolveStateDir
          ? join(api.runtime.state.resolveStateDir(), "chuck-v2")
          : undefined,
      }),
    );

    let storage: SqliteGraphStorage | undefined;
    try {
      storage = new SqliteGraphStorage({ dbPath: config.dbPath });
    } catch (err) {
      api.logger.warn(
        `memory-graph: failed to open graph store at ${config.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const store = storage;

    // 1) Context engine for pi-embedded-runner paths. When an agent turn
    //    goes through the embedded runner, assemble/afterTurn flow here.
    const registration = registerContextEngine("memory-graph", () => {
      return new MemoryGraphContextEngine({
        storage: store,
        scope: config.scope,
        scopeId,
        logger: api.logger,
      });
    });
    if (!registration.ok) {
      api.logger.info(
        `memory-graph: context engine already registered (${registration.existingOwner})`,
      );
    }

    // 2) Memory capability `promptBuilder` for universal prompt injection.
    //    This fires during system-prompt assembly for ALL provider backends
    //    (embedded AND CLI), so claude-cli turns get the graph memory block
    //    in their `--append-system-prompt` payload.
    //
    //    Two blocks emitted, in order:
    //      (a) <principle-layer> — canonical one-line architectural rules
    //          from `[principle:<slug>]` entities. Authoritative framing.
    //      (b) <user-memory>     — recency-ranked background context from
    //          fact/preference/constraint/open-loop/entity nodes, with
    //          canonical principle entities excluded to avoid duplication.
    //    Each block is independently fail-closed: a failure in one does not
    //    suppress the other.
    api.registerMemoryCapability({
      promptBuilder: (_params) => {
        const blocks: string[] = [];
        try {
          const principles = buildPrincipleBlockSync({
            storage: store,
            scope: config.scope,
            scopeId,
          });
          if (principles.block) {
            blocks.push(principles.block);
          }
        } catch (err) {
          api.logger.warn(
            `memory-graph: principle promptBuilder failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          const memory = buildMemoryBlockSync({
            storage: store,
            scope: config.scope,
            scopeId,
          });
          if (memory.block) {
            blocks.push(memory.block);
          }
        } catch (err) {
          api.logger.warn(
            `memory-graph: memory promptBuilder failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return blocks;
      },
    });

    // 3) Subscribe to transcript events for universal write coverage.
    //    Some emitters pass the message inline; others pass only sessionFile
    //    (file-only mode, used by the CLI backend). For the file-only case
    //    we tail the session transcript and process new messages by
    //    messageId, so claude-cli turns get captured too.
    const processedIds = new Map<string, Set<string>>();
    const pairBuffers = new Map<string, { userText?: string }>();

    const persistUserTurn = (
      sessionFile: string,
      userText: string,
      assistantText?: string,
    ): void => {
      // Content-level dedup at global scope — survives across double
      // module loads (compiled + source) and double `register(api)` calls.
      const dedupBuckets = getDedupBuckets();
      const key = moduleDedupKey(userText, assistantText);
      const bucket = dedupBuckets.get(sessionFile) ?? new Set<string>();
      if (bucket.has(key)) {
        return;
      }
      if (bucket.size >= MODULE_PERSISTED_CONTENT_PER_SESSION_CAP) {
        const oldest = bucket.values().next().value;
        if (oldest !== undefined) {
          bucket.delete(oldest);
        }
      }
      bucket.add(key);
      dedupBuckets.set(sessionFile, bucket);

      const sessionId = deriveSessionId(sessionFile);
      const messages: Array<{ role: string; content: string }> = [
        { role: "user", content: userText },
      ];
      if (assistantText) {
        messages.push({ role: "assistant", content: assistantText });
      }
      void persistTurnFromMessages({
        storage: store,
        scope: config.scope,
        scopeId,
        messages,
        source: sessionId ? { sessionId } : undefined,
      })
        .then((written) => {
          if (written > 0) {
            api.logger.info(
              `memory-graph: persisted ${written} node(s) (session=${sessionId || "unknown"})`,
            );
          }
        })
        .catch((err: unknown) => {
          api.logger.warn(
            `memory-graph: persist failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    };

    const handleTranscriptLine = (sessionFile: string, rawLine: string): void => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const message = extractMessageRecord(record);
      if (!message) {
        return;
      }
      const id = resolveMessageId(message, record, line);
      const seen = processedIds.get(sessionFile) ?? new Set<string>();
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      processedIds.set(sessionFile, seen);
      const role = typeof message.role === "string" ? message.role : undefined;
      const text = extractText(message.content);
      if (!text || !role) {
        return;
      }
      const buffer = pairBuffers.get(sessionFile) ?? {};
      if (role === "user") {
        // Persist the user message immediately so claims reach the graph on
        // the first turn. The next assistant line upgrades the thread body.
        persistUserTurn(sessionFile, text);
        buffer.userText = text;
        pairBuffers.set(sessionFile, buffer);
        return;
      }
      if (role === "assistant" && buffer.userText) {
        // Overwrite the thread node's body with the assistant reply. The
        // writeNode upsert semantics collapse by id when we pass the same
        // deterministic id — here we simply write a second thread-pair so
        // retrieval sees the paired form. Cheap duplicate; pruning can
        // come later.
        persistUserTurn(sessionFile, buffer.userText, text);
        pairBuffers.set(sessionFile, {});
      }
    };

    // Persistent cursor: across process restarts, skip lines we already
    // ingested. Source string namespaces the cursor alongside the MCP
    // server's 'claude-code' ingest so they don't collide.
    const INGEST_CURSOR_SOURCE = "gateway-transcript";

    const processTranscriptFile = async (sessionFile: string): Promise<void> => {
      try {
        const content = await readFile(sessionFile, "utf8");
        const lines = content.split("\n");
        const cursor = store.getIngestCursorSync(INGEST_CURSOR_SOURCE, sessionFile);
        // `pastCursor` is false until we pass the last-seen messageId, at
        // which point everything after is new and worth persisting. If we
        // have no cursor yet, treat every line as new.
        let pastCursor = cursor === undefined;
        let newestSeenId: string | undefined;
        for (const rawLine of lines) {
          if (!rawLine.trim()) {
            continue;
          }
          // Peek the messageId without running the full handler so we can
          // compare against the cursor cheaply.
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(rawLine) as Record<string, unknown>;
          } catch {
            continue;
          }
          const message = extractMessageRecord(record);
          if (!message) {
            continue;
          }
          const id = resolveMessageId(message, record, rawLine);
          if (!pastCursor) {
            if (id === cursor) {
              pastCursor = true;
            }
            continue;
          }
          handleTranscriptLine(sessionFile, rawLine);
          newestSeenId = id;
        }
        if (newestSeenId) {
          store.setIngestCursorSync(INGEST_CURSOR_SOURCE, sessionFile, newestSeenId);
        }
      } catch (err) {
        api.logger.warn(
          `memory-graph: failed reading ${sessionFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    let processingInFlight = new Map<string, Promise<void>>();
    onSessionTranscriptUpdate((update) => {
      const sessionFile = update.sessionFile;
      if (!sessionFile) {
        return;
      }
      if (update.message && typeof update.message === "object") {
        try {
          const serialized = JSON.stringify({
            id: update.messageId ?? undefined,
            message: update.message,
          });
          handleTranscriptLine(sessionFile, serialized);
          return;
        } catch {
          // Fall through to file-tail path.
        }
      }
      // Coalesce concurrent file reads per session to avoid the duplicate
      // write storm that hit us when a single turn emitted several events.
      const existing = processingInFlight.get(sessionFile);
      if (existing) {
        return;
      }
      const run = processTranscriptFile(sessionFile).finally(() => {
        if (processingInFlight.get(sessionFile) === run) {
          processingInFlight.delete(sessionFile);
        }
      });
      processingInFlight.set(sessionFile, run);
    });

    // 4) Layer-5 pre-inference router. Fires on OpenClaw's
    //    `before_model_resolve` hook just before the per-turn model is
    //    resolved. In "off" (default) the hook is a no-op and adds zero
    //    latency. In "shadow" it runs the classifier and logs the verdict
    //    without enforcement — use this to validate classifier decisions
    //    against live Telegram traffic before committing. In "on" it
    //    overrides provider+model per the routing table in
    //    `src/routing-hook.ts`.
    //
    //    CAUTION: OpenClaw's `google` provider inference path hangs on
    //    this install (see THREAT_MODEL §7-ish and the alignment doc).
    //    Keep routing in "shadow" or "off" until that's resolved;
    //    otherwise trivial/contextual Telegram turns will stall.
    api.on("before_model_resolve", async (event) => {
      try {
        return runRoutingHook(event, {
          mode: config.routing,
          logger: {
            info: (msg) => api.logger.info(msg),
            warn: (msg) => api.logger.warn(msg),
          },
        });
      } catch (err) {
        api.logger.warn(
          `memory-graph: routing hook threw (${err instanceof Error ? err.message : String(err)}); falling back to default model`,
        );
        return undefined;
      }
    });

    // 5) Layer-7 execution gate. Enforces Joseph's SOUL critical-action
    //    boundary at runtime on the `before_tool_call` hook. Modes:
    //    autonomous (default, log-and-pass), assisted (requireApproval via
    //    OpenClaw's approval subsystem), suggest (block + explain).
    //    Covers MCP tools only — claude-cli's intrinsic tools run in-binary
    //    and bypass OpenClaw's hook layer.
    api.on("before_tool_call", async (event) => {
      try {
        return runExecutionGate(
          {
            toolName: event.toolName,
            params: event.params,
            runId: event.runId,
            toolCallId: event.toolCallId,
          },
          {
            mode: config.executionMode,
            logger: {
              info: (msg) => api.logger.info(msg),
              warn: (msg) => api.logger.warn(msg),
            },
          },
        );
      } catch (err) {
        api.logger.warn(
          `memory-graph: execution gate threw (${err instanceof Error ? err.message : String(err)}); falling open`,
        );
        return undefined;
      }
    });

    api.logger.info(
      `memory-graph: active (scope: ${config.scope}, scopeId: ${scopeId}, routing: ${config.routing}, executionMode: ${config.executionMode}, dbPath: ${config.dbPath})`,
    );
  },
});

function extractMessageRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Transcript lines appear in two shapes: `{ role, content, ... }` at the
  // top level, or a wrapper like `{ id, message: { role, content } }`. Try
  // both so the same handler works for inline emits and file-tailed lines.
  if (typeof record.role === "string") {
    return record;
  }
  const inner = record.message;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const innerRecord = inner as Record<string, unknown>;
    if (typeof innerRecord.role === "string") {
      return innerRecord;
    }
  }
  return undefined;
}

function resolveMessageId(
  message: Record<string, unknown>,
  record: Record<string, unknown>,
  raw: string,
): string {
  const candidates = [message.id, message.messageId, record.id, record.messageId];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      return c;
    }
  }
  return raw.slice(0, 200);
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

function deriveSessionId(sessionFile: string): string {
  const slash = sessionFile.lastIndexOf("/");
  const base = slash >= 0 ? sessionFile.slice(slash + 1) : sessionFile;
  return base.replace(/\.[^.]+$/, "");
}
