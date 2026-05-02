// Public API barrel for @openclaw/skill-watchers-status.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { resolveConfig, type WatchersConfig } from "./src/config.js";
export { DEFAULT_WATCHERS } from "./src/registry.js";
export { reportWatchers } from "./src/report.js";
export { defaultLaunchctlRunner, defaultPsRunner } from "./src/runners.js";
export type {
  LaunchctlRunner,
  PsRunner,
  ReportOptions,
  RunDeps,
  WatcherEntry,
  WatcherReport,
} from "./src/types.js";
