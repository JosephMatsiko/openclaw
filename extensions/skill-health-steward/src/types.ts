// Public types for @openclaw/skill-health-steward.

export interface DiskStatus {
  available: boolean;
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
}

export interface MemoryPressure {
  available: boolean;
  freePercentReported: number | null;
  sample: string;
}

export interface MemoryStatus {
  totalBytes: number;
  freeBytes: number;
  freePercent: number | null;
  pressure: MemoryPressure;
}

export interface LoadStatus {
  one: number;
  five: number;
  fifteen: number;
}

export interface HealthThresholds {
  diskMinFreeBytes: number;
  diskMinFreePercent: number;
  swapMaxUsedBytes: number;
}

export interface HealthSnapshot {
  state: "clear" | "watch" | "blocked";
  blockers: string[];
  warnings: string[];
  generatedAt: string;
  load: LoadStatus;
  memory: MemoryStatus;
  disk: DiskStatus;
  swap: SwapStatus;
  thresholds: HealthThresholds;
}

export interface ExecutorControl {
  mode: "active" | "paused";
  paused: boolean;
  reason: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
  path: string;
}

export interface DocketSummary {
  total: number;
  counts: Record<string, number>;
  pending: number;
  running: number;
  staleRunning: number;
  staleRunningTaskIds: string[];
}

export interface ProcessGroup {
  group: string;
  rssBytes: number;
  processCount: number;
  top: Array<{ pid: number; rssBytes: number; comm: string; args: string }>;
}

export interface SelfHealPlan {
  available?: boolean;
  actionCount?: number;
  reclaimableBytes?: number;
  blockedCount?: number;
  blockedBytes?: number;
  cloud?: { available?: boolean; archivePath?: string | null; recommendation?: string | null };
  receiptId?: string;
  error?: SelfHealRunFailure;
}

export interface SelfHealStatusResult {
  available?: boolean;
  cloud?: { available?: boolean; archivePath?: string | null; recommendation?: string | null };
  error?: SelfHealRunFailure;
}

export interface SelfHealRunFailure {
  ok: false;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  parseError?: string;
}

export type SelfHealRunResult<T> = { ok: true; parsed: T } | SelfHealRunFailure;

export interface AutomaticAction {
  action: string;
  title: string;
  risk: string;
  why: string;
  count?: number;
  bytes?: number;
}

export interface ApprovalAction {
  approvalId: string;
  action: string;
  title: string;
  risk: string;
  confirm: string;
  why: string;
  bytes?: number;
  count?: number;
  destination?: string | null;
  sourceReceiptId?: string;
  path?: string;
  apps?: Array<{ app: string; rssBytes: number; processCount: number }>;
}

export interface HandoffAction {
  action: string;
  title: string;
  risk: string;
  why: string;
}

export interface LocalArchiveCandidate {
  available: boolean;
  blocked?: boolean;
  reason?: string;
  receiptId?: string;
  receiptPath?: string;
  archiveRoot?: string;
  fileCount?: number;
  bytes?: number;
  cloudCopiesVerified?: number;
  missingCloudCount?: number;
}

export interface StatusResult {
  schema: "chuck-v3.health-steward/1";
  generatedAt: string;
  state: HealthSnapshot["state"];
  health: HealthSnapshot;
  executor: ExecutorControl;
  docket: DocketSummary;
  storage: {
    cloudAvailable: boolean;
    cloudRecommendation: string | null;
    archivePath: string | null;
    localArchive: LocalArchiveCandidate;
    safePlan: {
      actionCount: number;
      reclaimableBytes: number;
      blockedCount: number;
      blockedBytes: number;
    };
    approvedCloudPreview: { actionCount: number; reclaimableBytes: number };
  };
  processGroups: ProcessGroup[];
  automaticActions: AutomaticAction[];
  approvalActions: ApprovalAction[];
  approvalCapsulePaths: string[];
  handoffActions: HandoffAction[];
  phoneReady: {
    approvalCapsules: boolean;
    dashboardApi: boolean;
    telegramDelivery: boolean;
    reason: string;
  };
}

export interface StatusSummary {
  state: HealthSnapshot["state"];
  blockers: string[];
  executorPaused: boolean;
  diskFreeBytes: number | null;
  swapUsedBytes: number | null;
  automaticActionCount: number;
  approvalActionCount: number;
}

export interface StabilizeReceipt {
  schema: "chuck-v3.health-steward/1";
  receiptId: string;
  createdAt: string;
  mode: "stabilize";
  before: StatusSummary;
  after: StatusSummary;
  results: Array<Record<string, unknown>>;
  approvalCapsulePaths: string[];
}

export interface StabilizeResult {
  ok: true;
  receiptId: string;
  path: string;
  results: Array<Record<string, unknown>>;
  before: StatusResult;
  after: StatusResult;
}

export interface ApplyOptions {
  action: string;
  confirm?: string;
  maxActions?: number;
}

export interface ApplyResult {
  ok: boolean;
  action: string;
  result?: unknown;
  receipt?: unknown;
  path?: string;
  approvalCapsulePaths?: string[];
  approvalActions?: ApprovalAction[];
  reason?: string;
  blocked?: boolean;
  available?: boolean;
}

export interface ApprovalCapsule {
  schema: "chuck-v3.approval-capsule/1";
  approvalId: string;
  domain: "health-steward";
  status: "pending";
  createdAt: string;
  action: string;
  title: string;
  risk: string;
  confirm: string;
  why: string;
  bytes?: number;
  count?: number;
  destination?: string | null;
  sourceReceiptId?: string;
  path?: string;
  apps?: Array<{ app: string; rssBytes: number; processCount: number }>;
}

export interface SelfHealRunner {
  /** Equivalent to `chuck-mac-self-heal.mjs plan --json [--allow-cloud-offload]`. */
  plan: (opts: { allowCloudOffload?: boolean }) => Promise<SelfHealRunResult<SelfHealPlan>>;
  /** Equivalent to `chuck-mac-self-heal.mjs status --json`. */
  status: () => Promise<SelfHealRunResult<SelfHealStatusResult>>;
  /** Equivalent to `chuck-mac-self-heal.mjs apply --json [opts]`. */
  apply: (opts: {
    onlyUnderPressure?: boolean;
    allowCloudOffload?: boolean;
    maxActions?: number;
  }) => Promise<SelfHealRunResult<{ receiptId?: string }>>;
}

export interface SystemProbes {
  disk: () => DiskStatus;
  swap: () => SwapStatus;
  memoryPressure: () => MemoryPressure;
  load: () => LoadStatus;
  totalMemoryBytes: () => number;
  freeMemoryBytes: () => number;
  processGroups: () => ProcessGroup[];
}

export interface RunDeps {
  /** Subprocess for chuck-mac-self-heal; injectable for tests. */
  selfHeal?: SelfHealRunner;
  /** System probes (disk/swap/mem/load/ps); injectable for tests. */
  probes?: Partial<SystemProbes>;
  /** Pin "now" for deterministic tests. */
  now?: number;
  /** Inject deterministic receipt IDs (e.g. tests). */
  receiptIdGen?: (prefix: string) => string;
}

export interface StatusOptions extends RunDeps {
  writeApprovals?: boolean;
}

export interface StabilizeOptions extends RunDeps {
  maxActions?: number;
}
