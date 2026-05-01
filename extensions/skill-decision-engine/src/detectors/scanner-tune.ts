// Detector: scanner-tune — scanner-promoted tasks failing >50% (n>=5) in 7d.

import type { Detector, DetectorHit } from "../types.js";
import { fingerprint } from "../util.js";

const HOUR_MS = 60 * 60 * 1000;

export const detectScannerTune: Detector = ({ tasks, now }): DetectorHit | null => {
  const cutoff = now.getTime() - 7 * 24 * HOUR_MS;
  const scannerTasks = tasks.filter((t) => {
    if (t?.source?.kind !== "chuck-self-improvement-scanner") return false;
    if (!t.updatedAt) return false;
    return Date.parse(t.updatedAt) >= cutoff;
  });
  if (scannerTasks.length < 5) return null;
  const failed = scannerTasks.filter((t) => t.status === "failed").length;
  const rate = failed / scannerTasks.length;
  if (rate <= 0.5) return null;

  return {
    category: "scanner-tune",
    fingerprint: fingerprint("scanner-tune", `${scannerTasks.length}:${failed}`),
    situation: `Self-improvement-scanner promoted ${scannerTasks.length} tasks in 7d; ${failed} failed (${(rate * 100).toFixed(0)}%)`,
    options: [
      {
        label: "tighten-fingerprint",
        action: "Tune scanner fingerprint dedup so repeat-failure tasks aren't re-promoted",
      },
      {
        label: "raise-risk",
        action:
          "Reclassify scanner tasks from low → medium risk so they require Joseph review before claim",
      },
      {
        label: "audit-detectors",
        action:
          "Audit which detector category produces the most failures and refine its intent text",
      },
    ],
    recommendation: "audit-detectors",
    rationale: `>50% failure rate means scanner is generating malformed or impossible tasks. Auditing per-detector failure breakdown is the diagnostic step; raising-risk is throttling without fix; tightening-fingerprint hides repeat-failures without fixing root cause.`,
    riskClass: "low",
    evidence: {
      totalPromoted: scannerTasks.length,
      failed,
      rate: Number(rate.toFixed(3)),
      windowDays: 7,
    },
    rollback: `Revert any detector intent text edits via git; risk-class change is a single line in chuck-self-improvement-scanner.mjs buildTask().`,
  };
};
