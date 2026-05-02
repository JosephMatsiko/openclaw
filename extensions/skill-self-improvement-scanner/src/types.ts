// Public types for @openclaw/skill-self-improvement-scanner.

export type GapCategory =
  | "dockethealth"
  | "stuckpending"
  | "mcpgap"
  | "plistgap"
  | "skillgap"
  | "busdiversity";

export interface DocketTask {
  id?: string;
  title?: string;
  status?: string;
  risk?: string;
  commandKind?: string;
  surface?: string;
  intent?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  exitCode?: number | null;
  source?: { kind?: string; category?: string; fingerprint?: string };
  [key: string]: unknown;
}

export interface Gap {
  category: GapCategory;
  fingerprint: string;
  title: string;
  intent: string;
  /** Optional explicit deliverable for the validator (overrides intent-text inference). */
  deliverable?: { paths?: string[]; path?: string };
}

export interface DropResult {
  id: string;
  category: GapCategory;
  title: string;
  path?: string;
  dryRun?: boolean;
}

export interface ScanSummary {
  dryRun: boolean;
  gapsFound: number;
  dropped: DropResult[];
  floodSkipped: number;
}

export interface ScanOptions {
  dryRun?: boolean;
  /** Pin "now" for deterministic tests. */
  now?: number;
}

export interface DetectorContext {
  tasks: DocketTask[];
  openFps: Set<string>;
  config: import("./config.js").SelfImprovementScannerConfig;
  now: number;
}
