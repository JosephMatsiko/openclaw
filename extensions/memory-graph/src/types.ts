export type GraphNodeKind =
  | "fact"
  | "preference"
  | "open-loop"
  | "thread"
  | "thread_archive"
  | "entity"
  | "constraint";

// Live turn capture vs bulk-ingested historical transcripts. Both hold raw
// conversation content, but "thread" reflects a real-time interaction through
// the gateway while "thread_archive" came from a one-shot import
// (memory_ingest_claude_code). The summarizer reads only "thread" so that
// ingest time does not pollute today's daily summary; search tooling reads
// both so historical recall still works.
export const LIVE_THREAD_KIND: GraphNodeKind = "thread";
export const ARCHIVE_THREAD_KIND: GraphNodeKind = "thread_archive";

export type GraphEdgeKind = "mentions" | "about" | "relates-to" | "causes" | "supersedes";

export type GraphNodeId = string;

export type GraphScope = "workspace" | "agent";

export type GraphNodeSurface =
  | "telegram"
  | "openclaw-terminal"
  | "openclaw-gateway"
  | "claude-code"
  | "claude-desktop"
  | "explicit"
  | "unknown";

export type GraphNodeSource = {
  sessionId: string;
  sessionKey?: string;
  entryId?: string;
  surface?: GraphNodeSurface;
};

export type GraphNode = {
  id: GraphNodeId;
  kind: GraphNodeKind;
  summary: string;
  body?: string;
  scope: GraphScope;
  scopeId: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  source?: GraphNodeSource;
};

export type GraphEdge = {
  id: string;
  kind: GraphEdgeKind;
  fromId: GraphNodeId;
  toId: GraphNodeId;
  weight?: number;
  createdAt: number;
  updatedAt: number;
};

export type GraphNodeQuery = {
  scope: GraphScope;
  scopeId: string;
  kinds?: GraphNodeKind[];
  search?: string;
  limit?: number;
};

export type GraphWriteResult = {
  node: GraphNode;
  created: boolean;
};
