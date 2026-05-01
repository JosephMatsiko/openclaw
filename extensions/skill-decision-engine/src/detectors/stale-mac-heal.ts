// Detector: stale-mac-heal — mac-self-heal latest.json > 12h old or missing.

import { existsSync } from "node:fs";
import type { Detector, DetectorHit } from "../types.js";
import { fingerprint, readJson } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

interface MacHealLatest {
  updatedAt?: string;
}

export const detectStaleMacHeal: Detector = ({ config, now }): DetectorHit | null => {
  const latest = readJson<MacHealLatest | null>(config.macHealLatestPath, null);
  if (!latest?.updatedAt) {
    return {
      category: "stale-mac-heal",
      fingerprint: fingerprint("stale-mac-heal", "missing"),
      situation: "mac-self-heal/latest.json missing or unreadable",
      options: [
        {
          label: "verify-launchd",
          action: "Check launchctl list | grep mac-self-heal and run a forced sweep manually",
        },
        {
          label: "rebuild-state",
          action: "Run `chuck-mac-self-heal apply --json` once to seed latest.json",
        },
      ],
      recommendation: "verify-launchd",
      rationale: `Missing latest.json means the daemon may have never run or state is corrupt. Verify the launchd job before assuming the daemon code is broken.`,
      riskClass: "low",
      evidence: {
        latestPath: config.macHealLatestPath,
        exists: existsSync(config.macHealLatestPath),
      },
      rollback: "n/a — verification only.",
    };
  }
  const ageMs = now.getTime() - Date.parse(latest.updatedAt);
  if (ageMs <= 12 * HOUR_MS) return null;
  const ageHours = (ageMs / HOUR_MS).toFixed(1);
  return {
    category: "stale-mac-heal",
    fingerprint: fingerprint("stale-mac-heal", `age:${Math.floor(ageMs / HOUR_MS)}h`),
    situation: `mac-self-heal hasn't run in ${ageHours}h (latest update: ${latest.updatedAt})`,
    options: [
      {
        label: "verify-launchd",
        action:
          "Check `launchctl list | grep mac-self-heal` and inspect logs at ~/.openclaw/logs/chuck-mac-self-heal.{out,err}.log",
      },
      {
        label: "force-sweep",
        action:
          "Run `chuck-mac-self-heal apply --json --max-actions 24 --only-under-pressure` manually to confirm the binary still works",
      },
    ],
    recommendation: "verify-launchd",
    rationale: `Daemon scheduled every 15 min — 12h+ silence indicates launchd job is unloaded, throttled, or crashing. Verifying launchctl state is the cheap diagnostic step.`,
    riskClass: "low",
    evidence: { latestUpdatedAt: latest.updatedAt, ageHours: Number(ageHours) },
    rollback: "n/a — verification only.",
  };
};
