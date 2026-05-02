// `industry_radar` agent tool — exposes scan/status through openclaw's tool
// surface. The .mjs CLI was invoked manually or via cron; the plugin's
// tool is for in-conversation probes / dry-runs / status checks.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { IndustryRadarConfig } from "./config.js";
import { runScan, summarizeStatus } from "./scan.js";

interface RawParams {
  action: "scan" | "status";
  dryRun?: boolean;
}

export function createIndustryRadarTool(_params: {
  api: OpenClawPluginApi;
  config: IndustryRadarConfig;
}) {
  const config = _params.config;
  return {
    name: "industry_radar",
    label: "Industry Radar",
    description:
      "Per-commit watcher for upstream source repos. 'scan' fetches commits since the last scan, scores them by architectural relevance, emits chuck.industry.radar.* bus events, writes daily digest markdown + raw aggregation. 'status' returns last-scan state. Sources config at <stateDir>/sources.json.",
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
