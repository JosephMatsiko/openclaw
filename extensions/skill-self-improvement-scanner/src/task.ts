// buildTask + writeTask — builder writes the docket task envelope a
// scanner gap promotes into. Mirrors chuck-self-improvement-scanner.mjs's
// task shape exactly so chuck-docket-executor's consumer side stays happy.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SelfImprovementScannerConfig } from "./config.js";
import type { DocketTask, Gap } from "./types.js";
import { SCANNER_KIND } from "./util.js";

export function buildTask(gap: Gap, nowMs: number): DocketTask {
  const id = `task-selfimprov-${nowMs}`;
  const nowIso = new Date(nowMs).toISOString();
  const task: DocketTask = {
    id,
    title: gap.title,
    status: "pending",
    risk: "low",
    commandKind: "claude-cli-build",
    surface: "chuck-cockpit",
    intent: gap.intent,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: SCANNER_KIND,
    source: {
      kind: SCANNER_KIND,
      category: gap.category,
      fingerprint: gap.fingerprint,
    },
    heartbeats: [
      {
        at: nowIso,
        phase: "pending",
        message: `Auto-promoted by ${SCANNER_KIND}: ${gap.title}`,
      },
    ],
  };
  // Detector-supplied explicit deliverable wins over validator's intent-text
  // inference. mcpgap sets this to the config files being modified — without
  // it, the validator guesses the source .mjs script and false-fails.
  if (gap.deliverable && typeof gap.deliverable === "object") {
    task.deliverable = gap.deliverable;
  }
  return task;
}

export function writeTask(task: DocketTask, config: SelfImprovementScannerConfig): string {
  if (!existsSync(config.docketDir)) mkdirSync(config.docketDir, { recursive: true });
  const path = join(config.docketDir, `${task.id}.json`);
  writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  return path;
}
