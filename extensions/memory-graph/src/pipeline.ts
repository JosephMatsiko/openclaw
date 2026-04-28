import { createHash } from "node:crypto";
import {
  estimateTokens,
  formatMemoryBlock,
  formatPrincipleBlock,
  isCanonicalPrincipleNode,
  MEMORY_INJECTION_KINDS,
} from "./assemble.js";
import { extractClaims } from "./extractor.js";
import { lastAssistantText, lastUserText } from "./messages.js";
import type { SqliteGraphStorage } from "./sqlite-storage.js";
import type { GraphStorage } from "./storage.js";
import type { GraphNode, GraphNodeKind, GraphScope } from "./types.js";

// Deterministic node id from (kind + scope + scopeId + summary). Same claim
// restated across turns upserts the same row instead of creating duplicates.
// The hash is prefixed by kind so IDs stay human-greppable in the DB.
function deterministicNodeId(
  kind: GraphNodeKind,
  scope: GraphScope,
  scopeId: string,
  summary: string,
): string {
  const h = createHash("sha1")
    .update(`${scope}:${scopeId}:${kind}:${summary.toLowerCase().trim()}`)
    .digest("hex");
  return `${kind}-${h.slice(0, 16)}`;
}

const SUMMARY_MAX = 200;
const BODY_MAX = 4000;

export type PipelineScope = {
  scope: GraphScope;
  scopeId: string;
};

export type PersistTurnArgs = PipelineScope & {
  storage: GraphStorage;
  userText: string;
  assistantText?: string;
  source?: {
    sessionId: string;
    sessionKey?: string;
    entryId?: string;
  };
};

// Persist one turn: write the coarse thread node plus any extracted claim
// nodes. Returns the count of nodes written so callers can report.
export async function persistTurn(args: PersistTurnArgs): Promise<number> {
  const userText = args.userText.trim();
  if (!userText) {
    return 0;
  }
  const threadSummary = userText.slice(0, SUMMARY_MAX);
  const writes: NodeWriteInputAndCount[] = [
    {
      input: {
        id: deterministicNodeId("thread", args.scope, args.scopeId, threadSummary),
        kind: "thread",
        summary: threadSummary,
        ...(args.assistantText ? { body: args.assistantText.slice(0, BODY_MAX) } : {}),
        scope: args.scope,
        scopeId: args.scopeId,
        confidence: 1,
        ...(args.source ? { source: args.source } : {}),
      },
    },
  ];
  for (const claim of extractClaims(userText)) {
    writes.push({
      input: {
        id: deterministicNodeId(claim.kind, args.scope, args.scopeId, claim.summary),
        kind: claim.kind,
        summary: claim.summary,
        ...(claim.body ? { body: claim.body } : {}),
        scope: args.scope,
        scopeId: args.scopeId,
        confidence: claim.confidence,
        ...(args.source ? { source: args.source } : {}),
      },
    });
  }
  // All-or-nothing for the turn: if extraction throws mid-sequence, nothing
  // lands. Storage may or may not expose transaction(); fall back to the
  // sequential path when it doesn't (still correct, just less atomic).
  if (typeof args.storage.transaction === "function") {
    const awaited: Promise<unknown>[] = [];
    args.storage.transaction(() => {
      for (const w of writes) {
        awaited.push(args.storage.writeNode(w.input));
      }
    });
    await Promise.all(awaited);
  } else {
    for (const w of writes) {
      await args.storage.writeNode(w.input);
    }
  }
  return writes.length;
}

type NodeWriteInputAndCount = {
  input: Parameters<GraphStorage["writeNode"]>[0];
};

