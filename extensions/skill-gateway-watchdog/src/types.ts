// Public types for @openclaw/skill-gateway-watchdog.

export interface EventLoopBlocks {
  count: number;
  maxBlockMs: number;
  lastTs: string | null;
}

export interface ProbeResult {
  pid: number | null;
  cpu: number | null;
  eventLoopBlocks: EventLoopBlocks;
  healthy: boolean;
  reason: string;
}

export interface RestartResult {
  ok: boolean;
  durationMs: number;
  error?: string | null;
  dryRun?: boolean;
}

export interface HistoryEntry {
  ts: string;
  pid: number | null;
  cpu: number | null;
  eventLoopBlocks: EventLoopBlocks;
  healthy: boolean;
  reason: string;
  action: string | null;
  restart?: RestartResult;
}

export interface WatchdogState {
  startedAt: string | null;
  lastProbe: { ts: string } & ProbeResult;
  history: HistoryEntry[];
  restartCount: number;
  restartCountToday: number;
  todayKey: string;
  nextRestartAllowedMs: number;
  consecutiveRestartFailures: number;
}

export type TickAction =
  | "healthy"
  | "deferred-cooldown"
  | "daily-cap-hit"
  | "restarted"
  | "restart-failed";

export interface TickResult {
  action: TickAction;
  probe: ProbeResult;
  restart?: RestartResult;
  nextAllowedAt?: string;
}
