import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "openclaw/plugin-sdk/core";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { lastAssistantText, lastUserText } from "./messages.js";
import { buildMemoryBlock, buildPrincipleBlock, persistTurn } from "./pipeline.js";
import type { GraphStorage } from "./storage.js";
import type { GraphScope } from "./types.js";

type CE = ContextEngine;

// Structural subset of `PluginLogger` from `src/plugins/types.ts`. Inlined
// here to avoid taking a runtime dep on the host package — any logger with
// these methods will satisfy the contract.
export type MemoryGraphEngineLogger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
};

export type MemoryGraphEngineParams = {
  storage?: GraphStorage;
  scope?: GraphScope;
  scopeId?: string;
  logger?: MemoryGraphEngineLogger;
};

// ContextEngine implementation for memory-graph.
//
// Handles the embedded-runner hot path (pi-embedded-runner calls assemble +
// afterTurn per iteration). CLI-backend providers (claude-cli, codex-cli)
// skip this interface entirely; index.ts wires plugin lifecycle hooks that
// share the same `pipeline.ts` functions so both paths write/read the same
// graph.
export class MemoryGraphContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "memory-graph",
    name: "Memory Graph",
    version: "1.0.0",
  };

  private readonly storage?: GraphStorage;
  private readonly scope: GraphScope;
  private readonly scopeId: string;
  private readonly logger?: MemoryGraphEngineLogger;
  private warnedMissingStorage = false;

  constructor(params: MemoryGraphEngineParams = {}) {
    this.storage = params.storage;
    this.scope = params.scope ?? "workspace";
    this.scopeId = params.scopeId ?? "default";
    this.logger = params.logger;
  }

  // Emit at most one warning per engine instance when we hit a no-op branch
  // that would otherwise be invisible. Production wiring (index.ts) always
  // passes storage, so this firing is a real misconfiguration signal — not
  // expected steady-state noise. Tests that intentionally construct without
  // storage simply omit `logger` and stay silent.
  private warnMissingStorageOnce(operation: string): void {
    if (this.warnedMissingStorage || !this.logger) {
      return;
    }
    this.warnedMissingStorage = true;
    this.logger.warn(
      `memory-graph: ${operation} called without storage — engine running as no-op (scope: ${this.scope}, scopeId: ${this.scopeId})`,
    );
  }

  async ingest(_params: Parameters<CE["ingest"]>[0]): Promise<IngestResult> {
    return { ingested: false };
  }

  async assemble(params: Parameters<CE["assemble"]>[0]): Promise<AssembleResult> {
    if (!this.storage) {
      this.warnMissingStorageOnce("assemble");
      return { messages: params.messages, estimatedTokens: 0 };
    }
    // Two blocks, in the same order the universal promptBuilder hook emits
    // them (index.ts): <principle-layer> first as authoritative constraints,
    // then <user-memory> as background context. Each block is independently
    // fail-closed — a failure in one does not suppress the other.
    const blocks: string[] = [];
    let estimatedTokens = 0;
    try {
      const principles = await buildPrincipleBlock({
        storage: this.storage,
        scope: this.scope,
        scopeId: this.scopeId,
      });
      if (principles.block) {
        blocks.push(principles.block);
        estimatedTokens += principles.estimatedTokens;
      }
    } catch (err) {
      this.logger?.warn(
        `memory-graph: assemble principle block failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const memory = await buildMemoryBlock({
        storage: this.storage,
        scope: this.scope,
        scopeId: this.scopeId,
      });
      if (memory.block) {
        blocks.push(memory.block);
        estimatedTokens += memory.estimatedTokens;
      }
    } catch (err) {
      this.logger?.warn(
        `memory-graph: assemble memory block failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (blocks.length === 0) {
      return { messages: params.messages, estimatedTokens: 0 };
    }
    return {
      messages: params.messages,
      estimatedTokens,
      systemPromptAddition: blocks.join("\n\n"),
    };
  }

  async afterTurn(params: Parameters<NonNullable<CE["afterTurn"]>>[0]): Promise<void> {
    if (!this.storage) {
      this.warnMissingStorageOnce("afterTurn");
      return;
    }
    if (params.isHeartbeat) {
      return;
    }
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    if (newMessages.length === 0) {
      return;
    }
    // Intentional drop: the graph is keyed on user-text claims. `extractClaims`
    // only consumes user text, and a thread node's summary is built from the
    // user message — so an assistant-only or tool-only batch has nothing
    // persistable here. Universal write coverage for these batches comes
    // through the transcript-listener path in index.ts, which pairs each
    // assistant chunk back to the buffered user text.
    const userText = lastUserText(newMessages);
    if (!userText) {
      return;
    }
    const assistantText = lastAssistantText(newMessages);
    const source: {
      sessionId: string;
      sessionKey?: string;
    } = { sessionId: params.sessionId };
    if (params.sessionKey) {
      source.sessionKey = params.sessionKey;
    }
    await persistTurn({
      storage: this.storage,
      scope: this.scope,
      scopeId: this.scopeId,
      userText,
      ...(assistantText ? { assistantText } : {}),
      source,
    });
  }

  async compact(params: Parameters<CE["compact"]>[0]): Promise<CompactResult> {
    return await delegateCompactionToRuntime(params);
  }

  async dispose(): Promise<void> {
    // Do NOT close the storage here. The SqliteGraphStorage instance is
    // owned by the plugin's `register(api)` and shared with the
    // promptBuilder + transcript-listener paths. When the agent runner
    // tears down an engine mid-session (e.g. during a provider fallback
    // after a 429), closing the DB would leave those other consumers with
    // a dead handle, surfacing as `database is not open` on subsequent
    // writes.
    //
    // The previously-separate persist-loop bug (noisy repeated writes
    // from the transcript listener) is fixed at its source via the
    // content-level dedup in index.ts, so we no longer need the DB-close
    // here to act as a silencer.
    //
    // Tests that spin up a storage just for one engine close it
    // themselves via `storage.close()` (see the scope-isolation test in
    // engine.test.ts).
  }
}
