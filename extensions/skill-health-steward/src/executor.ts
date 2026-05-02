// Executor control read/write — backs the chuck-v3 executor pause toggle.

import type { HealthStewardConfig } from "./config.js";
import type { ExecutorControl } from "./types.js";
import { readJsonSafe, writeJsonAtomic } from "./util.js";

export function readExecutorControl(config: HealthStewardConfig): ExecutorControl {
  const control = readJsonSafe<{
    mode?: string;
    reason?: string;
    updatedAt?: string;
    updatedBy?: string;
  } | null>(config.executorControlPath, null);
  if (!control) {
    return {
      mode: "active",
      paused: false,
      reason: "default active; no control file",
      path: config.executorControlPath,
    };
  }
  const mode = control.mode === "paused" ? "paused" : "active";
  return {
    mode,
    paused: mode === "paused",
    reason: String(control.reason ?? ""),
    updatedAt: control.updatedAt ?? null,
    updatedBy: control.updatedBy ?? null,
    path: config.executorControlPath,
  };
}

export function writeExecutorControl(
  config: HealthStewardConfig,
  opts: { mode: "active" | "paused"; reason: string; updatedBy?: string },
): ExecutorControl {
  const normalizedMode = opts.mode === "paused" ? "paused" : "active";
  const control: ExecutorControl = {
    mode: normalizedMode,
    paused: normalizedMode === "paused",
    reason: opts.reason,
    updatedAt: new Date().toISOString(),
    updatedBy: opts.updatedBy ?? "health-steward",
    path: config.executorControlPath,
  };
  writeJsonAtomic(config.executorControlPath, control);
  return control;
}
