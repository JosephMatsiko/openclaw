// Detector: zombie-cluster — >=3 chuck.zombie_recovered events in 24h.

import type { Detector, DetectorHit } from "../types.js";
import { fingerprint } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

export const detectZombieCluster: Detector = ({ events, now }): DetectorHit | null => {
  const cutoff = now.getTime() - 24 * HOUR_MS;
  const zombies = events.filter((e) => {
    if (!e?.ts || Date.parse(e.ts) < cutoff) return false;
    return e.type === "chuck.zombie_recovered" || e.type === "zombie_recovered";
  });
  if (zombies.length < 3) return null;

  const lanes = new Map<string, number>();
  for (const z of zombies) {
    const payload = (z.payload ?? {}) as Record<string, unknown>;
    const lane =
      (typeof payload.lane === "string" && payload.lane) ||
      (typeof payload.commandKind === "string" && payload.commandKind) ||
      z.source ||
      "unknown";
    lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
  }
  let dominantLane: string | null = null;
  let dominantCount = 0;
  for (const [l, c] of lanes) {
    if (c > dominantCount) {
      dominantLane = l;
      dominantCount = c;
    }
  }

  return {
    category: "zombie-cluster",
    fingerprint: fingerprint("zombie-cluster", `${dominantLane}:${zombies.length}`),
    situation: `Executor recovered ${zombies.length} zombie processes in last 24h (dominant lane: ${dominantLane}, ${dominantCount} occurrences)`,
    options: [
      {
        label: "tighten-timeout",
        action: `Reduce LANE_TIMEOUT_POLICY for lane '${dominantLane}' so child processes get killed cleanly before zombie state`,
      },
      {
        label: "investigate-exit-pattern",
        action:
          "Read recent task logs for the affected lane to find the child-process exit signal pattern",
      },
    ],
    recommendation: "investigate-exit-pattern",
    rationale: `${zombies.length} zombie recoveries means children are exiting in ways the executor doesn't reap cleanly. Investigating exit pattern first preserves diagnostic signal; tightening timeout is the corrective lever once the pattern is known.`,
    riskClass: "medium",
    evidence: { totalZombies: zombies.length, dominantLane, dominantCount, windowHours: 24 },
    rollback: `If timeout tightening is applied, restore prior LANE_TIMEOUT_POLICY value (typically 30 min) to revert.`,
  };
};
