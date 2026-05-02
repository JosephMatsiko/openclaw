// Public types for @openclaw/skill-introspect.

export type RiskClass = "low" | "medium" | "high";

export interface RawObservation {
  id?: string;
  category?: string;
  observation?: string;
  why_novel?: string;
  whyNovel?: string;
  recommendation?: string;
  risk_class?: RiskClass | string;
  riskClass?: RiskClass | string;
  rationale?: string;
  evidence?: Array<{ source?: string; snippet?: string }>;
}

export interface NormalizedObservation {
  proposedId: string | null;
  category: string;
  observation: string;
  whyNovel: string;
  recommendation: string;
  riskClass: RiskClass;
  rationale: string;
  evidence: Array<{ source: string; snippet: string }>;
}

export interface IntrospectionRecord {
  id: string;
  ts: string;
  scanRunId: string;
  mode: "scan" | "focus";
  topic?: string;
  category: string;
  observation: string;
  whyNovel: string;
  recommendation: string;
  riskClass: RiskClass;
  rationale: string;
  evidence: Array<{ source: string; snippet: string }>;
  fingerprint: string;
  proposedId: string | null;
  applied: boolean;
  appliedAt: string | null;
  dismissed: boolean;
  dismissedAt: string | null;
  dismissedReason: string | null;
}

export interface LastScanState {
  fingerprints?: string[];
  lastScanAt?: string;
  lastScanRunId?: string;
  lastEmittedCount?: number;
  lastFocusAt?: string;
  lastFocusTopic?: string;
}

export interface StateBundle {
  bundledAt: string;
  recentEvents: string;
  docket: Array<Record<string, unknown>>;
  healReceipts: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  openDecisions: Array<Record<string, unknown>>;
  selfImprovement: Array<Record<string, unknown>>;
  healthSnapshot: string | null;
  priorsLatestHead: string | null;
  dissents: Array<Record<string, unknown>>;
}

export interface ClaudeDispatchResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface ScanOptions {
  dryRun?: boolean;
  /** Inject a synthetic claude-cli result (for tests). */
  dispatch?: (prompt: string) => Promise<ClaudeDispatchResult>;
  /** Pin "now" for deterministic tests. */
  now?: number;
}

export interface FocusOptions {
  /** Inject a synthetic claude-cli result (for tests). */
  dispatch?: (prompt: string) => Promise<ClaudeDispatchResult>;
}

export interface ScanResult {
  mode: "scan";
  scanRunId: string;
  durationMs?: number;
  promptSize?: number;
  rawSize?: number;
  parsedCount?: number;
  observations?: IntrospectionRecord[];
  emitted?: Array<
    Pick<IntrospectionRecord, "id" | "category" | "riskClass" | "observation" | "recommendation">
  >;
  skipped?: Array<{ reason: string; fp?: string; category?: string; raw?: unknown }>;
  error?: string;
  dryRun?: boolean;
  promptHead?: string;
  bundleStats?: Record<string, number | boolean>;
}

export interface FocusResult {
  mode: "focus";
  scanRunId: string;
  durationMs?: number;
  topic: string;
  promptSize?: number;
  answer?: string;
  observations?: IntrospectionRecord[];
  emitted?: Array<
    Pick<IntrospectionRecord, "id" | "category" | "riskClass" | "observation" | "recommendation">
  >;
  error?: string;
}
