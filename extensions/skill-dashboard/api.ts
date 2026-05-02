// Public API barrel for @openclaw/skill-dashboard.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { checkDashboardHealth, defaultFetcher, fetchDashboardEndpoint } from "./src/client.js";
export { resolveConfig, type DashboardConfig } from "./src/config.js";
export { defaultLaunchctlRunner, readLaunchAgentStatus } from "./src/lifecycle.js";
export type {
  DashboardEndpoint,
  DashboardFetcher,
  DashboardJson,
  FetchResult,
  HealthResult,
  LaunchAgentStatus,
  LaunchctlRunner,
  QueryOptions,
  QueryResult,
  RunDeps,
} from "./src/types.js";
