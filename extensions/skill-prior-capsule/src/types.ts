// Public types for @openclaw/skill-prior-capsule.

export interface PriorCapsuleReceipt {
  priorId: string;
  sourceHash: string;
  createdAt: string;
  path: string | null;
  markdownPath: string | null;
  latestPath: string | null;
}

/**
 * The full prior-capsule object is large and shape-rich (operatorIntent,
 * systemState, recentDocket, recentRuns, ledgerState, compactionState,
 * compactionCursor, compactedClaims, openQuestions, recommendedNextActions,
 * hardConstraints, approvalGates, resourceBudget, evidencePointers, sources,
 * etc.). Until the full TS port lands, callers that want the body should
 * read the file at the receipt's `path` themselves; this plugin's tool
 * returns the receipt only.
 */
export interface PriorCapsuleSummary {
  schemaVersion: "chuck.prior-capsule.v1";
  priorId: string;
  createdAt: string;
  sourceHash: string;
}

export interface BuildOptions {
  /** Persist prior-*.json + latest.json under priorsDir. */
  write?: boolean;
  /** With write=true, also render prior-*.md companion. */
  markdown?: boolean;
  /** Optional path to the docket task that triggered this refresh. */
  sourceTaskPath?: string;
  /** Latest docket/run/ledger item count. */
  limit?: number;
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

export interface BuildResult {
  ok: boolean;
  receipt: PriorCapsuleReceipt;
  /** When write=false, the full capsule body parsed from stdout. */
  capsule?: PriorCapsuleSummary & Record<string, unknown>;
}

export interface RunDeps {
  /** Inject the subprocess runner (for tests). Production uses defaultSubprocessRunner. */
  runSubprocess?: SubprocessRunner;
}
