// validateLiveScout — verifies that a scout receipt was written during
// the task window.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStartedAtMs } from "../path-infer.js";
import type { Validator } from "../types.js";

export const validateLiveScout: Validator = (task, config) => {
  if (!existsSync(config.scoutsDir)) {
    return {
      valid: true,
      reason: "scout receipt directory not found; trusting exit code",
      category: "no-receipt-dir",
      evidence: { scoutsDir: config.scoutsDir },
    };
  }
  const startedAtMs = parseStartedAtMs(task);
  const receipts = readdirSync(config.scoutsDir).filter((f) => f.endsWith(".json"));
  if (receipts.length === 0) {
    return {
      valid: false,
      reason: "scouts dir exists but has zero receipts after task completion",
      category: "empty-receipts",
      evidence: { scoutsDir: config.scoutsDir },
    };
  }
  const fresh = receipts.find((f) => {
    try {
      return statSync(join(config.scoutsDir, f)).mtimeMs >= (startedAtMs ?? 0);
    } catch {
      return false;
    }
  });
  if (!fresh) {
    return {
      valid: false,
      reason: "no scout receipt written during task window",
      category: "stale-receipts",
      evidence: { scoutsDir: config.scoutsDir, startedAtMs },
    };
  }
  return {
    valid: true,
    reason: `fresh scout receipt '${fresh}' present`,
    category: "fresh-receipt",
    evidence: { receipt: fresh },
  };
};
