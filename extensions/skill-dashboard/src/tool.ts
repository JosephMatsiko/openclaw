// `dashboard` agent tool — actions: query | health | status.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { checkDashboardHealth, fetchDashboardEndpoint } from "./client.js";
import type { DashboardConfig } from "./config.js";
import { readLaunchAgentStatus } from "./lifecycle.js";

interface RawParams {
  action: "query" | "health" | "status";
  path?: string;
  search?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}

export function createDashboardTool(_params: { api: OpenClawPluginApi; config: DashboardConfig }) {
  const config = _params.config;
  return {
    name: "dashboard",
    label: "Dashboard",
    description:
      "Typed HTTP client for the chuck-dashboard.mjs cockpit (localhost:7777). Read-only. Actions: 'query' (GET any /api path with optional search params + timeoutMs override), 'health' (liveness probe via /api/snapshot), 'status' (LaunchAgent state via launchctl list). Never starts / stops / restarts the daemon.",
    parameters: Type.Object({
      action: Type.String({ enum: ["query", "health", "status"] }),
      path: Type.Optional(Type.String()),
      search: Type.Optional(Type.Record(Type.String(), Type.Any())),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 500, maximum: 60_000 })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "query") {
        if (!raw.path) throw new Error("query: path is required");
        return jsonResult(
          await fetchDashboardEndpoint(config, {
            path: raw.path,
            search: raw.search,
            timeoutMs: raw.timeoutMs,
          }),
        );
      }
      if (raw.action === "health") {
        return jsonResult(await checkDashboardHealth(config));
      }
      if (raw.action === "status") {
        return jsonResult(await readLaunchAgentStatus(config));
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
