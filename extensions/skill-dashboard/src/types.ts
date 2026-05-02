// Public types for @openclaw/skill-dashboard.

/**
 * The chuck-dashboard.mjs server exposes ~50+ /api/* endpoints; per-endpoint
 * typed responses would couple this plugin too tightly to the .mjs's internal
 * shape. v0.1 returns the parsed JSON as-is; callers narrow at the call site.
 */
export type DashboardEndpoint =
  // chuck-v3 surface
  | "/api/chuck-v3/perichoresis"
  | "/api/chuck-v3/compaction"
  | "/api/chuck-v3/docket-drafts"
  | "/api/chuck-v3/executor-queue"
  | "/api/chuck-v3/executor-inspect"
  | "/api/chuck-v3/authority-gates"
  | "/api/chuck-v3/self-improvement-lab"
  | "/api/chuck-v3/push/vapid-public"
  | "/api/chuck-v3/push/status"
  // chuck-v2 surface
  | "/api/chuck-v2/build/status"
  | "/api/chuck-v2/work-ledger"
  | "/api/chuck-v2/live-build"
  | "/api/chuck-v2/doctor/status"
  | "/api/chuck-v2/family-registry"
  | "/api/chuck-v2/latest-fleet-run"
  | "/api/chuck-v2/surface-control"
  | "/api/chuck-v2/surface-atlas/status"
  | "/api/chuck-v2/capability-ledger/status"
  | "/api/chuck-v2/transport-audit/status"
  // top-level surface
  | "/api/snapshot"
  | "/api/fleet"
  | "/api/principles"
  | "/api/processes"
  | "/api/mac-health"
  | "/api/mac-self-heal/status"
  | "/api/mac-self-heal/plan"
  | "/api/repo-hygiene"
  | "/api/repo-hygiene/latest-checkpoint"
  | "/api/github-hygiene/latest-checkpoint"
  | "/api/upstream-sync/latest-checkpoint"
  | "/api/panels"
  | "/api/curator"
  | "/api/scorer"
  | "/api/router";

export type DashboardJson = Record<string, unknown> | unknown[];

export interface QueryOptions {
  /** Path under /api (e.g. "/api/chuck-v3/perichoresis"). Must start with "/". */
  path: string;
  /** Optional query string parameters. */
  search?: Record<string, string | number | boolean>;
  /** Optional override for queryTimeoutMs. */
  timeoutMs?: number;
}

export interface QueryResult {
  ok: boolean;
  status: number;
  url: string;
  body: DashboardJson;
}

export interface HealthResult {
  ok: boolean;
  reachable: boolean;
  status?: number;
  url: string;
  reason?: string;
}

export interface LaunchAgentStatus {
  label: string;
  loaded: boolean;
  pid: number | null;
  lastExitCode: number | null;
  raw: string;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
}

/** Injectable HTTP fetcher. Production uses node:http; tests pass a stub. */
export type DashboardFetcher = (args: { url: string; timeoutMs: number }) => Promise<FetchResult>;

/** Injectable launchctl runner. Production uses spawnSync; tests stub. */
export type LaunchctlRunner = (args: { label: string }) => Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
}>;

export interface RunDeps {
  fetch?: DashboardFetcher;
  launchctl?: LaunchctlRunner;
}
