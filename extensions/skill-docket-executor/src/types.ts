// Public types for @openclaw/skill-docket-executor.

export type Lane = "diagnostic" | "scout" | "build" | "memory" | "maintenance";

export type CommandKind =
  | "bootstrap"
  | "doctor"
  | "capability-ledger"
  | "docket-list"
  | "prior-capsule"
  | "live-scout"
  | "codex-build"
  | "claude-cli-build"
  | "mac-self-heal";

export type Risk = "low" | "medium" | "high";

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "failed-validation"
  | "blocked"
  | "cancelled";

export interface Task {
  id?: string;
  taskId?: string;
  title?: string;
  status?: TaskStatus | string;
  risk?: Risk | string;
  commandKind?: CommandKind | string;
  command?: { commandKind?: string };
  intent?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  executorRunId?: string;
  timeoutMs?: number;
  requestedTimeoutMs?: number;
  expectedTimeoutMs?: number;
  estimatedTimeoutMs?: number;
  longRunning?: boolean;
  timeoutClass?: "default" | "long";
  expectedDuration?: "default" | "long";
  durationClass?: "default" | "long";
  maxActions?: number | string;
  cloudTarget?: string;
  sourceTaskPath?: string;
  [key: string]: unknown;
}

export interface CommandSpec {
  executable: string;
  args: string[];
}

export interface CommandDescriptor {
  lane: Lane;
  build: (task: Task) => CommandSpec;
}

export interface LaneTimeoutPolicy {
  defaultMs: number;
  longMs: number;
  maxMs: number;
}

export interface LaneRunPolicy {
  maxRunning: number;
  description: string;
}

export interface ResolvedTimeoutPolicy {
  lane: string;
  source: "lane-default" | "task-long-running" | "cli-override" | "task-requested";
  timeoutMs: number;
  requestedMs: number;
  defaultMs: number;
  longMs: number;
  maxMs: number;
  capped: boolean;
  longRunning: boolean;
}

export interface MacHealthGateStatus {
  generatedAt: string;
  state: "clear" | "blocked";
  blockers: string[];
  thresholds: {
    diskMinFreeBytes: number;
    diskWarnFreePercent: number;
    swapWarnUsedBytes: number;
  };
  load: { one: number; five: number; fifteen: number; cpuCount: number; loadRatio: number };
  memory: { totalBytes: number; freeBytes: number; freePercent: number | null };
  disk: DiskStatus;
  swap: SwapStatus;
  signals: Array<{
    category: string;
    severity: "info" | "warn" | "error";
    summary: string;
    value?: number | null;
  }>;
}

export interface DiskStatus {
  available: boolean;
  path: string;
  totalBytes?: number;
  freeBytes?: number;
  freePercent?: number | null;
  reason?: string;
}

export interface SwapStatus {
  available: boolean;
  totalBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
  usedPercent?: number | null;
  raw?: string;
  reason?: string;
}

export interface ExecutorControl {
  mode: "active" | "paused";
  paused: boolean;
  reason: string;
  updatedAt: string | null;
  updatedBy: string | null;
  path: string;
  failClosed?: boolean;
}

export interface EligibilityCheck {
  eligible: boolean;
  blockers: string[];
}
