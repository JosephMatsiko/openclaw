// Public types for @openclaw/skill-decision-engine.

export type RiskClass = "low" | "medium" | "high";

export type DecisionStatus = "open" | "applied" | "rejected";

export type DetectorCategory =
  | "failed-task-cluster"
  | "zombie-cluster"
  | "channel-drift"
  | "scanner-tune"
  | "orphan-mcp"
  | "stale-mac-heal";

export interface DecisionOption {
  label: string;
  action: string;
}

export interface DetectorHit {
  category: DetectorCategory;
  fingerprint: string;
  situation: string;
  options: DecisionOption[];
  recommendation: string;
  rationale: string;
  riskClass: RiskClass;
  evidence: Record<string, unknown>;
  rollback: string;
}

export interface Proposal extends DetectorHit {
  id: string;
  ts: string;
  autoApply: boolean;
  applied: boolean;
  appliedAt: string | null;
  appliedAction: string | null;
  approvalNeeded: boolean;
  approvalChannel: "telegram";
  approvalChatId: string;
  status: DecisionStatus;
  rejectedAt?: string;
  rejectedReason?: string | null;
}

export interface ScanSummary {
  dryRun: boolean;
  detectorsRun: number;
  hits: number;
  emitted: number;
  floodSkipped: number;
  proposals: Array<{
    id: string;
    category: DetectorCategory;
    riskClass: RiskClass;
    autoApply: boolean;
    applied: boolean;
    recommendation: string;
  }>;
}

export interface ScanOptions {
  dryRun?: boolean;
  /** Pin the "now" instant for deterministic tests. */
  now?: Date;
}

export interface DocketTask {
  id?: string;
  taskId?: string;
  status?: string;
  commandKind?: string;
  updatedAt?: string;
  source?: { kind?: string };
  [key: string]: unknown;
}

export interface BusEvent {
  ts?: string;
  type?: string;
  source?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DetectorContext {
  tasks: DocketTask[];
  events: BusEvent[];
  config: import("./config.js").DecisionEngineConfig;
  now: Date;
}

export type Detector = (ctx: DetectorContext) => DetectorHit | null;
