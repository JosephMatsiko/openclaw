// `docket_executor` agent tool — exposes the typed surface (status, eligibility
// probe, command catalog) through openclaw's tool interface. The long-running
// daemon (claim/run/lock/sweep) lives in chuck-docket-executor.mjs invoked by
// the LaunchAgent until openclaw cron supports it (queued for v0.2).

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { COMMANDS, commandLane } from "./commands.js";
import type { DocketExecutorConfig } from "./config.js";
import { checkEligibility } from "./eligibility.js";
import { LANE_TIMEOUT_POLICY, EXECUTOR_LANE_POLICY } from "./lanes.js";
import { macHealthGateStatus } from "./mac-gate.js";
import { summarizeStatus } from "./status.js";
import { timeoutPolicyForTask } from "./timeout.js";
import type { Task } from "./types.js";

interface RawParams {
  action: "status" | "eligibility" | "timeout-policy" | "mac-gate" | "list-commands";
  task?: Record<string, unknown>;
  activeTasks?: Array<Record<string, unknown>>;
}

export function createDocketExecutorTool(_params: {
  api: OpenClawPluginApi;
  config: DocketExecutorConfig;
}) {
  const config = _params.config;
  return {
    name: "docket_executor",
    label: "Docket Executor",
    description:
      "Read-only typed surface for the chuck-v3 docket executor. 'status' returns the catalog + lane policies + mac gate + control state. 'eligibility' probes one task against allowlist + risk + mac gate + lane caps; supply optional `activeTasks` for lane-cap context. 'timeout-policy' resolves the effective timeout for a task. 'mac-gate' returns the live mac health gate. 'list-commands' returns the executor's allowlisted commandKinds. The daemon (claim/run/lock/sweep) is invoked by the LaunchAgent.",
    parameters: Type.Object({
      action: Type.String({
        enum: ["status", "eligibility", "timeout-policy", "mac-gate", "list-commands"],
      }),
      task: Type.Optional(
        Type.Object(
          {
            commandKind: Type.Optional(Type.String()),
            risk: Type.Optional(Type.String()),
            status: Type.Optional(Type.String()),
            intent: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
      activeTasks: Type.Optional(
        Type.Array(
          Type.Object(
            {
              status: Type.Optional(Type.String()),
              commandKind: Type.Optional(Type.String()),
            },
            { additionalProperties: true },
          ),
        ),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "status") {
        return jsonResult(await summarizeStatus(config));
      }
      if (raw.action === "list-commands") {
        return jsonResult({
          commands: [...COMMANDS.keys()].map((k) => ({ commandKind: k, lane: commandLane(k) })),
          lanes: Object.fromEntries(LANE_TIMEOUT_POLICY),
          runCaps: Object.fromEntries(EXECUTOR_LANE_POLICY),
          globalRunningCap: config.globalRunningCap,
        });
      }
      if (raw.action === "mac-gate") {
        return jsonResult(macHealthGateStatus(config));
      }
      if (raw.action === "timeout-policy") {
        if (!raw.task) throw new Error("timeout-policy: task is required");
        return jsonResult(timeoutPolicyForTask(raw.task as Task));
      }
      if (raw.action === "eligibility") {
        if (!raw.task) throw new Error("eligibility: task is required");
        const result = checkEligibility(raw.task as Task, {
          activeTasks: (raw.activeTasks ?? []) as Task[],
          config,
        });
        return jsonResult(result);
      }
      throw new Error(`unknown action: ${(raw as { action: string }).action}`);
    },
  };
}
