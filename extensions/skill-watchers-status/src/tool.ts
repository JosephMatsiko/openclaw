// `watchers_status` agent tool.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { WatchersConfig } from "./config.js";
import { reportWatchers } from "./report.js";

interface RawParams {
  label?: string;
  busWindowHours?: number;
}

export function createWatchersStatusTool(_params: {
  api: OpenClawPluginApi;
  config: WatchersConfig;
}) {
  const config = _params.config;
  return {
    name: "watchers_status",
    label: "Watchers Status",
    description:
      "Report health for the chuck/apex LaunchAgent surface. Per-watcher: loaded? pid? lastExitCode? uptimeMs? cpuPercent? lastBusEvent (within window)? lastLogLine? stateFile parses?. Default window: 6h. Pass label to restrict to one watcher.",
    parameters: Type.Object({
      label: Type.Optional(Type.String()),
      busWindowHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      return jsonResult({
        ok: true,
        watchers: await reportWatchers(config, {
          label: raw.label,
          busWindowHours: raw.busWindowHours,
        }),
      });
    },
  };
}