// Convenience wrapper that pulls user + assistant text out of a raw message
// batch (the shape used by both ContextEngine.afterTurn and the agent_end
// hook) and then calls persistTurn. Returns 0 when no user text is present.
export async function persistTurnFromMessages(
  args: PipelineScope & {
    storage: GraphStorage;
    messages: readonly unknown[];
    source?: PersistTurnArgs["source"];
  },
): Promise<number> {
  const userText = lastUserText(args.messages);
  if (!userText) {
    return 0;
  }
  const assistantText = lastAssistantText(args.messages);
  return persistTurn({
    storage: args.storage,
    scope: args.scope,
    scopeId: args.scopeId,
    userText,
    ...(assistantText ? { assistantText } : {}),
    ...(args.source ? { source: args.source } : {}),
  });
}

export type MemoryBlockResult = {
  block?: string;
  estimatedTokens: number;
};

// Query storage for high-signal nodes and format them into a <user-memory>
// block ready for prompt injection. Returns an empty result when the graph
// has nothing to inject. Canonical principle entities are filtered out —
// they surface through buildPrincipleBlock in a dedicated <principle-layer>.
export async function buildMemoryBlock(
  args: PipelineScope & { storage: GraphStorage; limit?: number },
): Promise<MemoryBlockResult> {
  const nodes = await args.storage.findNodes({
    scope: args.scope,
    scopeId: args.scopeId,
    kinds: [...MEMORY_INJECTION_KINDS],
    limit: args.limit ?? 50,
  });
  const nonPrinciple = nodes.filter((n) => !isCanonicalPrincipleNode(n));
  const block = formatMemoryBlock(nonPrinciple);
  if (!block) {
    return { estimatedTokens: 0 };
  }
  return { block, estimatedTokens: estimateTokens(block) };
}

// Async counterpart to buildPrincipleBlockSync, for callers that hold only
// the generic GraphStorage interface (ContextEngine.assemble path).
export async function buildPrincipleBlock(
  args: PipelineScope & { storage: GraphStorage; limit?: number },
): Promise<MemoryBlockResult> {
  const nodes = await args.storage.findNodes({
    scope: args.scope,
    scopeId: args.scopeId,
    kinds: ["entity"],
    limit: args.limit ?? 50,
  });
  const block = formatPrincipleBlock(nodes);
  if (!block) {
    return { estimatedTokens: 0 };
  }
  return { block, estimatedTokens: estimateTokens(block) };
}

// Synchronous counterpart for hot paths (memory promptBuilder is sync).
// Uses SqliteGraphStorage.findNodesSync directly; node:sqlite is itself sync
// so there's no real async work to unwrap.
export function buildMemoryBlockSync(
  args: PipelineScope & { storage: SqliteGraphStorage; limit?: number },
): MemoryBlockResult {
  const nodes: GraphNode[] = args.storage.findNodesSync({
    scope: args.scope,
    scopeId: args.scopeId,
    kinds: [...MEMORY_INJECTION_KINDS],
    limit: args.limit ?? 50,
  });
  // Filter out canonical principle entities — they surface through
  // buildPrincipleBlockSync in a dedicated <principle-layer> block with
  // authoritative framing. Leaving them here would dilute both signals.
  const nonPrinciple = nodes.filter((n) => !isCanonicalPrincipleNode(n));
  const block = formatMemoryBlock(nonPrinciple);
  if (!block) {
    return { estimatedTokens: 0 };
  }
  return { block, estimatedTokens: estimateTokens(block) };
}

// Query storage for canonical principle entities and format them into a
// <principle-layer> block ready for prompt injection. Cheap: principles
// are a small closed set (target ~15 total); we pull all entity-kind nodes
// and let formatPrincipleBlock filter to canonical ones.
export function buildPrincipleBlockSync(
  args: PipelineScope & { storage: SqliteGraphStorage; limit?: number },
): MemoryBlockResult {
  const nodes: GraphNode[] = args.storage.findNodesSync({
    scope: args.scope,
    scopeId: args.scopeId,
    kinds: ["entity"],
    limit: args.limit ?? 50,
  });
  const block = formatPrincipleBlock(nodes);
  if (!block) {
    return { estimatedTokens: 0 };
  }
  return { block, estimatedTokens: estimateTokens(block) };
}
