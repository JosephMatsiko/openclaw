// Detector: skillgap — executor commandKind without a matching
// ~/.claude/skills/<kind>-* skill folder.
//
// EXECUTOR_COMMAND_KINDS mirrors @openclaw/skill-docket-executor's COMMANDS
// registry. Hardcoded here rather than imported because the scanner is
// LaunchAgent-invoked (the .mjs duplicate can't import .ts at runtime); when
// both migrate to openclaw cron, the import becomes available.

import { existsSync, readdirSync } from "node:fs";
import type { DetectorContext, Gap } from "../types.js";
import { fingerprint } from "../util.js";

export const EXECUTOR_COMMAND_KINDS: readonly string[] = [
  "bootstrap",
  "doctor",
  "capability-ledger",
  "docket-list",
  "prior-capsule",
  "live-scout",
  "codex-build",
  "claude-cli-build",
  "mac-self-heal",
];

export function detectSkillGap(ctx: DetectorContext): Gap[] {
  if (!existsSync(ctx.config.skillsDir)) return [];
  let skillDirs: string[];
  try {
    skillDirs = readdirSync(ctx.config.skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: Gap[] = [];
  for (const kind of EXECUTOR_COMMAND_KINDS) {
    if (skillDirs.some((d) => new RegExp(`(^|-)${kind}(-|$)`).test(d))) continue;
    const fp = fingerprint("skillgap", kind);
    if (ctx.openFps.has(fp)) continue;
    out.push({
      category: "skillgap",
      fingerprint: fp,
      title: `Author skill for commandKind '${kind}' (low priority)`,
      intent: `Executor COMMANDS map defines '${kind}' but no skill in ~/.claude/skills/ matches. Consider authoring /${kind}-failover or /${kind}-explain so a Chuck operator can invoke this commandKind interactively. Low priority — skip if rarely used outside automated paths.`,
    });
  }
  return out;
}
