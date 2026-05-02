// `cascade_watcher` agent tool — exposes status + test through openclaw's
// tool surface. The polling daemon stays out of the tool surface (it lives
// in chuck-cascade-watcher.mjs invoked by LaunchAgent until openclaw cron
// supports long-running plugin daemons).

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { CascadeWatcherConfig } from "./config.js";
import { runTest, summarizeStatus } from "./run.js";

interface RawParams {
  action: "status" | "test";
  eventType?: string;
  severity?: string;
  riskClass?: string;
  dryRun?: boolean;
}

export function createCascadeWatcherTool(_params: {
  api: OpenClawPluginApi;
  config: CascadeWatcherConfig;
}) {
  const config = _params.config;
  return {
    name: "cascade_watcher",
    label: "Cascade Watcher",
    description:
      "Bus-tail comms-cascade trigger. 'status' returns recent matches/fires/suppressions/promotions plus the trigger table; 'test <eventType>' synthesizes an event and verifies the trigger + (optionally) fires the cascade. Use --dryRun to skip the live cascade.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "test"] }),
      eventType: Type.Optional(Type.String()),
      severity: Type.Optional(Type.String({ enum: ["info", "warn", "critical"] })),
      riskClass: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "status") {
        return jsonResult(summarizeStatus(config));
      }
      if (raw.action === "test") {
        if (!raw.eventType) throw new Error("test: eventType is required");
        const result = await runTest(
          raw.eventType,
          {
            severity: raw.severity,
            riskClass: raw.riskClass,
            dryRun: raw.dryRun === true,
          },
          config,
        );
        return jsonResult(result);
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
