// `self_improvement_scanner` agent tool — exposes scan/status through
// openclaw's tool surface. The LaunchAgent invokes the .mjs daemon every
// 6h; the tool here is for in-conversation probes / dry-runs.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { SelfImprovementScannerConfig } from "./config.js";
import { runScan } from "./scan.js";
import { summarizeStatus } from "./status.js";

interface RawParams {
  action: "scan" | "status";
  dryRun?: boolean;
}

export function createSelfImprovementScannerTool(_params: {
  api: OpenClawPluginApi;
  config: SelfImprovementScannerConfig;
}) {
  const config = _params.config;
  return {
    name: "self_improvement_scanner",
    label: "Self-Improvement Scanner",
    description:
      "Scan Chuck's state for gaps and drop docket tasks to fix them. Six gap categories: dockethealth, stuckpending, mcpgap, plistgap, skillgap, busdiversity. 'scan' runs a full scan (with optional --dryRun); 'status' lists open scanner-promoted tasks per category + last-scan timestamp.",
    parameters: Type.Object({
      action: Type.String({ enum: ["scan", "status"] }),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "scan") {
        return jsonResult(await runScan({ dryRun: raw.dryRun === true }, config));
      }
      if (raw.action === "status") {
        return jsonResult(summarizeStatus(config));
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
