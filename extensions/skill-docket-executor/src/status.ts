// summarizeStatus — fast read-only snapshot of the executor's typed surface:
// command catalog, lane policies, mac gate, executor control state.

import { listCommandKinds } from "./commands.js";
import type { DocketExecutorConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { executorIntakePaused, readExecutorControl } from "./control.js";
import { EXECUTOR_LANE_POLICY, LANE_TIMEOUT_POLICY } from "./lanes.js";
import { macHealthGateStatus, MAC_GATE_EXEMPT_COMMAND_KINDS } from "./mac-gate.js";
import type { ExecutorControl, Lane } from "./types.js";

export interface ExecutorStatusSummary {
  commands: Array<{ commandKind: string; lane: string }>;
  lanes: Record<
    string,
    {
      timeout: { defaultMs: number; longMs: number; maxMs: number };
      runCap: { maxRunning: number; description: string } | null;
    }
  >;
  macGateExempt: string[];
  globalRunningCap: number;
  control: ExecutorControl;
  intakePaused: boolean;
  macHealth: {
    state: "clear" | "blocked";
    blockers: string[];
    signals: Array<{ category: string; severity: string; summary: string }>;
  };
}

export async function summarizeStatus(
  configIn?: DocketExecutorConfig,
): Promise<ExecutorStatusSummary> {
  const config = configIn ?? resolveConfig({});
  const control = await readExecutorControl(config);
  const mac = macHealthGateStatus(config);
  const lanes: ExecutorStatusSummary["lanes"] = {};
  for (const [lane, policy] of LANE_TIMEOUT_POLICY) {
    lanes[lane] = {
      timeout: { defaultMs: policy.defaultMs, longMs: policy.longMs, maxMs: policy.maxMs },
      runCap: EXECUTOR_LANE_POLICY.get(lane as Lane) ?? null,
    };
  }
  return {
    commands: listCommandKinds().map((commandKind) => ({
      commandKind,
      lane: EXECUTOR_LANE_POLICY.has(
        (Array.from(LANE_TIMEOUT_POLICY.keys()).find(
          (l) => l === lookupLaneByCommand(commandKind),
        ) ?? "unknown") as Lane,
      )
        ? (lookupLaneByCommand(commandKind) ?? "unknown")
        : "unknown",
    })),
    lanes,
    macGateExempt: [...MAC_GATE_EXEMPT_COMMAND_KINDS],
    globalRunningCap: config.globalRunningCap,
    control,
    intakePaused: executorIntakePaused(control),
    macHealth: {
      state: mac.state,
      blockers: mac.blockers,
      signals: mac.signals.map((s) => ({
        category: s.category,
        severity: s.severity,
        summary: s.summary,
      })),
    },
  };
}

function lookupLaneByCommand(commandKind: string): string | null {
  // Local import to avoid circular: commandLane is in commands.ts.
  // Inlined for clarity since this helper is called only once.
  const lookup = require("./commands.js") as { commandLane(k: string): string | null };
  return lookup.commandLane(commandKind);
}
