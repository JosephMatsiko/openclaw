// `decision_engine` agent tool — exposes scan/status/apply/reject through
// openclaw's tool surface.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { DecisionEngineConfig } from "./config.js";
import { runScan } from "./scan.js";
import { applyDecision, rejectDecision, summarizeStatus } from "./status.js";

interface RawParams {
  action: "scan" | "status" | "apply" | "reject";
  dryRun?: boolean;
  decisionId?: string;
  reason?: string;
}

export function createDecisionEngineTool(_params: {
  api: OpenClawPluginApi;
  config: DecisionEngineConfig;
}) {
  const config = _params.config;
  return {
    name: "decision_engine",
    label: "Decision Engine",
    description:
      "Detect → decide → propose. 'scan' runs all 6 detectors (failed-task-cluster, zombie-cluster, channel-drift, scanner-tune, orphan-mcp, stale-mac-heal) and stages proposals + auto-applies low-risk docket promotions. 'status' lists open proposals. 'apply <decisionId>' actions a proposal manually; 'reject <decisionId>' marks it rejected with optional reason.",
    parameters: Type.Object({
      action: Type.String({ enum: ["scan", "status", "apply", "reject"] }),
      dryRun: Type.Optional(Type.Boolean()),
      decisionId: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "scan") {
        const summary = await runScan({ dryRun: raw.dryRun === true }, config);
        return jsonResult(summary);
      }
      if (raw.action === "status") {
        return jsonResult(summarizeStatus(config));
      }
      if (raw.action === "apply") {
        if (!raw.decisionId) throw new Error("apply: decisionId is required");
        return jsonResult(applyDecision(raw.decisionId, config));
      }
      if (raw.action === "reject") {
        if (!raw.decisionId) throw new Error("reject: decisionId is required");
        return jsonResult(rejectDecision(raw.decisionId, raw.reason ?? null, config));
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
