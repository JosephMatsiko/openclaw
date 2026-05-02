// Public API barrel for @openclaw/skill-mac-self-heal.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { resolveConfig, type MacSelfHealConfig } from "./src/config.js";
export { defaultSubprocessRunner, runApply, runPlan, runStatus } from "./src/runner.js";
export type {
  ApplyOptions,
  PlanOptions,
  RunDeps,
  RunResult,
  SelfHealReceipt,
  StatusOptions,
  SubprocessResult,
  SubprocessRunner,
} from "./src/types.js";
