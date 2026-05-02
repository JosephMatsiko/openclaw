// Per-commandKind validator registry.

import type { Validator } from "../types.js";
import { validateBuildTask } from "./build.js";
import { validateLiveScout } from "./live-scout.js";
import { validateMacSelfHeal } from "./mac-self-heal.js";
import { validateMcpRegistration } from "./mcp-registration.js";
import { validatePriorCapsule } from "./prior-capsule.js";

export const VALIDATORS: Record<string, Validator> = {
  "claude-cli-build": validateBuildTask,
  "codex-build": validateBuildTask,
  "mac-self-heal": validateMacSelfHeal,
  "live-scout": validateLiveScout,
  "prior-capsule": validatePriorCapsule,
  "mcp-registration": validateMcpRegistration,
};

export {
  validateBuildTask,
  validateLiveScout,
  validateMacSelfHeal,
  validateMcpRegistration,
  validatePriorCapsule,
};
