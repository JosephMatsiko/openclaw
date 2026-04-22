import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "openclaw/plugin-sdk";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk";
import { lastAssistantText, lastUserText } from "./messages.js";
import { buildMemoryBlock, persistTurn } from "./pipeline.js";
import type { GraphStorage } from "./storage.js";
import type { GraphScope } from "./types.js";

type CE = ContextEngine;

export type MemoryGraphEngineParams = {
  storage?: GraphStorage;
  scope?: GraphScope;
  scopeId?: string;
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

  constructor(params: MemoryGraphEngineParams = {}) {
    this.storage = params.storage;
    this.scope = params.scope ?? "workspace";
    this.scopeId = params.scopeId ?? "default";
  }

  async ingest(_params: Parameters<CE["ingest"]>[0]): Promise<IngestResult> {
    return { ingested: false };
  }

  async assemble(params: Parameters<CE["assemble"]>[0]): Promise<AssembleResult> {
    if (!this.storage) {
      return { messages: params.messages, estimatedTokens: 0 };
    }
    const result = await buildMemoryBlock({
      storage: this.storage,
      scope: this.scope,
      scopeId: this.scopeId,
    });
    if (!result.block) {
      return { messages: params.messages, estimatedTokens: 0 };
    }
    return {
      messages: params.messages,
      estimatedTokens: result.estimatedTokens,
      systemPromptAddition: result.block,
    };
  }

  async afterTurn(params: Parameters<NonNullable<CE["afterTurn"]>>[0]): Promise<void> {
    if (!this.storage || params.isHeartbeat) {
      return;
    }
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    if (newMessages.length === 0) {
      return;
    }
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
    // themselves via `storage.close()` (see engine.test.ts:147).
  }
}
