// Public API barrel for @openclaw/skill-prior-capsule.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { resolveConfig, type PriorCapsuleConfig } from "./src/config.js";
export { defaultSubprocessRunner, runBuildPriorCapsule } from "./src/runner.js";
export type {
  BuildOptions,
  BuildResult,
  PriorCapsuleReceipt,
  PriorCapsuleSummary,
  RunDeps,
  SubprocessResult,
  SubprocessRunner,
} from "./src/types.js";
