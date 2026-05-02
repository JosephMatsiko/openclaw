// validateMacSelfHeal — verifies that mac-self-heal/latest.json (or a
// receipt under mac-self-heal/receipts/) was written during the task window.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStartedAtMs } from "../path-infer.js";
import type { Validator } from "../types.js";

export const validateMacSelfHeal: Validator = (task, config) => {
  const startedAtMs = parseStartedAtMs(task);
  if (!existsSync(config.macHealLatestPath)) {
    return {
      valid: false,
      reason: `mac-self-heal latest.json missing at ${config.macHealLatestPath}`,
      category: "missing-state",
      evidence: { latestPath: config.macHealLatestPath },
    };
  }
  const latestStat = statSync(config.macHealLatestPath);
  if (startedAtMs && latestStat.mtimeMs < startedAtMs) {
    if (existsSync(config.macHealReceiptsDir)) {
      const receipts = readdirSync(config.macHealReceiptsDir).filter((f) => f.endsWith(".json"));
      const fresh = receipts.find((f) => {
        try {
          return statSync(join(config.macHealReceiptsDir, f)).mtimeMs >= startedAtMs;
        } catch {
          return false;
        }
      });
      if (fresh) {
        return {
          valid: true,
          reason: `mac-self-heal receipt '${fresh}' written during task window`,
          category: "fresh-receipt",
          evidence: { receipt: fresh },
        };
      }
    }
    return {
      valid: false,
      reason: `no fresh mac-self-heal receipt written during task window (latest.json mtime ${new Date(latestStat.mtimeMs).toISOString()} < startedAt ${new Date(startedAtMs).toISOString()})`,
      category: "stale-state",
      evidence: { latestMtimeMs: latestStat.mtimeMs, startedAtMs },
    };
  }
  return {
    valid: true,
    reason: "mac-self-heal latest.json updated during task window",
    category: "fresh-state",
    evidence: { latestMtimeMs: latestStat.mtimeMs },
  };
};
