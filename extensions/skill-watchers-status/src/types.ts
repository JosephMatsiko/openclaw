// Public types for @openclaw/skill-watchers-status.

export interface WatcherEntry {
  label: string;
  log?: string | null;
  busSource?: string | null;
  stateFile?: string | null;
}

export interface WatcherReport {
  label: string;
  loaded: boolean;
  pid: number | null;
  lastExitCode: number | null;
  uptimeMs: number | null;
  cpuPercent: number | null;
  lastBusEvent: { type: string; ts: string } | null;
  lastLogLine: string | null;
  stateOk: boolean | null;
  reason?: string;
}

export interface ReportOptions {
  /** Restrict to a single label (otherwise all registered watchers). */
  label?: string;
  /** Override busWindowHours from config. */
  busWindowHours?: number;
}

export type LaunchctlRunner = (args: { label: string; timeoutMs: number }) => Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
}>;

export type PsRunner = (args: { pid: number }) => Promise<{
  ok: boolean;
  cpu: number | null;
  uptimeSec: number | null;
}>;

export interface RunDeps {
  launchctl?: LaunchctlRunner;
  ps?: PsRunner;
  /** Override the registry (for tests). */
  watchers?: WatcherEntry[];
}
