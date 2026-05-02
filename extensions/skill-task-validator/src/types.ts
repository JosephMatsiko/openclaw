// Public types for @openclaw/skill-task-validator.

export type ValidationCategory =
  | "no-deliverable-inferred"
  | "missing-deliverable"
  | "stat-error"
  | "empty-deliverable"
  | "stale-deliverable"
  | "syntax-fail"
  | "deliverables-verified"
  | "no-validator"
  | "validator-error"
  | "missing-state"
  | "stale-state"
  | "fresh-state"
  | "fresh-receipt"
  | "no-receipt-dir"
  | "empty-receipts"
  | "stale-receipts"
  | "no-name-inferred"
  | "fully-registered"
  | "partial-registration"
  | "llm-intent-mismatch";

export interface DocketTask {
  id?: string;
  taskId?: string;
  status?: string;
  commandKind?: string;
  command?: { commandKind?: string };
  intent?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  deliverable?: { path?: string; paths?: string[] };
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  reason: string;
  category: ValidationCategory;
  evidence: Record<string, unknown>;
  llm?: {
    skipped: boolean;
    reason?: string;
    [key: string]: unknown;
  };
  heuristic?: {
    reason: string;
    category: ValidationCategory;
  };
}

export type Validator = (
  task: DocketTask,
  config: import("./config.js").TaskValidatorConfig,
) => ValidationResult | Promise<ValidationResult>;
