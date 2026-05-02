// COMMANDS registry — the executor's allowlist. Tasks whose commandKind
// is NOT in this map are blocked by the eligibility check (so a malicious
// or misformatted task can't land arbitrary spawns).
//
// Each entry's `build(task)` returns the {executable, args} pair the
// daemon hands to spawn(). Args are interpreted relative to the repo root
// (the daemon sets cwd=REPO_ROOT for spawn).

import { homedir } from "node:os";
import type { CommandDescriptor, CommandKind, Task } from "./types.js";

const HOME = homedir();

function parseOptionalPositiveInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function includeProvisionalArgs(task: Task | undefined): string[] {
  return task?.includeProvisional === true ? ["--include-provisional"] : [];
}

function onlySurfaceArgs(task: Task | undefined): string[] {
  if (typeof task?.onlySurface === "string" && task.onlySurface.trim().length > 0) {
    return ["--only-surface", task.onlySurface.trim()];
  }
  return [];
}

function taskIntentWithPrior(task: Task | undefined): string {
  return task?.intent ?? "no intent provided";
}

export const COMMANDS: ReadonlyMap<CommandKind, CommandDescriptor> = new Map<
  CommandKind,
  CommandDescriptor
>([
  [
    "bootstrap",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: ["extensions/memory-graph/scripts/apex-session-bootstrap.mjs", "--json"],
      }),
    },
  ],
  [
    "doctor",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--doctor",
          "--json",
          "--no-persist",
        ],
      }),
    },
  ],
  [
    "capability-ledger",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--capability-ledger",
          "--json",
        ],
      }),
    },
  ],
  [
    "docket-list",
    {
      lane: "diagnostic",
      build: () => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--docket",
          "--json",
        ],
      }),
    },
  ],
  [
    "prior-capsule",
    {
      lane: "memory",
      build: (task) => ({
        executable: process.execPath,
        args: [
          "extensions/memory-graph/scripts/chuck-prior-capsule.mjs",
          "--write",
          "--markdown",
          "--json",
          ...(task?.sourceTaskPath ? ["--source-task", task.sourceTaskPath] : []),
        ],
      }),
    },
  ],
  [
    "live-scout",
    {
      lane: "scout",
      build: (task) => ({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "extensions/memory-graph/scripts/chuck-v2-run.ts",
          "--live-scout",
          "--json",
          "--no-auto-deepen",
          ...includeProvisionalArgs(task),
          ...onlySurfaceArgs(task),
          taskIntentWithPrior(task),
        ],
      }),
    },
  ],
  [
    "codex-build",
    {
      lane: "build",
      build: (task) => ({
        executable: `${HOME}/.openclaw/bin/codex`,
        args: [
          "exec",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
          `${HOME}/Projects/openclaw`,
          task?.intent ?? "no intent provided",
        ],
      }),
    },
  ],
  [
    "claude-cli-build",
    {
      lane: "build",
      build: (task) => ({
        executable: "claude",
        args: [
          "-p",
          "--model",
          "opus",
          "--permission-mode",
          "bypassPermissions",
          task?.intent ?? "no intent provided",
        ],
      }),
    },
  ],
  [
    "mac-self-heal",
    {
      lane: "maintenance",
      build: (task) => ({
        executable: process.execPath,
        args: [
          "extensions/memory-graph/scripts/chuck-mac-self-heal.mjs",
          "apply",
          "--json",
          "--max-actions",
          String(parseOptionalPositiveInt(task?.maxActions) ?? 24),
          ...(typeof task?.cloudTarget === "string" && task.cloudTarget.trim()
            ? ["--cloud-target", task.cloudTarget.trim()]
            : []),
        ],
      }),
    },
  ],
]);

export function commandLane(commandKind: string | undefined): string | null {
  if (!commandKind) return null;
  return COMMANDS.get(commandKind as CommandKind)?.lane ?? null;
}

export function listCommandKinds(): CommandKind[] {
  return [...COMMANDS.keys()];
}

export function commandHasRequiredFields(task: Task): boolean {
  // build-lane commands require an `intent` string.
  if (task?.commandKind === "codex-build" || task?.commandKind === "claude-cli-build") {
    return typeof task?.intent === "string" && task.intent.trim().length > 0;
  }
  return true;
}
