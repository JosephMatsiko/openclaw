import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeId,
  GraphNodeQuery,
  GraphNodeKind,
  GraphNodeSource,
  GraphScope,
  GraphWriteResult,
} from "./types.js";

// Write shapes use Omit to drop storage-owned fields (id, createdAt, updatedAt)
// while letting callers pass an explicit id when upserting by known identity.

export type NodeWriteInput = {
  id?: GraphNodeId;
  kind: GraphNodeKind;
  summary: string;
  body?: string;
  scope: GraphScope;
  scopeId: string;
  confidence: number;
  source?: GraphNodeSource;
};

export type EdgeWriteInput = {
  id?: string;
  kind: GraphEdgeKind;
  fromId: GraphNodeId;
  toId: GraphNodeId;
  weight?: number;
};

// GraphStorage is the seam between the memory-graph context engine and its
// persistence layer. SqliteGraphStorage is the bundled implementation; the
// interface stays narrow so alternative backends (lancedb, libsql-remote,
// etc.) can land behind the same contract without touching the engine.
export interface GraphStorage {
  writeNode(input: NodeWriteInput): Promise<GraphWriteResult>;
  writeEdge(input: EdgeWriteInput): Promise<GraphEdge>;
  findNodes(query: GraphNodeQuery): Promise<GraphNode[]>;
  getNode(id: GraphNodeId): Promise<GraphNode | undefined>;
  deleteNode(id: GraphNodeId): Promise<boolean>;
  close(): Promise<void>;
  // Group a multi-write sequence into a single atomic transaction so claim
  // extraction either fully lands or not at all (no partial states on crash).
  transaction?<T>(fn: () => T): T;
}
