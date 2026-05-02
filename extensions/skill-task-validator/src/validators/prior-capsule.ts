// validatePriorCapsule — verifies that priors/latest.json was updated
// during the task window.

import { existsSync, statSync } from "node:fs";
import { parseStartedAtMs } from "../path-infer.js";
import type { Validator } from "../types.js";

export const validatePriorCapsule: Validator = (task, config) => {
  if (!existsSync(config.priorsLatestPath)) {
    return {
      valid: false,
      reason: `prior capsule latest.json missing at ${config.priorsLatestPath}`,
      category: "missing-state",
      evidence: { path: config.priorsLatestPath },
    };
  }
  const startedAtMs = parseStartedAtMs(task);
  const st = statSync(config.priorsLatestPath);
  if (startedAtMs && st.mtimeMs < startedAtMs) {
    return {
      valid: false,
      reason: `prior capsule latest.json mtime ${new Date(st.mtimeMs).toISOString()} predates task startedAt ${new Date(startedAtMs).toISOString()}`,
      category: "stale-state",
      evidence: { mtimeMs: st.mtimeMs, startedAtMs },
    };
  }
  return {
    valid: true,
    reason: "prior capsule latest.json updated during task window",
    category: "fresh-state",
    evidence: { mtimeMs: st.mtimeMs },
  };
};
