// Eligibility check — pure function over a task + the active-task set.
//
// A task is eligible iff:
//   - status is exactly "pending"
//   - risk is exactly "low"
//   - commandKind is in the COMMANDS allowlist
//   - command-required-fields satisfied (e.g. build needs intent)
//   - mac health gate clear (or commandKind is exempt)
//   - global running cap not reached
//   - lane running cap not reached
//
// Returns the list of blockers; empty list = eligible.

import { COMMANDS, commandHasRequiredFields, commandLane } from "./commands.js";
import type { DocketExecutorConfig } from "./config.js";
import { laneRunPolicy } from "./lanes.js";
import { macHealthGateBlockers } from "./mac-gate.js";
import type { EligibilityCheck, Task } from "./types.js";

function taskStatus(task: Task | undefined | null): string {
  return String(task?.status ?? "").toLowerCase();
}

function runningTasks(activeTasks: Task[]): Task[] {
  return activeTasks.filter((t) => taskStatus(t) === "running");
}

export interface EligibilityContext {
  /** Other tasks in the docket; needed for lane + global running-cap checks. */
  activeTasks?: Task[];
  config: DocketExecutorConfig;
}

export function eligibilityBlockers(task: Task, ctx: EligibilityContext): string[] {
  const blockers: string[] = [];
  const commandKind = typeof task?.commandKind === "string" ? task.commandKind : "";
  const lane = commandLane(commandKind);

  if (taskStatus(task) !== "pending") blockers.push("status is not pending");
  if (task?.risk !== "low") blockers.push("risk is not low");
  if (!COMMANDS.has(commandKind as Parameters<typeof COMMANDS.get>[0])) {
    blockers.push("commandKind is not executor-allowlisted");
  }
  if (
    COMMANDS.has(commandKind as Parameters<typeof COMMANDS.get>[0]) &&
    !commandHasRequiredFields(task)
  ) {
    blockers.push(`${commandKind} is missing required fields`);
  }
  if (COMMANDS.has(commandKind as Parameters<typeof COMMANDS.get>[0])) {
    blockers.push(...macHealthGateBlockers(task, ctx.config));
  }

  const activeTasks = ctx.activeTasks ?? [];
  if (lane && activeTasks.length > 0) {
    const running = runningTasks(activeTasks);
    const runPolicy = laneRunPolicy(lane);
    const laneRunning = running.filter((t) => commandLane(t.commandKind) === lane);
    if (running.length >= ctx.config.globalRunningCap) {
      blockers.push(`global running cap ${ctx.config.globalRunningCap} reached`);
    }
    if (runPolicy && laneRunning.length >= runPolicy.maxRunning) {
      blockers.push(`lane ${lane} running cap ${runPolicy.maxRunning} reached`);
    }
  }
  return blockers;
}

export function checkEligibility(task: Task, ctx: EligibilityContext): EligibilityCheck {
  const blockers = eligibilityBlockers(task, ctx);
  return { eligible: blockers.length === 0, blockers };
}
