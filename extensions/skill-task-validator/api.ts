// Public API barrel for @openclaw/skill-task-validator.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { validateTaskDeliverable } from "./src/dispatch.js";
export {
  VALIDATORS,
  validateBuildTask,
  validateLiveScout,
  validateMacSelfHeal,
  validateMcpRegistration,
  validatePriorCapsule,
} from "./src/validators/index.js";
export {
  expandHome,
  inferDeliverablePaths,
  parseStartedAtMs,
  resolveCandidatePath,
  syntaxCheck,
  type SyntaxCheckResult,
} from "./src/path-infer.js";
export { resolveConfig, type TaskValidatorConfig } from "./src/config.js";
export type { DocketTask, ValidationCategory, ValidationResult, Validator } from "./src/types.js";
