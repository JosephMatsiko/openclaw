// Auto-apply: drop a follow-on docket task that picks up the recommended
// action. This is the only mutating side-effect the decision engine performs
// on its own; everything else stages a proposal for Joseph.

import { join } from "node:path";
import type { DecisionEngineConfig } from "./config.js";
import type { Proposal } from "./types.js";
import { ensureDir, writeJson } from "./util.js";

export function dropFollowupDocketTask(
  decision: Proposal,
  config: DecisionEngineConfig,
): { taskId: string; action: string } {
  ensureDir(config.docketDir);
  const ts = Date.now();
  const taskId = `task-decision-${ts}`;
  const nowIso = new Date(ts).toISOString();
  const recOption = decision.options.find((o) => o.label === decision.recommendation);
  const intent = `Decision-engine auto-promotion. Situation: ${decision.situation}. Recommended action: ${recOption?.action ?? decision.recommendation}. Rationale: ${decision.rationale}. Rollback: ${decision.rollback}. Decision id: ${decision.id}.`;
  const task = {
    id: taskId,
    title: `Decision-engine: ${decision.situation.slice(0, 80)}`,
    status: "pending",
    risk: "low",
    commandKind: "claude-cli-build",
    surface: "chuck-cockpit",
    intent,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: "skill-decision-engine",
    source: {
      kind: "skill-decision-engine",
      category: decision.category,
      fingerprint: decision.fingerprint,
      decisionId: decision.id,
    },
    heartbeats: [
      { at: nowIso, phase: "pending", message: "Auto-promoted by skill-decision-engine" },
    ],
  };
  writeJson(join(config.docketDir, `${taskId}.json`), task);
  return { taskId, action: `dropped docket task ${taskId}` };
}
