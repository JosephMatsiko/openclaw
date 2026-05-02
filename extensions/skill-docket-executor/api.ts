// Public API barrel for @openclaw/skill-docket-executor.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export {
  COMMANDS,
  commandHasRequiredFields,
  commandLane,
  listCommandKinds,
} from "./src/commands.js";
export {
  DEFAULT_TIMEOUT_MS,
  EXECUTOR_LANE_POLICY,
  LANE_TIMEOUT_POLICY,
  laneRunPolicy,
  laneTimeoutPolicy,
} from "./src/lanes.js";
export {
  clearMacGateCache,
  macHealthGateBlockers,
  macHealthGateStatus,
  MAC_GATE_EXEMPT_COMMAND_KINDS,
} from "./src/mac-gate.js";
export { executorIntakePaused, readExecutorControl } from "./src/control.js";
export { checkEligibility, eligibilityBlockers } from "./src/eligibility.js";
export { timeoutPolicyForTask } from "./src/timeout.js";
export { summarizeStatus, type ExecutorStatusSummary } from "./src/status.js";
export { buildExecutorEnv } from "./src/env.js";
export { resolveConfig, type DocketExecutorConfig } from "./src/config.js";
export type {
  CommandDescriptor,
  CommandKind,
  CommandSpec,
  DiskStatus,
  EligibilityCheck,
  ExecutorControl,
  Lane,
  LaneRunPolicy,
  LaneTimeoutPolicy,
  MacHealthGateStatus,
  ResolvedTimeoutPolicy,
  Risk,
  SwapStatus,
  Task,
  TaskStatus,
} from "./src/types.js";
