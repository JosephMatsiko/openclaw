// `gateway_watchdog` agent tool — exposes probe/tick/status through openclaw's
// tool surface. The polling daemon stays out of the tool layer (it lives in
// chuck-gateway-watchdog.mjs invoked by the LaunchAgent).

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { GatewayWatchdogConfig } from "./config.js";
import { probe } from "./probe.js";
import { summarizeStatus } from "./status.js";
import { tick } from "./tick.js";

interface RawParams {
  action: "probe" | "status" | "tick";
  dryRun?: boolean;
}

export function createGatewayWatchdogTool(_params: {
  api: OpenClawPluginApi;
  config: GatewayWatchdogConfig;
}) {
  const config = _params.config;
  return {
    name: "gateway_watchdog",
    label: "Gateway Watchdog",
    description:
      "Auto-restart the openclaw gateway when its event loop pins. 'probe' returns the current health verdict (pid/cpu/eventLoopBlocks/healthy). 'status' returns persisted state (restart counts, history tail, config). 'tick' runs one watchdog iteration: probe → restart if pinned (with backoff + day cap). Use --dryRun to skip the launchctl kickstart.",
    parameters: Type.Object({
      action: Type.String({ enum: ["probe", "status", "tick"] }),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "probe") return jsonResult(probe(config));
      if (raw.action === "status") return jsonResult(summarizeStatus(config));
      if (raw.action === "tick")
        return jsonResult(await tick({ dryRun: raw.dryRun === true }, config));
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
