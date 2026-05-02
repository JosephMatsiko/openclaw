// readExecutorControl — reads ~/.openclaw/.../executor-control.json. The
// executor-control file is the operator's pause/resume toggle; missing
// file = active by default; unreadable file = fail-closed (pause).

import { readFile } from "node:fs/promises";
import type { DocketExecutorConfig } from "./config.js";
import type { ExecutorControl } from "./types.js";

export async function readExecutorControl(config: DocketExecutorConfig): Promise<ExecutorControl> {
  try {
    const raw = JSON.parse(await readFile(config.executorControlPath, "utf8")) as {
      mode?: string;
      reason?: string;
      updatedAt?: string;
      updatedBy?: string;
    };
    const mode = raw?.mode === "paused" ? "paused" : "active";
    return {
      mode,
      paused: mode === "paused",
      reason: typeof raw?.reason === "string" ? raw.reason : "",
      updatedAt: raw?.updatedAt ?? null,
      updatedBy: raw?.updatedBy ?? null,
      path: config.executorControlPath,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        mode: "active",
        paused: false,
        reason: "default active; no control file",
        updatedAt: null,
        updatedBy: null,
        path: config.executorControlPath,
      };
    }
    return {
      mode: "paused",
      paused: true,
      reason: `fail-closed: executor control unreadable (${(err as Error).message})`,
      updatedAt: null,
      updatedBy: "skill-docket-executor",
      path: config.executorControlPath,
      failClosed: true,
    };
  }
}

export function executorIntakePaused(control: ExecutorControl): boolean {
  return control?.paused === true || control?.mode === "paused";
}
