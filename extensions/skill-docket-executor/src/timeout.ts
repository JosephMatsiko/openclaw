// timeoutPolicyForTask — resolves the effective spawn timeout for a task.
//
// Source priority: cli-override > task-requested (timeoutMs/requestedTimeoutMs/
// expectedTimeoutMs/estimatedTimeoutMs) > task-long-running (longRunning flag
// or timeoutClass=long, etc.) > lane-default. Always capped at the lane's
// maxMs ceiling so a wedged child cannot quietly consume the machine forever.

import { commandLane } from "./commands.js";
import { DEFAULT_TIMEOUT_MS, laneTimeoutPolicy } from "./lanes.js";
import type { ResolvedTimeoutPolicy, Task } from "./types.js";

function parseOptionalPositiveInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface TimeoutOptions {
  /** CLI-level override; wins over task-requested. */
  timeoutMs?: number | null;
}

export function timeoutPolicyForTask(
  task: Task,
  options: TimeoutOptions = {},
): ResolvedTimeoutPolicy {
  const lane = commandLane(task?.commandKind) ?? "unknown";
  const policy = laneTimeoutPolicy(
    lane === "unknown" ? null : (lane as Parameters<typeof laneTimeoutPolicy>[0]),
  );
  const taskRequestedMs = parseOptionalPositiveInt(
    task?.timeoutMs ??
      task?.requestedTimeoutMs ??
      task?.expectedTimeoutMs ??
      task?.estimatedTimeoutMs,
  );
  const longRequested =
    task?.longRunning === true ||
    task?.timeoutClass === "long" ||
    task?.expectedDuration === "long" ||
    task?.durationClass === "long";

  let source: ResolvedTimeoutPolicy["source"] = longRequested
    ? "task-long-running"
    : "lane-default";
  let requestedMs = longRequested ? policy.longMs : policy.defaultMs;
  if (Number.isFinite(options?.timeoutMs) && (options.timeoutMs as number) > 0) {
    source = "cli-override";
    requestedMs = options.timeoutMs as number;
  } else if (taskRequestedMs !== null) {
    source = "task-requested";
    requestedMs = taskRequestedMs;
  }
  const timeoutMs = Math.min(requestedMs, policy.maxMs ?? DEFAULT_TIMEOUT_MS);
  return {
    lane,
    source,
    timeoutMs,
    requestedMs,
    defaultMs: policy.defaultMs,
    longMs: policy.longMs,
    maxMs: policy.maxMs,
    capped: requestedMs > policy.maxMs,
    longRunning: longRequested,
  };
}
