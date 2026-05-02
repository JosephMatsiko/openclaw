// Public types for @openclaw/skill-industry-radar.

export interface RepoSource {
  /** Stable identifier used in state.json + bus events. */
  id: string;
  owner: string;
  repo: string;
  /** Score multiplier (per-repo weight). Default 1. */
  weight?: number;
}

export interface SourcesConfig {
  repos?: RepoSource[];
  /** Optional fleet-synthesis prompt; not used in v0.1 (deferred). */
  synthesisPrompt?: string;
}

export interface CommitAuthor {
  name?: string;
  date?: string;
}

export interface RawCommit {
  sha?: string;
  commit?: { author?: CommitAuthor; message?: string };
  html_url?: string;
}

export interface ScoredCommit extends RawCommit {
  _score: number;
  _repo: string;
}

export interface RepoSignal {
  source: string;
  ok: boolean;
  total?: number;
  surfaced?: number;
  commits?: ScoredCommit[];
  error?: string;
}

export interface SkippedSignal {
  source: string;
  ok: false;
  skipped: true;
  reason: string;
}

export type Signal = RepoSignal | SkippedSignal;

export interface RadarState {
  lastFullScanAt?: string | null;
  lastDigestPath?: string;
  lastRawPath?: string;
  [key: string]: unknown;
}

export interface ScanOptions {
  /** When true, scan but skip writing receipts/state. */
  dryRun?: boolean;
  /** Pin "now" for deterministic tests. */
  now?: number;
  /** Override the loaded sources config (testing). */
  sourcesOverride?: SourcesConfig;
  /** Override the gh fetcher (testing). */
  fetchCommits?: (
    repo: RepoSource,
    sinceIso: string,
  ) => { ok: boolean; commits?: RawCommit[]; error?: string };
}

export interface ScanResult {
  ok: boolean;
  digestPath?: string;
  rawPath?: string;
  summary: { reposOk: number; reposFail: number; commitsSurfaced: number };
  signals?: Signal[];
}
