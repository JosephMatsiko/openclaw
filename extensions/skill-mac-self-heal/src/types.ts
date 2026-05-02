// Public types for @openclaw/skill-mac-self-heal.

/**
 * The .mjs prints rich receipts under chuck-v3.mac-self-heal/1 schema. The
 * shape varies by command (status / plan / apply), so the typed plugin
 * surface returns the parsed JSON as a generic record. Callers (skill-
 * health-steward, skill-docket-executor) extract the fields they need
 * (actionCount, reclaimableBytes, blockedCount, blockedBytes, cloud, results,
 * receiptId, etc.). When the full TS port lands, these will be expanded into
 * structured types.
 */
export type SelfHealReceipt = Record<string, unknown> & {
  schema?: string;
  receiptId?: string;
  actionCount?: number;
  reclaimableBytes?: number;
  blockedCount?: number;
  blockedBytes?: number;
  cloud?: { available?: boolean; archivePath?: string | null; recommendation?: string | null };
  results?: Array<Record<string, unknown>>;
  appliedBytes?: number;
};

export interface StatusOptions {}

export interface PlanOptions {
  /** Widens the plan to include cloud-offload candidates. */
  allowCloudOffload?: boolean;
}

export interface ApplyOptions {
  /** Cap actions to execute in this run. Defaults to config.defaultMaxActions. */
  maxActions?: number;
  /** Optional cloud-storage target path; only meaningful with allowCloudOffload. */
  cloudTarget?: string;
  /** Only execute actions under measurable resource pressure (disk/swap). */
  onlyUnderPressure?: boolean;
  /** Allow cloud-offload candidates to be acted on. */
  allowCloudOffload?: boolean;
  /** Force read-only behavior even when invoked via apply. */
  dryRun?: boolean;
}

export type SubprocessRunner = (args: {
  scriptPath: string;
  args: string[];
  timeoutMs: number;
}) => Promise<SubprocessResult>;

export interface SubprocessResult {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunDeps {
  /** Inject the subprocess runner (for tests). Production uses defaultSubprocessRunner. */
  runSubprocess?: SubprocessRunner;
}

export interface RunResult<T = SelfHealReceipt> {
  ok: true;
  command: "status" | "plan" | "apply";
  result: T;
}
